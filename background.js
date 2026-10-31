/* VietWeb AI — service worker. No network traffic except to the configured LLM endpoint. */
importScripts('shared.js');

const DB_NAME = 'vietweb-translation-cache';
const STORE_NAME = 'translations';
const CACHE_VERSION = 3;
let dbPromise = null;
let cacheWrites = 0;
const pendingKeys = new Map();

/* ---------- settings / endpoint ---------- */
async function settings() {
  const v = await chrome.storage.local.get(VIWEB_DEFAULTS);
  return {...VIWEB_DEFAULTS, ...v};
}
function validateEndpoint(base) {
  const u = new URL(base.trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Endpoint phải là HTTP hoặc HTTPS.');
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error('Không gửi API Key qua HTTP tới máy chủ bên ngoài. Hãy dùng HTTPS.');
  }
  u.hash = ''; u.search = '';
  u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname.endsWith('/chat/completions')) u.pathname += '/chat/completions';
  return u.toString();
}
function authHeaders(conf) {
  return {'Content-Type': 'application/json', ...(conf.apiKey ? {'Authorization': `Bearer ${conf.apiKey}`} : {})};
}
function modelList(conf) {
  const list = [String(conf.model || '').trim(), ...String(conf.fallbackModels || '').split(/[\n,;]/).map(x => x.trim())];
  return [...new Set(list.filter(Boolean))];
}

/* ---------- metrics (kept in storage.session so they never trigger settings resync) ---------- */
const metrics = {since: Date.now(), requests: 0, ok: 0, failed: 0, retries: 0, rateLimited: 0, tokensIn: 0,
  tokensOut: 0, cacheHits: 0, cacheMisses: 0, missing: 0, fallbacks: 0, cancelled: 0, latencies: []};
let metricsSaveTimer = null;
const metricsReady = (async () => {
  try {
    const stored = await chrome.storage.session?.get('metrics');
    if (stored?.metrics) Object.assign(metrics, stored.metrics);
  } catch { /* metrics are best-effort */ }
})();
function touchMetrics() {
  if (metricsSaveTimer) return;
  metricsSaveTimer = setTimeout(() => {
    metricsSaveTimer = null;
    try { Promise.resolve(chrome.storage.session?.set({metrics})).catch(() => {}); } catch {}
  }, 2000);
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function metricsSummary() {
  const {latencies, ...rest} = metrics;
  const lookups = metrics.cacheHits + metrics.cacheMisses;
  return {...rest, samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
    hitRate: lookups ? metrics.cacheHits / lookups : null, concurrency: sched.limit, ceiling: sched.ceiling};
}
function resetMetrics() {
  Object.assign(metrics, {since: Date.now(), requests: 0, ok: 0, failed: 0, retries: 0, rateLimited: 0,
    tokensIn: 0, tokensOut: 0, cacheHits: 0, cacheMisses: 0, missing: 0, fallbacks: 0, cancelled: 0, latencies: []});
  touchMetrics();
}

/* ---------- IndexedDB cache ---------- */
async function hashString(str) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
function openDB() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE_NAME, {keyPath: 'key'});
      store.createIndex('at', 'at', {unique: false});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}
