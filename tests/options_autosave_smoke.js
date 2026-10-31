const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname,'..');
const store = {enabled:false,siteModes:{'nodeseek.com':'auto'}};
const handlers = {};
let onStorageChanges;
function elem(id){
  return elements[id] ||= {
    id, value:'',checked:false,textContent:'',type:'text',dataset:{},children:[],
    classList:{toggle(){}}, addEventListener:(type,fn)=>handlers[id+':'+type]=fn,
    setAttribute(){},replaceChildren(){this.children=[];},append(...items){this.children.push(...items)}
  };
}
const elements={};
const radios=['all','selected','off'].map(value=>Object.assign(elem('auto-'+value),{value}));
const segments=['fast','balanced','quality'].map(value=>Object.assign(elem('segment-'+value),{dataset:{preset:value}}));
const doc={
  getElementById:elem,
  createElement:tag=>elem('gen'+Math.random()),
  querySelectorAll:sel=>sel==='.segment'?segments:sel==='input[name=autoMode]'?radios:[],
  querySelector:sel=>sel==='input[name=autoMode]:checked'?radios.find(e=>e.checked):
    radios.find(e=>sel.includes('value='+e.value+']'))
};
const chrome = {storage:{local:{
  get: async defaults=>Object.assign({}, defaults||{}, store),
  set: async vals=>{
    const changes={};
    for(const [key, val] of Object.entries(vals)) changes[key]={oldValue:store[key], newValue:val};
    Object.assign(store,vals);
    if(onStorageChanges) onStorageChanges(changes,'local');
  }
},onChanged:{addListener:fn=>onStorageChanges=fn}},runtime:{sendMessage:async()=>({ok:true,translation:'Xin chào'})}};
const sandbox={document:doc, chrome, setTimeout, clearTimeout, URL, console};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'shared.js'),'utf8'),sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'options.js'),'utf8'),sandbox);
const delay = (ms=30)=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let t=0;t<450;t++){if(fn())return;await delay(5)}throw Error('Condition not reached')}
(async()=>{
  await until(()=>elem('save-state').textContent.includes('Tất cả thay đổi'));
  // Legacy disabled must migrate to selected, retaining saved site list.
  assert.ok(radios[1].checked);
  assert.ok(elem('site-list').children.some(item=>item.children?.[0]?.textContent==='nodeseek.com'));
  // Select global policy and persist without hitting Save.
  radios.forEach(r=>r.checked=(r.value==='off'));
  handlers['auto-off:change']();
  await until(()=>store.autoMode==='off');
  // Add an allowlisted site and preserve existing modes.
  elem('new-site').value='reddit.com';
  handlers['add-site-form:submit']({preventDefault(){}});
  await until(()=>store.siteModes['reddit.com']==='auto');
  assert.equal(store.siteModes['nodeseek.com'],'auto');
  // Preset should autosave immediately.
  handlers['segment-fast:click']();
  await until(()=>store.concurrentRequests===4 && store.maxBatchChars===1800);
  assert.equal(store.siteModes['reddit.com'],'auto');
  // Prompt debounce saves automatically.
  elem('customPrompt').value='Translate accurately to Vietnamese.';
  handlers['customPrompt:input']();
  await until(()=>store.customPrompt==='Translate accurately to Vietnamese.');
  console.log('PASS: legacy migration, allowlist UI, performance presets and prompt autosave retain per-site settings');
})().catch(e=>{console.error(e);process.exitCode=1;});
