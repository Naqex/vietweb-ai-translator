#!/usr/bin/env node
// Live end-to-end benchmark: runs the REAL background.js (scheduler, streaming, parser, fallback)
// against a real CLIProxyAPI, simulating the content script's batching for one page.
//   node tests/live_e2e.js <model> [model...]        (reads .env.local: VIWEB_KEY, VIWEB_ENDPOINT)
// Env: VIWEB_ROUNDS (default 3), VIWEB_STREAM=0 to disable streaming, VIWEB_PARALLEL (default 8),
//      VIWEB_JSON=1 prints JSON instead of a Markdown table.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const models = process.argv.slice(2);
if (!models.length) { console.error('Usage: node tests/live_e2e.js <model> [model...]'); process.exit(2); }
const ROUNDS = Number(process.env.VIWEB_ROUNDS) || 3;
const PARALLEL = Math.min(8, Number(process.env.VIWEB_PARALLEL) || 8);
const STREAM = process.env.VIWEB_STREAM !== '0';

// [text, substrings that must survive translation unchanged]
const CORPUS = [
  ['楼主这个方案真的靠谱吗？我之前用过类似的，延迟高得离谱。', []],
  ['大佬们，求助：vps 重装系统后 ssh 连不上了，端口没改过。', []],
  ['这价格也太离谱了，薅羊毛的都冲了，已经卖断货了。', []],
  ['Just shipped v2.1 with GPU support and a 30% faster cold start.', ['v2.1', 'GPU', '30%']],
  ["I don't think the cache invalidation is the problem here, it's the race in the worker pool.", []],
  ['lol this thread is a mess, mods pls fix', []],
  ['Warning: the `--force` flag will overwrite existing files without asking.', ['`--force`']],
  ['同款闲鱼 9成新 不刀 包邮 仅限自提', []],
  ['Anyone benchmarked Gemini 3.8 Flash against Claude Haiku for translation latency?', ['Gemini 3.8 Flash', 'Claude Haiku']],
  ['内卷到最后，大家都在摸鱼，真正干活的人没几个。', []],
  ['The API returns 429 when you exceed 60 requests per minute; retry with exponential backoff.', ['429', '60']],
  ['今天的更新修复了登录弹窗无法点击的问题，感谢反馈。', []],
  ['Reminder: never paste your API key in public issues.', ['API']],
  ['这个模型的速度怎么样？支持流式输出吗？', []],
  ['Rust 1.85 stabilizes async closures, finally.', ['Rust 1.85']],
  ['#AI $NVDA earnings beat again, guidance raised to $38B', ['#AI', '$NVDA']],
  ['请问有人遇到过 Docker 容器时区不对的问题吗？', ['Docker']],
  ['Thanks! That fixed it for me.', []],
  ['拼多多这次的补贴力度真的大，iPhone 立减 1500 元。', ['iPhone', '1500']],
  ['Memory usage spikes after ~2h; heap snapshot shows retained detached DOM nodes.', ['DOM']],
  ['@alice 你的 PR #482 已经合并了，详见 https://example.com/pr/482', ['@alice', '#482', 'https://example.com/pr/482']],
  ['Set TZ=Asia/Ho_Chi_Minh in the Dockerfile, then run `docker compose up -d`.', ['TZ=Asia/Ho_Chi_Minh', '`docker compose up -d`']],
  ['限时优惠：原价 ¥299，现价 ¥199，仅剩 3 件！', ['¥299', '¥199']],
  ['Bug report: clicking "Save" twice creates duplicate rows in PostgreSQL 16.', ['"Save"', 'PostgreSQL 16']],
  ['这个插件在 Chrome 和 Brave 上都能用，但是 Firefox 不行。', ['Chrome', 'Brave', 'Firefox']],
  ['Please do NOT merge before CI is green.', ['CI']],
  ['谢谢楼主分享，已收藏，回头试试。', []],
  ['Latency p95 dropped from 1.8s to 0.9s after enabling streaming.', ['p95', '1.8s', '0.9s']],
  ['有没有人知道 Cloudflare Workers 怎么绑定自定义域名？', ['Cloudflare Workers']],
  ['TIL: git rebase --onto can move a branch to a new base.', ['git rebase --onto']],
  ['啊这，又涨价了，这个月已经第三次了。', []],
  ['Release notes: fixed a crash on startup when the config file is empty.', []],
  ['楼上说得对，建议先看官方文档再提问。', []],
  ['Sponsored: get 20% off your first year with code SAVE20.', ['20%', 'SAVE20']],
  ['内存占用 1.2GB，CPU 12%，磁盘读写正常。', ['1.2GB', '12%']],
  ['Why does `npm install` hang behind a corporate proxy?', ['`npm install`']],
  ['这条帖子被置顶了，请遵守版规，禁止广告。', []],
  ['Anyone else getting ECONNRESET on Node 22?', ['ECONNRESET', 'Node 22']],
  ['新手求带，想入门前端，学 React 还是 Vue 好？', ['React', 'Vue']],
  ['Update: the issue was a typo in /etc/hosts. Sorry for the noise!', ['/etc/hosts']],
  ['买了两天就降价，血亏，早知道等等了。', []],
  ['The new GPU draws 450W under load; make sure your PSU can handle it.', ['GPU', '450W', 'PSU']],
  ['该商品已下架，请联系客服获取更多信息。', []],
  ['Edit: formatting. Also added the benchmark script to the repo.', []],
  ['求推荐一款 3000 元以内的笔记本，主要用来写代码。', ['3000']],
  ['Tip: press Ctrl+Shift+P to open the command palette in VS Code.', ['Ctrl+Shift+P', 'VS Code']],
  ['小米 15 Ultra 的影像系统到底值不值得买？', ['15 Ultra']],
  ['Deployment failed: exit code 137 (out of memory) on worker-3.', ['137', 'worker-3']],
  ['哈哈哈哈这个评论笑死我了。', []],
  ['Disclaimer: this is not financial advice.', []],
  ['请在 24 小时内完成实名认证，否则账号将被限制。', ['24']],
  ['Typo: "recieve" should be "receive" in the docs.', ['"recieve"', '"receive"']],
  ['这个bug我也遇到了，重启后恢复正常，但是过一会儿又出现了。', []],
  ['Pro tip: pin your dependencies and commit the lockfile.', []],
  ['有大佬懂 Kubernetes 的 HPA 配置吗？', ['Kubernetes', 'HPA']],
  ['Shipping to Vietnam takes 7-10 business days via DHL.', ['7-10', 'DHL']],
  ['今天天气真好，适合出去走走。', []],
  ['Is it safe to run `rm -rf node_modules` while the dev server is up?', ['`rm -rf node_modules`']],
  ['这家店的老板人很好，价格也实惠，五星好评。', []],
  ['Changelog: v3.0.0 drops support for Node 16.', ['v3.0.0', 'Node 16']],
];
const CJK = /[\u3400-\u9fff]/;
const VI = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;

