const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const shared = fs.readFileSync(path.join(root,'shared.js'),'utf8');
const policies = vm.runInNewContext(shared + '\n({VIWEB_mode,VIWEB_siteEnabled,VIWEB_cleanHost})');
const {VIWEB_mode, VIWEB_siteEnabled, VIWEB_cleanHost} = policies;
function check(mode, host, siteModes={}, excludedDomains=''){
  return VIWEB_siteEnabled({autoMode:mode,siteModes,excludedDomains},host);
}
assert.equal(check('all','nodeseek.com'),true);
assert.equal(check('all','nodeseek.com',{ 'nodeseek.com':'off'}),false);
assert.equal(check('all','nodeseek.com',{},'nodeseek.com'),false);
assert.equal(check('all','nodeseek.com',{'nodeseek.com':'auto'},'nodeseek.com'),true);
assert.equal(check('selected','nodeseek.com'),false);
assert.equal(check('selected','nodeseek.com',{'nodeseek.com':'auto'}),true);
assert.equal(check('selected','reddit.com',{'nodeseek.com':'auto'}),false);
assert.equal(check('off','nodeseek.com',{'nodeseek.com':'auto'}),false);
assert.equal(VIWEB_mode({enabled:false}),'selected');
assert.equal(VIWEB_mode({enabled:false,autoMode:'all'}),'all');
assert.equal(VIWEB_cleanHost('NodeSeek.com'),'nodeseek.com');
assert.equal(VIWEB_cleanHost('https://nodeseek.com'),'');
assert.equal(VIWEB_cleanHost('bad_domain!!!'), '');

async function popupTest(initial, toggleTo){
  const store = {...initial};
  const listeners = {};
  function el(id){
    if(!elements[id]) elements[id]={checked:false,disabled:false,textContent:'',classList:{toggle(){}},addEventListener:(type,callback)=>listeners[id+':'+type]=callback};
    return elements[id];
  }
  const elements={};
  const fake = {
    document:{getElementById:el}, URL, console,
    VIWEB_mode,VIWEB_siteEnabled,VIWEB_DEFAULTS:{autoMode:'all',excludedDomains:'',visualMode:'translate'},
    chrome:{
      tabs:{query:async()=>[{id:10,url:'https://nodeseek.com/topic/123'}],sendMessage:async()=>({enabled:false,shown:0,cacheHits:0})},
      storage:{local:{get:async defaults=>Object.assign({},defaults,store),set:async newVals=>Object.assign(store,newVals)}},
      runtime:{openOptionsPage:()=>{}}
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'popup.js'),'utf8'),fake);
  for(let i=0;i<100 && !listeners['site-toggle:change'];i++)await new Promise(r=>setTimeout(r,2));
  assert.ok(listeners['site-toggle:change'],'popup init');
  elements['site-toggle'].checked=toggleTo;
  await listeners['site-toggle:change']({target:elements['site-toggle']});
  return store;
}
(async()=>{
  let state=await popupTest({autoMode:'selected',siteModes:{}},true);
  assert.equal(state.siteModes['nodeseek.com'],'auto');
  assert.equal(check(state.autoMode,'nodeseek.com',state.siteModes),true);
  state=await popupTest(state,false);
  assert.ok(!('nodeseek.com' in state.siteModes));
  state=await popupTest({autoMode:'off',siteModes:{}},true);
  assert.equal(state.autoMode,'selected');
  assert.equal(state.siteModes['nodeseek.com'],'auto');
  state=await popupTest({autoMode:'all',siteModes:{}},false);
  assert.equal(state.siteModes['nodeseek.com'],'off');
  state=await popupTest({enabled:false,siteModes:{}},true);
  assert.equal(state.siteModes['nodeseek.com'],'auto');
  console.log('PASS: all/selected/off modes, exclusions, legacy migration, popup per-site persistence and override');
})().catch(err=>{console.error(err);process.exitCode=1;});