async function cacheGet(key) {
  try {
    const db = await openDB();
    const entry = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return null;
    // Refresh the timestamp occasionally so trimming is LRU rather than FIFO.
    if (Date.now() - entry.at > 3600e3) {
      try { db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({...entry, at: Date.now()}); } catch {}
    }
    return entry.value ?? null;
  } catch { return null; } // cache failure never prevents translation
}
async function cachePut(key, value, limit) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({key, value, at: Date.now()});
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    cacheWrites++;
    if (cacheWrites % 100 === 0) await trimCache(limit);
  } catch { /* tolerate quota / disabled storage */ }
}
async function trimCache(limit) {
  const db = await openDB();
  const target = Math.max(200, Math.min(10000, Number(limit) || 2500));
  const count = await new Promise((resolve, reject) => {
    const r = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count();
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  if (count <= target) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).index('at').openCursor();
    let remaining = count - target;
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && remaining-- > 0) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

/* ---------- scheduler: global concurrency with AIMD back-off on HTTP 429 ---------- */
const sched = {running: 0, queue: [], limit: 0, ceiling: 0, streak: 0, pauseUntil: 0, timer: null};
function configureConcurrency(ceiling) {
  if (ceiling === sched.ceiling) return;
  sched.ceiling = ceiling; sched.limit = ceiling;
}
// Lower priority number runs first: viewport batches (0) overtake prefetch batches (1).
function schedule(owner, callback, priority = 1) {
  return new Promise((resolve, reject) => {
    const waiter = {owner, reject, priority, job: async () => {
      sched.running++;
      try { resolve(await callback()); } catch (e) { reject(e); }
      finally { sched.running--; pump(); }
    }};
    const at = sched.queue.findIndex(w => w.priority > priority);
    if (at < 0) sched.queue.push(waiter); else sched.queue.splice(at, 0, waiter);
    pump();
  });
}
function pump() {
  const wait = sched.pauseUntil - Date.now();
  if (wait > 0) {
    if (!sched.timer) sched.timer = setTimeout(() => { sched.timer = null; pump(); }, wait);
    return;
  }
  while (sched.queue.length && sched.running < sched.limit) sched.queue.shift().job();
}
function onSuccess() {
  if (++sched.streak >= 6 && sched.limit < sched.ceiling) { sched.limit++; sched.streak = 0; }
}
function onRateLimit(retryMs) {
  sched.limit = Math.max(1, Math.floor(sched.limit / 2));
  sched.streak = 0;
  sched.pauseUntil = Math.max(sched.pauseUntil, Date.now() + Math.min(retryMs || 1200, 20000));
}

/* ---------- cancellation of stale requests (SPA navigation, site disabled) ---------- */
const inflight = new Map();   // owner -> Set<AbortController>
const generation = new Map(); // owner -> counter
function cancelledError() { const e = new Error('Đã hủy yêu cầu cũ.'); e.cancelled = true; return e; }
function isCancelled(ctx) { return (generation.get(ctx.owner) || 0) !== ctx.gen; }
function cancelOwner(owner) {
  generation.set(owner, (generation.get(owner) || 0) + 1);
  let count = 0;
  for (const controller of inflight.get(owner) || []) { controller.cancelled = true; controller.abort(); count++; }
  const keep = [];
  for (const waiter of sched.queue) {
    if (waiter.owner === owner) { waiter.reject(cancelledError()); count++; } else keep.push(waiter);
  }
  sched.queue = keep;
  metrics.cancelled += count; touchMetrics();
}
function newContext(owner, page, meta = {}) {
  const batchId = typeof meta.batchId === 'string' ? meta.batchId.slice(0, 40) : '';
  return {owner, gen: generation.get(owner) || 0, page: cleanPage(page), batchId,
    tabId: Number.isInteger(meta.tabId) ? meta.tabId : null, frameId: Number.isInteger(meta.frameId) ? meta.frameId : 0,
    priority: meta.priority === 0 ? 0 : 1};
}
// Streamed fragments are pushed to the requesting frame as soon as the model finishes each one.
function emitPartial(ctx, items) {
  if (!ctx.batchId || ctx.tabId === null || !items.length || isCancelled(ctx)) return;
  try {
    Promise.resolve(chrome.tabs?.sendMessage(ctx.tabId, {type: 'VIWEB_PARTIAL', batchId: ctx.batchId, items}, {frameId: ctx.frameId}))
      .catch(() => {});
  } catch { /* the final response still delivers everything */ }
}
/* Incrementally extracts completed "n":"text" pairs from the model's compact JSON object. */
class StreamParser {
  constructor() { this.buf = ''; this.pos = -1; this.found = new Map(); }
  feed(text) {
    this.buf += text;
    const fresh = [];
    if (this.pos < 0) {
      const start = this.buf.indexOf('{');
      if (start < 0) return fresh;
      this.pos = start + 1;
    }
    const re = /\s*,?\s*"([^"\\]{1,32})"\s*:\s*"((?:[^"\\]|\\.)*)"/y;
    for (;;) {
      re.lastIndex = this.pos;
      const m = re.exec(this.buf);
      if (!m) break;
      this.pos = re.lastIndex;
      let value;
      try { value = JSON.parse('"' + m[2] + '"'); } catch { continue; }
      if (!this.found.has(m[1])) { this.found.set(m[1], value); fresh.push([m[1], value]); }
    }
    return fresh;
  }
}
async function readStream(resp, onDelta, touch) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', usage = null;
  const handle = line => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    if (chunk.error) throw new Error(`API: ${String(chunk.error.message || chunk.error).slice(0, 180)}`);
    if (chunk.usage) usage = chunk.usage;
    const delta = safeText(chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content);
    if (delta) { content += delta; onDelta?.(delta); }
  };
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    touch();
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handle(line);
  }
  buffer += decoder.decode();
  if (buffer) handle(buffer);
  return {choices: [{message: {content}}], usage};
}
function cleanPage(page) {
  if (!page || typeof page !== 'object') return null;
  const text = (v, n) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '';
  const clean = {kind: text(page.kind, 24), lang: text(page.lang, 16), title: text(page.title, 90)};
  return clean.kind || clean.lang || clean.title ? Object.fromEntries(Object.entries(clean).filter(([, v]) => v)) : null;
}

