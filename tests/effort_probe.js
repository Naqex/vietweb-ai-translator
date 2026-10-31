#!/usr/bin/env node
// Probe how thinking effort is applied by CLIProxyAPI for each model: suffix "(level)" vs reasoning_effort field.
//   node tests/effort_probe.js [model...]     (reads .env.local)
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const endpoint = (process.env.VIWEB_ENDPOINT || 'http://127.0.0.1:8317/v1') + '/chat/completions';
const models = process.argv.slice(2).length ? process.argv.slice(2)
  : ['gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash-high'];
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'];
const PUZZLE = 'A farmer has 17 sheep; all but 9 run away, then he buys twice as many as remain and sells 4. How many sheep now? Think carefully, answer with one number.';
async function call(model, extra = {}) {
  const t0 = performance.now();
  const r = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.VIWEB_KEY},
    body: JSON.stringify({model, stream: false, max_tokens: 2000, messages: [{role: 'user', content: PUZZLE}], ...extra})});
  const ms = performance.now() - t0, text = await r.text();
  if (!r.ok) return {ms, err: `HTTP ${r.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`};
  const j = JSON.parse(text), u = j.usage || {};
  const reason = u.completion_tokens_details?.reasoning_tokens ?? (u.total_tokens - u.prompt_tokens - u.completion_tokens);
  return {ms, reason, out: u.completion_tokens, hasThought: Boolean(j.choices?.[0]?.message?.reasoning_content)};
}
(async () => {
  console.log('| model | variant | latency s | reasoning tok | output tok | result |\n|---|---|---|---|---|---|');
  for (const model of models) {
    const variants = [[model, {}], ...LEVELS.map(l => [`${model}(${l})`, {}]), [model + ' + reasoning_effort=high', {reasoning_effort: 'high'}]];
    for (const [name, extra] of variants) {
      const real = name.replace(' + reasoning_effort=high', '');
      const r = await call(real, extra);
      console.log(`| ${model} | ${name.slice(model.length) || '(default)'} | ${(r.ms / 1000).toFixed(2)} | ${r.err ? '-' : r.reason} | ${r.err ? '-' : r.out} | ${r.err || 'ok'} |`);
    }
  }
})();