function loadBackground(model) {
  const script = fs.readFileSync(path.join(root, 'shared.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'background.js'), 'utf8').replace("importScripts('shared.js');", '');
  let listener;
  const tabMessages = [];
  const config = {endpoint: process.env.VIWEB_ENDPOINT || 'http://127.0.0.1:8317/v1', model, fallbackModels: '',
    apiKey: process.env.VIWEB_KEY || '', concurrentRequests: PARALLEL, streaming: STREAM, customPrompt: '', timeoutSeconds: 60};
  const chrome = {
    storage: {local: {get: async d => ({...d, ...config}), set: async () => {}}},
    tabs: {sendMessage: (tabId, msg) => { tabMessages.push({t: performance.now(), msg}); return Promise.resolve(); }},
    runtime: {onMessage: {addListener: fn => { listener = fn; }}}
  };
  const ctx = {chrome, crypto: webcrypto, TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout, fetch,
    Math, Date, console, Map, Set, Promise, Object, Number, String, Array, JSON, Error, indexedDB: undefined, performance};
  vm.createContext(ctx);
  vm.runInContext(script, ctx, {filename: 'background.js'});
  const send = (msg, tabId = 1) => new Promise(resolve => listener(msg, {tab: {id: tabId}, frameId: 0}, resolve));
  return {send, tabMessages};
}

async function runPage(bg, items, round) {
  // Mimic content.js: first batch small (viewport, priority 0), rest in larger prefetch batches (priority 1).
  const batches = [];
  let i = 0;
  batches.push(items.slice(i, i += 6));
  while (i < items.length) batches.push(items.slice(i, i += 16));
  const t0 = performance.now();
  bg.tabMessages.length = 0;
  const results = await Promise.all(batches.map((b, k) => {
    const rows = b.map(it => ({id: `r${round}-${it.idx}`, text: it.text, context: ''}));
    return bg.send({type: 'VIWEB_TRANSLATE', batchId: `b${round}-${k}`, priority: k === 0 ? 0 : 1,
      page: {kind: 'forum', lang: 'zh', host: 'example.com'}, rows}).then(r => ({r, done: performance.now() - t0}));
  }));
  const firstPartial = bg.tabMessages.find(m => m.msg.type === 'VIWEB_PARTIAL');
  const out = new Map();
  let errors = 0;
  for (const {r} of results) {
    if (!r?.ok) { errors++; continue; }
    for (const t of r.translations || []) out.set(t.id, t.text);
  }
  return {wall: performance.now() - t0, firstBatch: results[0].done,
    firstPartial: firstPartial ? firstPartial.t - t0 : null, out, errors,
    partialItems: bg.tabMessages.reduce((s, m) => s + (m.msg.type === 'VIWEB_PARTIAL' ? m.msg.items.length : 0), 0)};
}

async function benchModel(model) {
  const bg = loadBackground(model);
  const probe = await bg.send({type: 'VIWEB_TEST'});
  if (!probe.ok) return {model, fatal: probe.error};
  const stats = {wall: [], firstBatch: [], firstPartial: [], complete: 0, total: 0, preserved: 0, mustTotal: 0,
    stillCjk: 0, noVi: 0, errors: 0, partialItems: 0, samples: [], fails: []};
  for (let round = 0; round < ROUNDS; round++) {
    await bg.send({type: 'VIWEB_CLEAR_CACHE'});
    const items = CORPUS.map(([text, must], k) => ({idx: k, text, must}));
    const res = await runPage(bg, items, round);
    stats.wall.push(res.wall); stats.firstBatch.push(res.firstBatch);
    if (res.firstPartial !== null) stats.firstPartial.push(res.firstPartial);
    stats.errors += res.errors; stats.partialItems += res.partialItems;
    for (const it of items) {
      stats.total++;
      const vi = res.out.get(`r${round}-${it.idx}`);
      if (typeof vi !== 'string' || !vi.trim()) { stats.fails.push(`MISSING  ⇒  ${it.text}`); continue; }
      stats.complete++;
      if (CJK.test(vi)) stats.stillCjk++;
      if (!VI.test(vi) && vi.length > 12) stats.noVi++;
      for (const s of it.must) { stats.mustTotal++; if (vi.includes(s)) stats.preserved++; else stats.fails.push(`${s}  ⇒  ${vi}`); }
      if (round === 0 && process.env.VIWEB_DUMP) stats.samples.push(`${it.text}\n     → ${vi}`);
      else if (round === 0 && [0, 6, 15, 20, 21, 33].includes(it.idx)) stats.samples.push(`${it.text}\n     → ${vi}`);
    }
  }
  const metrics = (await bg.send({type: 'VIWEB_METRICS'})).metrics || {};
  return {model, stats, metrics};
}

(async () => {
  const rows = [], detail = [];
  for (const model of models) {
    process.stderr.write(`▶ ${model} (${ROUNDS} rounds × ${CORPUS.length} items, parallel ${PARALLEL}, stream ${STREAM})\n`);
    const r = await benchModel(model);
    if (r.fatal) { rows.push({model, error: r.fatal}); continue; }
    const s = r.stats, sec = x => (x / 1000).toFixed(2);
    rows.push({model,
      'page p50 s': sec(pct(s.wall, .5)), 'page max s': sec(Math.max(...s.wall)),
      '1st batch s': sec(pct(s.firstBatch, .5)),
      '1st partial s': s.firstPartial.length ? sec(pct(s.firstPartial, .5)) : '-',
      'items/s': (s.complete / (s.wall.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
      'complete %': Math.round(s.complete / s.total * 100),
      'preserved %': s.mustTotal ? Math.round(s.preserved / s.mustTotal * 100) : 100,
      'CJK left': s.stillCjk, 'not VI': s.noVi, errors: s.errors,
      'streamed %': Math.round(s.partialItems / s.total * 100)});
    detail.push({model, samples: s.samples, fails: [...new Set(s.fails)], metrics: r.metrics});
  }
  if (process.env.VIWEB_JSON) { console.log(JSON.stringify({rows, detail}, null, 2)); return; }
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  console.log('| ' + cols.join(' | ') + ' |\n|' + cols.map(() => '---').join('|') + '|');
  for (const r of rows) console.log('| ' + cols.map(c => r[c] ?? '').join(' | ') + ' |');
  for (const d of detail) console.log(`\n### ${d.model}\n` + d.samples.map(s => '  • ' + s).join('\n') +
    (d.fails.length ? '\n  ✗ not preserved:\n' + d.fails.map(f => '    ' + f).join('\n') : ''));
})().catch(e => { console.error(e); process.exit(1); });