/* ---------- LLM call ---------- */
function safeText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(x => x?.type === 'text').map(x => x.text).join('');
  return '';
}
function malformed(message) { const e = new Error(message); e.malformed = true; return e; }
function parseResponse(raw, keys) {
  const wanted = new Set(keys);
  let str = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(str); }
  catch {
    const start = str.search(/[\[{]/);
    const end = Math.max(str.lastIndexOf(']'), str.lastIndexOf('}'));
    if (start < 0 || end <= start) throw malformed('AI không trả JSON hợp lệ.');
    try { parsed = JSON.parse(str.slice(start, end + 1)); }
    catch { throw malformed('AI không trả JSON hợp lệ.'); }
  }
  if (!Array.isArray(parsed) && Array.isArray(parsed?.translations)) parsed = parsed.translations;
  const found = new Map();
  const accept = (key, value) => {
    key = typeof key === 'number' ? String(key) : key;
    if (typeof value === 'string' && wanted.has(key) && !found.has(key)) found.set(key, value);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) accept(item?.id ?? item?.n, item?.vi ?? item?.t ?? item?.text);
  } else if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) accept(key, value && typeof value === 'object' ? value.vi : value);
  } else throw malformed('Định dạng bản dịch không hợp lệ.');
  if (!found.size) throw malformed('AI không trả ID đoạn văn hợp lệ.');
  return found;
}
function parseRetryAfter(resp) {
  const header = resp.headers?.get?.('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
const plainModels = new Set(); // endpoint|model pairs that rejected optional sampling/JSON parameters
async function post(url, body, conf, ctx, onDelta) {
  if (isCancelled(ctx)) throw cancelledError();
  const controller = new AbortController();
  controller.cancelled = false;
  if (!inflight.has(ctx.owner)) inflight.set(ctx.owner, new Set());
  inflight.get(ctx.owner).add(controller);
  // Idle timeout: re-armed on every streamed chunk, so long but healthy streams are not cut off.
  let timeout;
  const arm = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => { controller.timedOut = true; controller.abort(); }, (Number(conf.timeoutSeconds) || 45) * 1000);
  };
  arm();
  try {
    const resp = await fetch(url, {method: 'POST', signal: controller.signal, headers: authHeaders(conf), body: JSON.stringify(body)});
    if (!resp.ok) {
      let msg = '';
      try { const e = await resp.json(); msg = e.error?.message || e.message || ''; } catch {}
      const err = new Error(`API ${resp.status}${msg ? ': ' + String(msg).slice(0, 180) : ''}`);
      err.status = resp.status;
      err.retryAfter = parseRetryAfter(resp);
      throw err;
    }
    const type = resp.headers?.get?.('content-type') || '';
    if (body.stream && /text\/event-stream/i.test(type) && resp.body?.getReader) return await readStream(resp, onDelta, arm);
    return await resp.json();
  } catch (e) {
    if (controller.cancelled) throw cancelledError();
    if (controller.timedOut) { const err = new Error('Hết thời gian chờ API.'); err.timeout = true; throw err; }
    throw e;
  } finally {
    clearTimeout(timeout);
    inflight.get(ctx.owner)?.delete(controller);
  }
}
function buildBody(rows, conf, model, ctx, plain, stream) {
  const legacy = Boolean(conf.customPrompt?.trim());
  const input = legacy
    ? rows.map(({id, text, context}) => ({id, text, context}))
    : {...(ctx.page ? {page: ctx.page} : {}), items: rows.map((r, i) => {
        const item = {n: i + 1, t: r.text};
        if (r.context && r.text.length < 100) item.c = r.context;
        return item;
      })};
  const body = {model, stream: Boolean(stream), messages: [
    {role: 'system', content: legacy ? conf.customPrompt.trim() : VIWEB_PROMPT},
    {role: 'user', content: JSON.stringify(input)}
  ]};
  if (!plain) {
    const chars = rows.reduce((sum, r) => sum + r.text.length, 0);
    body.temperature = 0.1;
    // Generous cap: Gemini counts thinking tokens against the output limit.
    body.max_tokens = Math.min(16384, Math.ceil(chars * 1.6) + rows.length * 24 + 4096);
    if (!legacy) body.response_format = {type: 'json_object'};
    if (stream) body.stream_options = {include_usage: true};
  }
  return body;
}
function usable(row, value) {
  return typeof value === 'string' && (value.trim() || !row.text.trim()) && value.length <= row.text.length * 8 + 200;
}
async function llmCall(rows, conf, model, ctx) {
  const url = validateEndpoint(conf.endpoint);
  const legacy = Boolean(conf.customPrompt?.trim());
  const keys = rows.map((r, i) => legacy ? r.id : String(i + 1));
  const keyIndex = new Map(keys.map((k, i) => [k, i]));
  const plainKey = url + '|' + model;
  const stream = conf.streaming !== false && !legacy;
  const parser = stream ? new StreamParser() : null;
  const sent = new Set();
  const onDelta = parser ? text => {
    const items = [];
    for (const [key, value] of parser.feed(text)) {
      const i = keyIndex.get(key);
      if (i === undefined || sent.has(key) || !usable(rows[i], value)) continue;
      sent.add(key); items.push({id: rows[i].id, text: value});
    }
    emitPartial(ctx, items);
  } : null;
  const started = Date.now();
  metrics.requests++;
  let json = null;
  try {
    try { json = await post(url, buildBody(rows, conf, model, ctx, plainModels.has(plainKey), stream), conf, ctx, onDelta); }
    catch (err) {
      // Some proxies/models reject sampling, JSON-mode or stream_options parameters: retry once without them.
      if (err.status !== 400 || plainModels.has(plainKey)) throw err;
      json = await post(url, buildBody(rows, conf, model, ctx, true, stream), conf, ctx, onDelta);
      plainModels.add(plainKey);
    }
  } catch (err) {
    if (err.cancelled) { metrics.requests--; touchMetrics(); throw err; }
    metrics.failed++;
    if (err.status === 429) { metrics.rateLimited++; onRateLimit(err.retryAfter); }
    touchMetrics();
    // A stream that broke after delivering some fragments still yields those fragments.
    if (!parser?.found.size || err.status === 429) throw err;
    return collect(rows, keys, parser.found);
  }
  const latency = Date.now() - started;
  metrics.latencies.push(latency);
  if (metrics.latencies.length > 200) metrics.latencies.shift();
  metrics.tokensIn += Number(json?.usage?.prompt_tokens) || 0;
  metrics.tokensOut += Number(json?.usage?.completion_tokens) || 0;
  const content = safeText(json?.choices?.[0]?.message?.content);
  if (!content) { metrics.failed++; touchMetrics(); throw new Error('API trả kết quả rỗng hoặc sai chuẩn Chat Completions.'); }
  let found;
  try { found = parseResponse(content, keys); }
  catch (err) {
    if (!parser?.found.size) { metrics.failed++; touchMetrics(); throw err; }
    found = parser.found;
  }
  metrics.ok++; onSuccess(); touchMetrics();
  const out = collect(rows, keys, found);
  if (!out.size) throw malformed('Bản dịch trả về không hợp lệ.');
  return out;
}
function collect(rows, keys, found) {
  const out = new Map();
  rows.forEach((row, i) => {
    const value = found.get(keys[i]);
    if (usable(row, value)) out.set(row.id, value); // runaway or empty output is treated as missing
  });
  return out;
}
function backoff(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
const modelCooldown = new Map();
function modelOrder(conf) {
  const now = Date.now();
  const models = modelList(conf);
  return [...models.filter(m => (modelCooldown.get(m) || 0) <= now), ...models.filter(m => (modelCooldown.get(m) || 0) > now)];
}
async function retryCall(rows, conf, ctx) {
  const models = modelOrder(conf);
  let lastError;
  for (let m = 0; m < models.length; m++) {
    const attempts = m === 0 ? 3 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await schedule(ctx.owner, () => llmCall(rows, conf, models[m], ctx), ctx.priority);
        if (m > 0) { metrics.fallbacks++; touchMetrics(); }
        return result;
      } catch (err) {
        lastError = err;
        if (err.cancelled) throw err;
        if (err.malformed) { if (attempt >= 1) throw err; metrics.retries++; await backoff(250); continue; }
        const modelProblem = err.status === 404 || (err.status === 400 && /model/i.test(err.message));
        const temporary = !err.status || err.status === 408 || err.status === 429 || err.status >= 500;
        if (modelProblem) break;
        if (!temporary) throw err;
        if (attempt >= attempts - 1) { modelCooldown.set(models[m], Date.now() + 30000); break; }
        metrics.retries++;
        const wait = Math.min(5000, 650 * 2 ** attempt + Math.random() * 250);
        await backoff(Math.max(wait, Math.min(err.retryAfter || 0, 15000)));
      }
    }
  }
  throw lastError;
}
/* Accepts partial answers: only fragments the model skipped are asked again. */
async function resolveRows(rows, conf, ctx) {
  const result = new Map();
  let pending = rows;
  for (let pass = 0; pass < 2 && pending.length; pass++) {
    let got;
    try { got = await retryCall(pending, conf, ctx); }
    catch (err) {
      if (err.cancelled || pending.length === 1 || [400, 401, 403, 404].includes(err.status)) throw err;
      // A malformed or overloaded batch is isolated into two halves, translated in parallel.
      const mid = Math.ceil(pending.length / 2);
      const parts = await Promise.all([resolveRows(pending.slice(0, mid), conf, ctx), resolveRows(pending.slice(mid), conf, ctx)]);
      for (const part of parts) for (const [k, v] of part) result.set(k, v);
      return result;
    }
    for (const [k, v] of got) result.set(k, v);
    pending = pending.filter(r => !result.has(r.id));
  }
  if (pending.length) { metrics.missing += pending.length; touchMetrics(); }
  return result;
}

