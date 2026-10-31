#!/usr/bin/env node
// Benchmark real CLIProxyAPI models for VietWeb AI (no browser needed). Node >= 18.
//   set VIWEB_KEY=<client key>   (optional if the proxy has no auth)
//   node tests/bench.js "gemini-3-flash" "gemini-3-flash(low)" "gemini-3.5-flash-lite"
// Env: VIWEB_ENDPOINT (default http://127.0.0.1:8317/v1), VIWEB_ROUNDS (default 3), VIWEB_PARALLEL (default 4)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'shared.js'), 'utf8') + '\nthis.P={VIWEB_PROMPT,VIWEB_LEGACY_PROMPT};', ctx);
const {VIWEB_PROMPT, VIWEB_LEGACY_PROMPT} = ctx.P;
const endpoint = (process.env.VIWEB_ENDPOINT || 'http://127.0.0.1:8317/v1').replace(/\/+$/, '') + '/chat/completions';
const rounds = Number(process.env.VIWEB_ROUNDS) || 3;
const parallel = Number(process.env.VIWEB_PARALLEL) || 4;
const models = process.argv.slice(2);
if (!models.length) { console.error('Usage: node tests/bench.js <model> [model...]'); process.exit(2); }

const CORPUS = [
  '楼主这个方案真的靠谱吗？我之前用过类似的，延迟高得离谱。', '大佬们，求助：vps 重装系统后 ssh 连不上了，端口没改过。',
  '这价格也太离谱了，薅羊毛的都冲了，已经卖断货了。', 'Just shipped v2.1 with GPU support and a 30% faster cold start.',
  "I don't think the cache invalidation is the problem here, it's the race in the worker pool.", 'lol this thread is a mess, mods pls fix',
  'Warning: the `--force` flag will overwrite existing files without asking.', '同款闲鱼 9成新 不刀 包邮 仅限自提',
  'Anyone benchmarked Gemini 3.8 Flash against Claude Haiku for translation latency?', '内卷到最后，大家都在摸鱼，真正干活的人没几个。',
  'The API returns 429 when you exceed 60 requests per minute; retry with exponential backoff.', '今天的更新修复了登录弹窗无法点击的问题，感谢反馈。',
  'Reminder: never paste your API key in public issues.', '这个模型的速度怎么样？支持流式输出吗？', 'Rust 1.85 stabilizes async closures, finally.',
  '#AI $NVDA earnings beat again, guidance raised to $38B', '请问有人遇到过 Docker 容器时区不对的问题吗？', 'Thanks! That fixed it for me.',
  '拼多多这次的补贴力度真的大，iPhone 立减 1500 元。', 'Memory usage spikes after ~2h; heap snapshot shows retained detached DOM nodes.'
];
const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null;
const pick = (n, seed) => Array.from({length: n}, (_, i) => CORPUS[(seed * 7 + i) % CORPUS.length]);

async function call(model, texts, protocol) {
  const compact = protocol === 'compact';
  const input = compact ? {page: {kind: 'forum', lang: 'zh'}, items: texts.map((t, i) => ({n: i + 1, t}))}
    : texts.map((t, i) => ({id: 'v' + (i + 1), text: t, context: ''}));
  const body = {model, stream: false, temperature: 0.1, messages: [
    {role: 'system', content: compact ? VIWEB_PROMPT : VIWEB_LEGACY_PROMPT}, {role: 'user', content: JSON.stringify(input)}]};
  if (compact) body.response_format = {type: 'json_object'};
  const t0 = performance.now();
  const resp = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json',
    ...(process.env.VIWEB_KEY ? {Authorization: 'Bearer ' + process.env.VIWEB_KEY} : {})}, body: JSON.stringify(body)});
  const ms = performance.now() - t0;
  if (!resp.ok) return {ms, error: 'HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 120)};
  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content || '';
  let out = new Map();
  try {
    const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (Array.isArray(parsed)) parsed.forEach(x => typeof x?.vi === 'string' && out.set(String(x.id), x.vi));
    else Object.entries(parsed).forEach(([k, v]) => typeof v === 'string' && out.set(k, v));
  } catch { return {ms, error: 'invalid JSON', usage: json.usage}; }
  const complete = texts.filter((_, i) => out.has(compact ? String(i + 1) : 'v' + (i + 1))).length;
  return {ms, complete, total: texts.length, usage: json.usage, sample: [...out.values()][0]};
}
async function pool(tasks, n) {
  const results = []; let next = 0;
  await Promise.all(Array.from({length: n}, async () => { while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); } }));
  return results;
}
(async () => {
  console.log(`Endpoint ${endpoint} · rounds ${rounds} · parallel ${parallel}\n`);
  const rows = [];
  for (const model of models) {
    for (const [protocol, size] of [['compact', 5], ['compact', 16], ['legacy', 5]]) {
      if (protocol === 'legacy' && model !== models[0]) continue;
      const tasks = Array.from({length: rounds * 2}, (_, r) => () => call(model, pick(size, r), protocol));
      const t0 = performance.now();
      const res = await pool(tasks, parallel);
      const wall = performance.now() - t0;
      const okRes = res.filter(r => !r.error);
      const lat = okRes.map(r => r.ms);
      const items = okRes.reduce((s, r) => s + r.complete, 0), total = res.length * size;
      rows.push({model, protocol, batch: size, errors: res.length - okRes.length,
        'p50 s': (pct(lat, .5) / 1000).toFixed(2), 'p95 s': (pct(lat, .95) / 1000).toFixed(2),
        'complete %': Math.round(items / total * 100),
        'tok in/req': Math.round(okRes.reduce((s, r) => s + (r.usage?.prompt_tokens || 0), 0) / (okRes.length || 1)),
        'tok out/req': Math.round(okRes.reduce((s, r) => s + (r.usage?.completion_tokens || 0), 0) / (okRes.length || 1)),
        'items/s': (items / (wall / 1000)).toFixed(1)});
      const firstError = res.find(r => r.error)?.error;
      if (firstError) console.log(`  ${model} ${protocol}/${size}: ${firstError}`);
      if (okRes[0]?.sample) console.log(`  ${model} sample: ${okRes[0].sample}`);
    }
  }
  console.table(rows);
  console.log('Read: pick the model with lowest p50/p95 and 100% complete. Quality still needs a human read of the samples.');
})().catch(e => { console.error(e); process.exit(1); });
