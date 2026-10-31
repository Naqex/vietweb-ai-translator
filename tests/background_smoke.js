// Self-contained Node >=18 smoke tests for the extension service worker.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname,'..');
const script = fs.readFileSync(path.join(root,'shared.js'),'utf8')+'\n'+
  fs.readFileSync(path.join(root,'background.js'),'utf8').replace("importScripts('shared.js');",'')+
  '\nthis.__test={sched,schedule,metricsSummary,modelCooldown,StreamParser,hedge,metrics};';
let calls=[], mode='ok', listener, tabMessages=[];
const config = {endpoint:'http://127.0.0.1:8317/v1',model:'gemini-3.8-flash(low)',fallbackModels:'gemini-3.8-flash-lite',
  apiKey:'unit-test-key',concurrentRequests:4,customPrompt:''};
const response = (status, body, headers={}) => ({ok:status<400,status,headers:{get:k=>headers[k.toLowerCase()]??null},json:async()=>body});
const completion = (content, usage) => response(200, {choices:[{message:{content}}], usage});
// Server-sent events cut at arbitrary byte boundaries, optionally dropping the connection afterwards.
function sse(text, {fail=false, usage=true}={}) {
  const enc = new TextEncoder();
  let raw = '';
  for (let i=0;i<text.length;i+=7) raw += 'data: '+JSON.stringify({choices:[{delta:{content:text.slice(i,i+7)}}]})+'\n\n';
  if (!fail) {
    if (usage) raw += 'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:50,completion_tokens:10}})+'\n\n';
    raw += 'data: [DONE]\n\n';
  }
  const pieces = raw.match(/[\s\S]{1,19}/g);
  let at = 0;
  return {ok:true,status:200,headers:{get:k=>k.toLowerCase()==='content-type'?'text/event-stream':null},
    body:{getReader:()=>({read:async()=>{
      if (at<pieces.length) return {done:false,value:enc.encode(pieces[at++])};
      if (fail) throw new Error('connection reset');
      return {done:true};
    }})}};
}
const fakeFetch = async (url, req) => {
  if (url.endsWith('/models')) return response(200,{data:[{id:'b-model'},{id:'a-model'}]});
  const input = JSON.parse(req.body);
  const user = JSON.parse(input.messages[1].content);
  const legacy = Array.isArray(user);
  const items = legacy ? user.map(x=>({n:x.id,t:x.text})) : user.items;
  calls.push({url,headers:req.headers,input,user,items,signal:req.signal});
  const model = input.model;
  if (mode==='rate' && model==='gemini-3.8-flash(low)') return response(429,{error:{message:'quota'}},{'retry-after':'0'});
  if (mode==='slow1' && model==='slow-primary') return new Promise((_,reject)=>req.signal.addEventListener('abort',()=>{calls.aborted=(calls.aborted||0)+1;reject(Object.assign(new Error('aborted'),{name:'AbortError'}));}));
  if (mode==='hang') return new Promise((_,reject)=>req.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
  if (mode==='plain' && input.response_format) return response(400,{error:{message:'response_format unsupported'}});
  if (mode==='bad' && items.length>1) return completion(JSON.stringify({wrong:'x'}));
  if ((mode==='stream' || mode==='streamcut') && !legacy && input.stream && (mode==='stream' || calls.length===1)) {
    const full = JSON.stringify(Object.fromEntries(items.map(x=>[String(x.n),'VI: '+x.t])));
    return mode==='stream' ? sse(full) : sse(full.slice(0, full.indexOf('"2":"')+9), {fail:true});
  }
  if (mode==='partial' && items.length>1 && !calls.partialDone) { calls.partialDone=true;
    return completion(JSON.stringify({[items[0].n]:'VI: '+items[0].t})); }
  if (legacy) return completion(JSON.stringify(items.map(x=>({id:x.n,vi:'VI: '+x.t}))));
  return completion(JSON.stringify(Object.fromEntries(items.map(x=>[String(x.n),'VI: '+x.t]))), {prompt_tokens:100,completion_tokens:20});
};
const chrome = {
  storage: {local:{get:async(defaults)=>({...defaults,...config})}},
  tabs: {sendMessage:(tabId,msg,opts)=>{tabMessages.push({tabId,msg,opts});return Promise.resolve();}},
  runtime: {onMessage:{addListener:fn=>{listener=fn;}}}
};
const context={chrome,crypto:webcrypto,TextEncoder,TextDecoder,URL,AbortController,setTimeout,clearTimeout,fetch:fakeFetch,Math,Date,console,Map,Set,Promise,Object,Number,String,Array,JSON,Error,indexedDB:undefined};
vm.createContext(context);
vm.runInContext(script,context,{filename:'background.js'});
async function send(msg, sender={tab:{id:1},frameId:0}) {
  return await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('message timeout')),12000);
    const handled=listener(msg,sender,r=>{clearTimeout(timeout);resolve(r)});
    assert.equal(handled,true);
  });
}
const row=(id,text,context='')=>({id,text,context});
(async()=>{
  // Compact protocol, auth header, model, prompt, sampling parameters
  let r=await send({type:'VIWEB_TRANSLATE',rows:[row('1','你好世界','hello'),row('2','Welcome friends','welcome')],
    page:{kind:'forum',lang:'zh-CN',title:'Test page'}});
  assert.equal(r.ok,true,r.error);
  assert.equal(r.translations[0].text,'VI: 你好世界');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://127.0.0.1:8317/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization,'Bearer unit-test-key');
  assert.equal(calls[0].input.model,'gemini-3.8-flash(low)');
  assert.ok(calls[0].input.messages[0].content.includes('UNTRUSTED DATA'));
  assert.equal(calls[0].input.temperature,0.1);
  assert.ok(calls[0].input.max_tokens>=4096);
  assert.deepEqual(calls[0].input.response_format,{type:'json_object'});
  assert.deepEqual(calls[0].user.page,{kind:'forum',lang:'zh-CN',title:'Test page'});
  assert.equal(calls[0].items[0].n,1);
  assert.equal(calls[0].items[0].c,'hello');

  // Long text drops context; duplicate text inside one batch is sent once
  calls=[];
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('a','x'.repeat(150),'ctx'),row('b','Same text'),row('c','Same text')]});
  assert.equal(r.ok,true,r.error);
  assert.equal(calls[0].items.length,2);
  assert.equal(calls[0].items[0].c,undefined);
  assert.equal(r.translations[2].text,'VI: Same text');

  // Partial answer: only the missing fragment is requested again
  calls=[]; mode='partial';
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('p1','Alpha one'),row('p2','Beta two'),row('p3','Gamma three')]});
  assert.equal(r.ok,true,r.error);
  assert.deepEqual(r.translations.map(t=>t.text),['VI: Alpha one','VI: Beta two','VI: Gamma three']);
  assert.equal(calls.length,2);
  assert.equal(calls[1].items.length,2);

  // Malformed multi-item answers are isolated into halves
  calls=[]; mode='bad';
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('3','Machine learning'),row('4','Neural network')]});
  assert.equal(r.ok,true,r.error);
  assert.equal(r.translations[1].text,'VI: Neural network');

  // Streaming: fragments reach the tab as soon as each one is complete, then the final reply is still complete
  calls=[]; tabMessages=[]; mode='stream';
  r=await send({type:'VIWEB_TRANSLATE',batchId:'b1',rows:[row('s1','Alpha one'),row('s2','Beta two'),row('s3','Gamma three')]},{tab:{id:5},frameId:3});
  assert.equal(r.ok,true,r.error);
  assert.equal(calls[0].input.stream,true);
  assert.deepEqual(r.translations.map(t=>t.text),['VI: Alpha one','VI: Beta two','VI: Gamma three']);
  assert.ok(tabMessages.length>=3,'fragments should arrive incrementally');
  assert.equal(tabMessages[0].tabId,5);
  assert.equal(tabMessages[0].opts.frameId,3);
  assert.equal(tabMessages[0].msg.type,'VIWEB_PARTIAL');
  assert.equal(tabMessages[0].msg.batchId,'b1');
  assert.deepEqual(tabMessages.flatMap(x=>x.msg.items.map(i=>i.id)),['s1','s2','s3']);
  assert.ok(context.__test.metricsSummary().tokensIn>=150,'usage from the final stream chunk is counted');

  // A stream that drops mid-way keeps the finished fragments and re-requests only the rest
  calls=[]; tabMessages=[]; mode='streamcut';
  r=await send({type:'VIWEB_TRANSLATE',batchId:'b2',rows:[row('c1','Alpha one'),row('c2','Beta two')]},{tab:{id:5},frameId:0});
  assert.equal(r.ok,true,r.error);
  assert.deepEqual(r.translations.map(t=>t.text),['VI: Alpha one','VI: Beta two']);
  assert.equal(calls.length,2);
  assert.equal(calls[1].items.length,1);
  assert.equal(tabMessages[0].msg.items[0].id,'c1');

  // Without a batch id (or when disabled) nothing is pushed and the normal path still works
  calls=[]; tabMessages=[]; mode='stream'; config.streaming=false;
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('n1','No stream one')]});
  assert.equal(r.ok,true,r.error);
  assert.equal(calls[0].input.stream,false);
  assert.equal(tabMessages.length,0);
  config.streaming=true; mode='ok';

  // Incremental parser handles escapes, unicode and arbitrary chunk boundaries
  const parser=new context.__test.StreamParser();
  const doc='```json\n{"1": "Dòng \\"một\\"\\nhai", "2":"\\u00e9", "10":"x"}\n```';
  const seen=[];
  for (let i=0;i<doc.length;i+=3) for (const [k,v] of parser.feed(doc.slice(i,i+3))) seen.push([k,v]);
  assert.deepEqual(seen,[['1','Dòng "một"\nhai'],['2','é'],['10','x']]);

  // Viewport batches (priority 0) overtake queued prefetch batches (priority 1)
  const order=[]; const {sched,schedule}=context.__test;
  sched.limit=1; sched.ceiling=1;
  let release; const gate=new Promise(res=>release=res);
  const blocker=schedule('t:0',()=>gate);
  const late=schedule('t:0',async()=>order.push('prefetch'),1);
  const urgent=schedule('t:0',async()=>order.push('viewport'),0);
  release(); await Promise.all([blocker,late,urgent]);
  assert.deepEqual(order,['viewport','prefetch']);
  sched.limit=4; sched.ceiling=4;

  // Models rejecting JSON mode/sampling parameters are retried plain, and remembered
  calls=[]; mode='plain';
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('5','Plain mode one')]});
  assert.equal(r.ok,true,r.error);
  assert.equal(calls.length,2);
  assert.equal(calls[1].input.response_format,undefined);
  calls=[];
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('6','Plain mode two')]});
  assert.equal(calls.length,1);

  // HTTP 429 on the primary: halves concurrency and falls back to the second model
  calls=[]; mode='rate'; context.__test.sched.limit=4;
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('7','Rate limited text')]});
  assert.equal(r.ok,true,r.error);
  assert.equal(calls.at(-1).input.model,'gemini-3.8-flash-lite');
  assert.ok(context.__test.sched.limit<4,'AIMD should reduce concurrency after 429');
  const m1=context.__test.metricsSummary();
  assert.ok(m1.rateLimited>=1 && m1.fallbacks>=1);

  // Hedging: a call slower than the recent p95 is raced by the fallback model; the loser is aborted
  context.__test.modelCooldown.clear(); context.__test.sched.pauseUntil=0;
  context.__test.sched.limit=4; context.__test.sched.ceiling=4;
  assert.ok(context.__test.metrics.latencies.length>=8);
  context.__test.hedge.minMs=60;
  calls=[]; calls.aborted=0; tabMessages=[]; mode='slow1'; config.model='slow-primary'; config.fallbackModels='fast-backup';
  const h0=context.__test.metricsSummary().hedgeWins||0;
  r=await send({type:'VIWEB_TRANSLATE',batchId:'h1',rows:[row('h1','Hedge me please')]},{tab:{id:7},frameId:0});
  assert.equal(r.ok,true,r.error);
  assert.equal(r.translations[0].text,'VI: Hedge me please');
  assert.deepEqual(calls.map(c=>c.input.model),['slow-primary','fast-backup']);
  assert.equal(context.__test.metricsSummary().hedgeWins,h0+1);
  assert.equal(calls.aborted,1,'losing call must be aborted');
  // Disabled: no second request is raced, the slow call is waited for (cancelled here via timeout-free abort)
  calls=[]; config.hedging=false;
  const noHedge=send({type:'VIWEB_TRANSLATE',rows:[row('h2','Hedge off')]},{tab:{id:8},frameId:0});
  await new Promise(res=>setTimeout(res,400));
  assert.equal(calls.length,1,'no hedge when disabled');
  await send({type:'VIWEB_CANCEL'},{tab:{id:8},frameId:0}); await noHedge;
  config.hedging=true; context.__test.hedge.minMs=3000;

  // Cancellation aborts in-flight requests for that tab/frame only
  mode='hang'; config.model='hang-model'; config.fallbackModels='';
  const hanging=send({type:'VIWEB_TRANSLATE',rows:[row('8','Never finishes')]},{tab:{id:9},frameId:0});
  await new Promise(res=>setTimeout(res,50));
  await send({type:'VIWEB_CANCEL'},{tab:{id:9},frameId:0});
  const cancelled=await hanging;
  assert.equal(cancelled.ok,false);
  assert.equal(cancelled.cancelled,true);

  // Metrics, model list, validation
  mode='ok'; config.model='gemini-3.8-flash(low)';
  const stats=await send({type:'VIWEB_METRICS'});
  assert.ok(stats.metrics.requests>0 && stats.metrics.p50!==null && stats.metrics.tokensIn>=100);
  const models=await send({type:'VIWEB_MODELS'});
  assert.deepEqual(models.models,['a-model','b-model']);
  const reject=await send({type:'VIWEB_TRANSLATE',rows:[{id:'fail',text:17,context:''}]});
  assert.equal(reject.ok,false);

  // Custom prompts keep the legacy id/array protocol
  calls=[]; config.customPrompt='Custom prompt. Output [{"id","vi"}].';
  r=await send({type:'VIWEB_TRANSLATE',rows:[row('9','Legacy prompt text')]});
  assert.equal(r.ok,true,r.error);
  assert.ok(Array.isArray(calls[0].user)&&calls[0].user[0].id==='9');
  assert.equal(calls[0].input.response_format,undefined);
  console.log('PASS: compact protocol, auth, params, partial results, halving, plain retry, 429+fallback, cancel, metrics, models, legacy prompt');
})().catch(e=>{console.error(e);process.exitCode=1});