/* ---------- batch entry point ---------- */
async function translateBatch(rows, ctx) {
  const conf = await settings();
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 24) throw new Error('Batch không hợp lệ.');
  if (rows.some(x => typeof x.id !== 'string' || typeof x.text !== 'string' || x.text.length > 12000)) throw new Error('Nội dung cần dịch không hợp lệ.');
  configureConcurrency(Math.max(1, Math.min(8, Number(conf.concurrentRequests) || 3)));
  const prompt = conf.customPrompt?.trim() || VIWEB_PROMPT;
  const namespace = [CACHE_VERSION, conf.endpoint, conf.model, prompt, 'auto', 'vi'].join('\u001e');
  const keys = await Promise.all(rows.map(r => hashString(namespace + '\u001e' + r.text +
    (r.text.length < 100 ? '\u001e' + (r.context || '').slice(0, 450) : ''))));
  const cached = await Promise.all(keys.map(cacheGet));
  const done = new Map(); let hits = 0;
  const misses = [];
  for (let i = 0; i < rows.length; i++) {
    if (cached[i] !== null) { done.set(rows[i].id, cached[i]); hits++; }
    else misses.push({...rows[i], key: keys[i]});
  }
  metrics.cacheHits += hits; metrics.cacheMisses += misses.length; touchMetrics();
  if (misses.length) {
    // Coalesce duplicate simultaneous requests for the same fragment across tabs.
    const unique = [], deferred = [];
    const seen = new Map();
    for (const item of misses) {
      const pending = pendingKeys.get(item.key);
      if (pending) deferred.push({item, promise: pending});
      else if (seen.has(item.key)) deferred.push({item, duplicateOf: seen.get(item.key)});
      else { seen.set(item.key, item.id); unique.push(item); }
    }
    if (unique.length) {
      // Own each cache key until its request finishes; avoid leaking unresolved promises.
      const resolvers = new Map();
      for (const item of unique) {
        let resolve, reject;
        const promise = new Promise((a, b) => { resolve = a; reject = b; });
        promise.catch(() => {}); // the owning batch may fail before another caller joins
        pendingKeys.set(item.key, promise);
        resolvers.set(item.key, {resolve, reject});
      }
      try {
        const computed = await resolveRows(unique, conf, ctx);
        for (const item of unique) {
          const value = computed.get(item.id);
          if (value === undefined) { resolvers.get(item.key).resolve(null); continue; }
          done.set(item.id, value);
          resolvers.get(item.key).resolve(value);
          await cachePut(item.key, value, conf.cacheLimit);
        }
      } catch (err) {
        for (const val of resolvers.values()) val.reject(err);
        throw err;
      } finally {
        for (const item of unique) pendingKeys.delete(item.key);
      }
    }
    for (const {item, promise, duplicateOf} of deferred) {
      if (duplicateOf) { const v = done.get(duplicateOf); if (v !== undefined) done.set(item.id, v); continue; }
      try { const v = await promise; if (v !== null) done.set(item.id, v); } catch { /* the requesting tab retries */ }
    }
  }
  // text:null marks fragments the model did not return; the content script retries them.
  return {translations: rows.map(r => ({id: r.id, text: done.get(r.id) ?? null})), cacheHits: hits};
}
async function clearCache() {
  if (dbPromise) {
    const db = await dbPromise;
    db.close(); dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Cache đang được sử dụng; thử lại sau.'));
  });
}
async function fetchModels() {
  const conf = await settings();
  const url = validateEndpoint(conf.endpoint).replace(/\/chat\/completions$/, '/models');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {headers: authHeaders(conf), signal: controller.signal});
    if (!resp.ok) throw new Error(`API ${resp.status} khi lấy danh sách model.`);
    const json = await resp.json();
    const ids = (Array.isArray(json?.data) ? json.data : []).map(x => x?.id).filter(x => typeof x === 'string');
    return {models: ids.sort()};
  } finally { clearTimeout(timeout); }
}

