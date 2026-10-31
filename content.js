/* VietWeb AI content script: no overlays, no text selection hijack, no innerHTML writes. */
(() => {
  'use strict';
  const DEFAULTS = {
    enabled: true, prefetchPixels: 700, maxBatchChars: 2600, maxBatchItems: 8, firstBatchItems: 5,
    excludedDomains: 'mail.google.com\naccounts.google.com\noutlook.live.com\noutlook.office.com\nlocalhost', visualMode: 'translate'
  };
  const IGNORE = 'script,style,noscript,template,textarea,input,select,option,code,pre,kbd,samp,svg,math,canvas,video,audio,iframe,[contenteditable],[translate="no"],[aria-hidden="true"],[hidden],[inert],[role="textbox"],[role="input"],[data-vietweb-ignore],[data-private],html[data-vietweb-yt] .ytp-caption-window-container';
  const CHARACTER = /[\p{L}\p{N}]/u;
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  const VIET_WORDS = /\b(?:không|những|người|được|chúng|tôi|mình|của|trong|tiếng|với|bạn|đang|nhưng|thường|nhiều|thông|điều|trường|việc|hướng)\b/iu;
  const states = new WeakMap();
  const attributeStates = new WeakMap();
  const tracked = new Set();
  const awaiting = new Map();
  const parentNodes = new Map();
  const visibilityCache = new WeakMap();
  let intersection = null, mutation = null, settings = DEFAULTS;
  let enabled = false, showOriginal = false, scanTimer = null, flushTimer = null;
  const pendingScan = new Set();
  let navEpoch = 1, lastUrl = location.href, activeBatches = 0, nextId = 0;
  let shown = 0, cacheHits = 0, requests = 0, lastError = '', lastBatchMs = 0;
  let firstEnqueueAt = null, firstShownMs = null;
  const ownHost = location.hostname.toLowerCase();
  const isFrame = window !== window.top;
  let effectiveHost = ownHost, frameAllowed = true;

  function baseSite(host) {
    const labels = host.toLowerCase().split('.').filter(Boolean);
    if (labels.length < 2) return host;
    // Conservative fallback for common two-label public suffixes.
    const secondLevel = new Set(['co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au','com.cn','net.cn','org.cn','co.jp','co.kr','com.br','com.vn']);
    const lastTwo = labels.slice(-2).join('.');
    return labels.slice(-(secondLevel.has(lastTwo) ? 3 : 2)).join('.');
  }
  function sameSite(a, b) {
    return Boolean(a && b && baseSite(a) === baseSite(b));
  }
  async function refreshFrameContext(conf) {
    if (!isFrame) { effectiveHost = ownHost; frameAllowed = true; return; }
    const ancestorOrigin = location.ancestorOrigins?.[location.ancestorOrigins.length - 1] || '';
    let topHost = '';
    try {
      const result = await chrome.runtime.sendMessage({type:'VIWEB_FRAME_CONTEXT'});
      topHost = result?.topHost || '';
    } catch {}
    if (!topHost) { try { topHost = new URL(ancestorOrigin).hostname.toLowerCase(); } catch {} }
    // Never inherit a selected website's permission into an unrelated third-party iframe.
    // Third-party frames can be opted in by enabling their own host in siteModes.
    // about:blank/srcdoc inherits the creator's origin. It is only safe to
    // inherit top-site permission when the browser permits same-origin access.
    let sameOriginInheritedFrame = false;
    if (!ownHost && topHost && ['about:', 'blob:'].includes(location.protocol)) {
      try { sameOriginInheritedFrame = window.top.location.hostname.toLowerCase() === topHost; } catch {}
    }
    if (topHost && (sameSite(topHost, ownHost) || sameOriginInheritedFrame)) {
      effectiveHost = topHost;
      frameAllowed = true;
    } else {
      effectiveHost = ownHost;
      frameAllowed = conf.siteModes?.[ownHost] === 'auto';
    }
  }
  function elementOf(entry) { return entry.kind === 'attribute' ? entry.node : entry.node.parentElement; }
  function valueOf(entry) { return entry.kind === 'attribute'
    ? entry.node.getAttribute(entry.attributeName) : entry.node.nodeValue; }
  function assignValue(entry, value) {
    if (entry.kind === 'attribute') entry.node.setAttribute(entry.attributeName, value);
    else entry.node.nodeValue = value;
  }


  function isAllowed(conf) {
    // Older versions only had enabled:boolean. Preserve that setting as an
    // allowlist rather than blocking explicit site overrides.
    const mode = ['all','selected','off'].includes(conf.autoMode)
      ? conf.autoMode : (conf.enabled === false ? 'selected' : 'all');
    if (mode === 'off') return false;
    if (!frameAllowed) return false;
    const host = effectiveHost;
    const site = conf.siteModes?.[host];
    if (site === 'off') return false;
    if (site === 'auto') return true;
    if (mode === 'selected') return false;
    return !(conf.excludedDomains || '').split(/[\n,;]/)
      .map(x => x.trim().toLowerCase().replace(/^\*\./,'')).filter(Boolean)
      .some(rule => host === rule || host.endsWith('.' + rule));
  }
  function isVietnamese(t) {
    const accents = (t.match(/[àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi) || []).length;
    return accents >= 2 && VIET_WORDS.test(t);
  }
  function eligible(node) {
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const text = node.nodeValue?.trim() || '';
    if (!text || text.length < (CJK.test(text) ? 2 : 3) || text.length > 12000) return false;
    if (!CHARACTER.test(text) || /^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(text)) return false;
    if (!/[\p{L}]/u.test(text) || isVietnamese(text)) return false;
    const parent = node.parentElement;
    if (!parent || parent.closest(IGNORE) || parent.isContentEditable) return false;
    if (parent.closest('head') || parent.closest('[data-vietweb-ui]')) return false;
    if (parent.closest('[lang="vi"],[lang^="vi-"]') && isVietnamese(text)) return false;
    let visible = visibilityCache.get(parent);
    if (visible === undefined) {
      const style = getComputedStyle(parent);
      visible = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && (parent.getClientRects().length > 0 || style.display === 'contents');
      // Only cache visibility within this scan. React/Vue can later hide or reveal elements.
      if (visible) visibilityCache.set(parent, true);
    }
    return visible;
  }
  function contextOf(node) {
    const parent = node.parentElement;
    const container = parent?.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,td,th,figcaption,dd,dt');
    if (!container || container === parent || container.textContent.length > 550) return '';
    return container.textContent.slice(0, 450);
  }
  function showTranslation(entry) {
    if (!entry.node.isConnected || typeof entry.translation !== 'string') return;
    const value = showOriginal ? entry.original : entry.translation;
    if (valueOf(entry) !== value) assignValue(entry, value);
  }
  function track(node) {
    if (!enabled || !eligible(node)) return;
    const old = states.get(node);
    if (old) {
      if (node.nodeValue === old.translation || node.nodeValue === old.original) return;
      // A framework changed the text; begin tracking the new source, not stale translation.
      tracked.delete(old); awaiting.delete(old.id);
      const oldParent = node.parentElement;
      parentNodes.get(oldParent)?.delete(old);
    }
    const entry = {id:'v' + (++nextId), node, kind:'text', original:node.nodeValue, translation:null,
      status:'observing', context:contextOf(node), epoch:navEpoch};
    states.set(node, entry); tracked.add(entry);
    const parent = node.parentElement;
    if (!parentNodes.has(parent)) {
      parentNodes.set(parent, new Set());
      intersection?.observe(parent);
    }
    parentNodes.get(parent).add(entry);
    const rect = parent.getBoundingClientRect();
    if (rect.top < innerHeight + settings.prefetchPixels && rect.bottom > -settings.prefetchPixels) {
      enqueue(entry);
    }
  }
  const ATTRIBUTE_NAMES = ['placeholder', 'title', 'aria-label'];
  function trackAttributes(element) {
    if (!enabled || !element?.isConnected || !(element instanceof Element)) return;
    if (element.closest('[hidden],[inert],[aria-hidden="true"],[data-private],[data-vietweb-ignore],[translate="no"]')) return;
    if (element.closest('script,style,noscript,template,svg,code,pre,kbd,samp,math,canvas,iframe')) return;
    // Only translate static presentation attributes. Never inspect or send input.value,
    // checked status, password values, data-* or form submission attributes.
    const tag = element.localName;
    if (!['input','textarea','button','a','img','div','span','label'].includes(tag)) return;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible' || !element.getClientRects().length) return;
    let slots = attributeStates.get(element);
    if (!slots) { slots = new Map(); attributeStates.set(element, slots); }
    for (const attr of ATTRIBUTE_NAMES) {
      if (!element.hasAttribute(attr)) continue;
      if (attr === 'placeholder' && !['input','textarea'].includes(tag)) continue;
      const text = element.getAttribute(attr)?.trim() || '';
      if (text.length < (CJK.test(text) ? 2 : 3) || text.length > 600 || !CHARACTER.test(text) || isVietnamese(text)) continue;
      if (!/[\p{L}]/u.test(text) || /^https?:/i.test(text)) continue;
      const old = slots.get(attr);
      if (old) {
        if (text === old.original.trim() || text === old.translation?.trim()) continue;
        tracked.delete(old); awaiting.delete(old.id);
        parentNodes.get(element)?.delete(old);
      }
      const entry = {id:'v'+(++nextId),node:element,kind:'attribute',attributeName:attr,
        original:element.getAttribute(attr),translation:null,status:'observing',context:'',epoch:navEpoch};
      slots.set(attr,entry); tracked.add(entry);
      if (!parentNodes.has(element)) { parentNodes.set(element,new Set()); intersection?.observe(element); }
      parentNodes.get(element).add(entry);
      const r=element.getBoundingClientRect();
      if (r.top < innerHeight+settings.prefetchPixels && r.bottom > -settings.prefetchPixels) enqueue(entry);
    }
  }
  function scan(root) {
    if (!enabled || !root?.isConnected) return;
    if (root.nodeType === Node.TEXT_NODE) { track(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      trackAttributes(root);
      if (root.closest(IGNORE)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node, scanned = 0;
    while ((node = walker.nextNode()) && scanned++ < 12000) {
      if (node.nodeType === Node.TEXT_NODE) track(node);
      else if (node.nodeType === Node.ELEMENT_NODE) trackAttributes(node);
    }
  }
  function enqueue(entry) {
    if (!enabled || entry.status !== 'observing' || !entry.node.isConnected) return;
    entry.status = 'queued'; entry.epoch = navEpoch;
    awaiting.set(entry.id, entry);
    if (!flushTimer) flushTimer = setTimeout(flush, 85);
  }
  function rank(entry) {
    const r = elementOf(entry)?.getBoundingClientRect();
    if (!r) return Number.MAX_SAFE_INTEGER;
    if (r.bottom >= 0 && r.top <= innerHeight) return 0;
    return Math.min(Math.abs(r.top - innerHeight), Math.abs(r.bottom)) + 1;
  }
  // Viewport items go out first in small batches (fast first paint); off-screen prefetch uses large batches.
  function flush() {
    flushTimer = null;
    if (!enabled) return;
    const cap = Math.min(8, Math.max(1, Number(settings.concurrentRequests) || 3));
    if (activeBatches >= cap || !awaiting.size) return;
    const ranked = [];
    for (const e of awaiting.values()) {
      if (!e.node.isConnected || e.epoch !== navEpoch) { awaiting.delete(e.id); continue; }
      ranked.push([rank(e), e]);
    }
    ranked.sort((a, b) => a[0] - b[0]);
    const maxItems = Math.max(1, Math.min(24, Number(settings.maxBatchItems) || 8));
    const maxChars = Math.max(400, Number(settings.maxBatchChars) || 2600);
    const firstItems = Math.max(1, Math.min(maxItems, Number(settings.firstBatchItems) || 5));
    let i = 0;
    while (activeBatches < cap && i < ranked.length) {
      const inViewport = ranked[i][0] === 0;
      const itemCap = inViewport ? firstItems : maxItems;
      const charCap = inViewport ? Math.min(maxChars, 2200) : maxChars;
      const batch = []; let chars = 0;
      while (i < ranked.length && batch.length < itemCap) {
        const [r, e] = ranked[i];
        if ((r === 0) !== inViewport) break;
        if (batch.length && chars + e.original.length > charCap) break;
        batch.push(e); chars += e.original.length;
        awaiting.delete(e.id); e.status = 'working'; i++;
      }
      sendBatch(batch, navEpoch, inViewport ? 0 : 1);
    }
  }
  const SITE_KINDS = [
    ['social media', /(^|\.)(x\.com|twitter\.com|weibo\.(com|cn)|reddit\.com|facebook\.com|instagram\.com|threads\.net|tiktok\.com|bsky\.app|xiaohongshu\.com)$/],
    ['forum or Q&A', /(nodeseek|v2ex|linux\.do|hostloc|52pojie|tieba\.baidu|zhihu|lowendtalk|ycombinator|stackoverflow|stackexchange|discourse|forum)/],
    ['technical documentation', /(^|\.)(github\.com|gitlab\.com|readthedocs|learn\.microsoft\.com)|^(docs|developer|developers)\./],
    ['e-commerce listing', /(goofish|xianyu|taobao|tmall|1688|jd\.com|aliexpress|amazon|shopee|lazada|temu)/]
  ];
  function pageInfo() {
    let kind = SITE_KINDS.find(([, re]) => re.test(effectiveHost))?.[0] || '';
    if (!kind && document.querySelector('meta[property="og:type"][content="article"]')) kind = 'news article';
    return {kind, lang: (document.documentElement.lang || '').slice(0, 16), title: (document.title || '').slice(0, 90)};
  }
  function cancelRequests() {
    try { Promise.resolve(chrome.runtime.sendMessage({type:'VIWEB_CANCEL'})).catch(() => {}); } catch {}
  }
  function retryLater(entries, epoch) {
    const due = entries.filter(e => (e.retries = (e.retries || 0) + 1) <= 2);
    if (!due.length) return;
    setTimeout(() => {
      if (epoch !== navEpoch || !enabled) return;
      for (const e of due) enqueue(e);
    }, 900 * due[0].retries);
  }
  const liveBatches = new Map(); // batchId -> {byId, epoch}; receives streamed fragments before the final reply
  let batchSeq = 0;
  function isCurrent(entry, epoch) {
    const current = entry.kind === 'attribute'
      ? attributeStates.get(entry.node)?.get(entry.attributeName)
      : states.get(entry.node);
    return entry.node.isConnected && current === entry && entry.epoch === epoch;
  }
  function applyTranslation(entry, vi, epoch) {
    if (entry.status === 'done' || !isCurrent(entry, epoch)) return;
    entry.translation = vi; entry.status = 'done'; shown++;
    if (firstShownMs === null) firstShownMs = Math.round(performance.now() - firstEnqueueAt);
    showTranslation(entry);
  }
  async function sendBatch(batch, epoch, priority = 1) {
    activeBatches++; requests++;
    const startedAt = performance.now();
    if (firstEnqueueAt === null) firstEnqueueAt = startedAt;
    const batchId = `${Date.now().toString(36)}-${++batchSeq}`;
    liveBatches.set(batchId, {byId: new Map(batch.map(e => [e.id, e])), epoch});
    try {
      const response = await chrome.runtime.sendMessage({
        type:'VIWEB_TRANSLATE', batchId, priority, page: pageInfo(),
        rows: batch.map(e => ({id:e.id, text:e.original, context:e.context}))
      });
      if (epoch !== navEpoch || !enabled) return;
      if (response?.cancelled) { for (const e of batch) if (e.status === 'working') e.status = 'observing'; return; }
      if (!response?.ok) throw new Error(response?.error || 'Không gọi được CLIProxyAPI.');
      lastBatchMs = Math.round(performance.now() - startedAt);
      cacheHits += Number(response.cacheHits) || 0;
      const values = new Map((response.translations || []).map(t => [t.id, t.text]));
      const missing = [];
      for (const entry of batch) {
        if (entry.status === 'done' || !isCurrent(entry, epoch)) continue;
        const vi = values.get(entry.id);
        if (typeof vi === 'string') applyTranslation(entry, vi, epoch);
        else { entry.status = 'observing'; missing.push(entry); }
      }
      if (missing.length) retryLater(missing, epoch);
      lastError = '';
    } catch (e) {
      if (epoch === navEpoch) {
        lastBatchMs = Math.round(performance.now() - startedAt);
        lastError = String(e?.message || e).slice(0, 220);
        const failed = batch.filter(entry => entry.status === 'working');
        for (const entry of failed) entry.status = 'observing';
        retryLater(failed, epoch);
      }
    } finally {
      liveBatches.delete(batchId);
      activeBatches--;
      if (awaiting.size && !flushTimer) flushTimer = setTimeout(flush, 50);
    }
  }
  function onPartial(message) {
    const live = liveBatches.get(message.batchId);
    if (!live || live.epoch !== navEpoch || !enabled || !Array.isArray(message.items)) return;
    for (const item of message.items) {
      const entry = live.byId.get(item?.id);
      if (entry && typeof item.text === 'string') applyTranslation(entry, item.text, live.epoch);
    }
  }
  function restoreAll() {
    for (const entry of tracked) {
      if (entry.node.isConnected && valueOf(entry) === entry.translation && entry.original !== null)
        assignValue(entry, entry.original);
    }
  }
  function resetEpoch() {
    navEpoch++;
    firstEnqueueAt = null; firstShownMs = null;
    cancelRequests();
    awaiting.clear();
    for (const entry of tracked) {
      if (!entry.node.isConnected) tracked.delete(entry);
      else if (entry.status === 'working' || entry.status === 'queued') entry.status = 'observing';
    }
  }
  function onVisibility(changes) {
    if (!enabled) return;
    for (const c of changes) {
      if (!c.isIntersecting) continue;
      const entries = parentNodes.get(c.target);
      if (entries) for (const entry of entries) enqueue(entry);
      intersection?.unobserve(c.target); parentNodes.delete(c.target);
    }
  }
  function createIntersection() {
    intersection?.disconnect();
    intersection = new IntersectionObserver(onVisibility, {
      rootMargin: `${Math.max(100, Number(settings.prefetchPixels) || 700)}px 0px`
    });
  }
  // One pipeline: mutation records go straight into pendingScan; a single trailing timer drains it.
  function drainScan() {
    scanTimer = null;
    const nodes = Array.from(pendingScan); pendingScan.clear();
    const queued = new Set(nodes);
    for (const node of nodes) {
      if (!node.isConnected) continue;
      // Skip nodes already covered by a queued ancestor: scan(ancestor) walks them anyway.
      let covered = false;
      for (let p = node.parentNode; p && !covered; p = p.parentNode) covered = queued.has(p);
      if (!covered) scan(node);
    }
  }
  function queueScan(node) {
    pendingScan.add(node);
    if (!scanTimer) scanTimer = setTimeout(drainScan, 80);
  }
  function begin() {
    if (mutation) return;
    createIntersection();
    mutation = new MutationObserver(records => {
      if (!enabled) return;
      if (lastUrl !== location.href) {
        lastUrl = location.href; resetEpoch();
        setTimeout(() => scan(document.body), 240);
      }
      for (const r of records) {
        if (r.type === 'attributes') {
          // Own attribute updates are ignored by trackAttributes when equal to original/translation.
          queueScan(r.target);
        } else if (r.type === 'characterData') {
          const entry = states.get(r.target);
          if (entry && (r.target.nodeValue === entry.original || r.target.nodeValue === entry.translation)) continue;
          queueScan(r.target);
        } else {
          for (const n of r.addedNodes) queueScan(n);
        }
      }
      if (tracked.size > 1500) {
        for (const e of tracked) if (!e.node.isConnected) tracked.delete(e);
        for (const [parent, entries] of parentNodes) {
          for (const e of entries) if (!e.node.isConnected) entries.delete(e);
          if (!parent.isConnected || !entries.size) { intersection?.unobserve(parent); parentNodes.delete(parent); }
        }
      }
    });
    mutation.observe(document.documentElement, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:ATTRIBUTE_NAMES});
    window.addEventListener('popstate', routeChange);
    window.addEventListener('hashchange', routeChange);
  }
  function routeChange() {
    if (lastUrl === location.href) return;
    lastUrl = location.href;
    resetEpoch();
    setTimeout(() => scan(document.body), 250);
  }
  async function resync() {
    settings = {...DEFAULTS, ...(await chrome.storage.local.get(null))};
    await refreshFrameContext(settings);
    const nowEnabled = isAllowed(settings);
    showOriginal = settings.visualMode === 'original';
    if (!nowEnabled && enabled) {
      enabled = false; resetEpoch(); restoreAll();
      intersection?.disconnect(); parentNodes.clear();
      return;
    }
    if (!nowEnabled) return;
    enabled = true;
    if (!mutation) begin();
    createIntersection();
    for (const [parent, entries] of parentNodes) {
      if (parent.isConnected) intersection.observe(parent);
      else parentNodes.delete(parent);
    }
    for (const entry of tracked) if (entry.status === 'done') showTranslation(entry);
    scan(document.body);
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message?.type?.startsWith('VIWEB_')) return;
    if (message.type === 'VIWEB_PARTIAL') { if (sender.id === chrome.runtime.id) onPartial(message); return; }
    if (message.type === 'VIWEB_STATUS') {
      reply({ok:true, enabled, showOriginal, isFrame, effectiveHost, shown, cacheHits, requests,
        queued: awaiting.size, activeBatches, lastBatchMs, firstShownMs, error:lastError, hostname:ownHost});
      return;
    }
    if (message.type === 'VIWEB_RESYNC') {
      resync().then(() => reply({ok:true})).catch(e => reply({ok:false,error:String(e)}));
      return true;
    }
    if (message.type === 'VIWEB_FORCE') {
      if (!enabled) {reply({ok:false,error:'Đã tắt dịch cho website này.'}); return;}
      for (const entry of tracked) if (entry.status !== 'done') entry.status = 'observing';
      scan(document.body);
      for (const entry of tracked) if (entry.status === 'observing' && entry.node.isConnected) enqueue(entry);
      reply({ok:true}); return;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') resync().catch(() => {});
  });
  resync().catch(e => {lastError = String(e);});
})();