const MESSAGES = ['VIWEB_TRANSLATE', 'VIWEB_TEST', 'VIWEB_CLEAR_CACHE', 'VIWEB_CANCEL', 'VIWEB_METRICS', 'VIWEB_METRICS_RESET', 'VIWEB_MODELS'];
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'VIWEB_FRAME_CONTEXT') {
    // The top-level tab URL comes from Chrome, not untrusted page JavaScript.
    let topHost = '';
    try { topHost = new URL(sender.tab?.url || '').hostname.toLowerCase(); } catch {}
    reply({ok:true, topHost});
    return;
  }
  if (!msg || !MESSAGES.includes(msg.type)) return;
  const owner = sender.tab ? `${sender.tab.id}:${sender.frameId ?? 0}` : 'ext';
  (async () => {
    await metricsReady;
    if (msg.type === 'VIWEB_CANCEL') { cancelOwner(owner); return {cancelled: true}; }
    if (msg.type === 'VIWEB_METRICS') return {metrics: metricsSummary()};
    if (msg.type === 'VIWEB_METRICS_RESET') { resetMetrics(); return {metrics: metricsSummary()}; }
    if (msg.type === 'VIWEB_MODELS') return await fetchModels();
    if (msg.type === 'VIWEB_TRANSLATE') {
      return await translateBatch(msg.rows, newContext(owner, msg.page,
        {batchId: msg.batchId, priority: msg.priority, tabId: sender.tab?.id, frameId: sender.frameId}));
    }
    if (msg.type === 'VIWEB_CLEAR_CACHE') { await clearCache(); return {cleared:true}; }
    const conf = await settings();
    configureConcurrency(Math.max(1, Math.min(8, Number(conf.concurrentRequests) || 3)));
    const map = await retryCall([{id:'test', text:'Hello world.', context:'Simple greeting.'}], conf, newContext('ext'));
    return {ok: true, translation: map.get('test')};
  })().then(result => reply({ok:true, ...result})).catch(err => reply({ok:false, cancelled: Boolean(err?.cancelled), error: String(err?.message || err)}));
  return true;
});
