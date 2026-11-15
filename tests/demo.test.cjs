const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../demo/magpie-import-demo.html'),'utf8');
const script=source.match(/<script id="magpie-demo-core">([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({URL,btoa,atob,setTimeout,console});
vm.runInContext(script,context);
const {scenarios,parseClipboard,normalizeUrl,DemoEngine,candidate}=context.MagpieDemoCore;
const engine=()=>new DemoEngine({delay:()=>Promise.resolve()});

test('JSON extracts a complete credential pair; full chat endpoint normalizes once',()=>{
  const parsed=parseClipboard(scenarios.json);
  assert.equal(parsed.kind,'candidates');
  assert.equal(parsed.candidates[0].name,'我的 API');
  assert.equal(parsed.candidates[0].base,'https://api.example/v1');
  assert.equal(normalizeUrl('https://api.example/v1/chat/completions'),'https://api.example/v1');
  assert.throws(()=>normalizeUrl('https://user:pass@api.example/v1'));
  assert.throws(()=>normalizeUrl('javascript:alert(1)'));
});
test('image fixture keeps three Base64 keys paired with their own labels',()=>{
  const parsed=parseClipboard(scenarios.image);
  assert.equal(parsed.candidates.length,3);
  assert.equal(parsed.candidates[0].name,'BLG 1:1');
  assert.equal(parsed.candidates[0].key,'demo_valid_blg_one');
  assert.equal(parsed.candidates[1].key,'demo_valid_blg_two');
  assert.equal(parsed.candidates[2].name,'我们是冠军');
  assert.ok(parsed.candidates.every(c=>c.base==='https://relay.example/v1'));
});
test('unrelated text is quiet; missing, masked and invalid Base64 credentials need correction',()=>{
  assert.equal(parseClipboard(scenarios.unrelated).kind,'none');
  assert.equal(parseClipboard(scenarios.incomplete).kind,'incomplete');
  assert.equal(parseClipboard({text:'baseurl: https://api.example/v1\nKey: sk-******'}).kind,'incomplete');
  assert.equal(parseClipboard({text:'baseurl: https://api.example/v1\nKey(base64): invalid%%%'}).kind,'incomplete');
  assert.equal(parseClipboard({text:'{"url":'}).kind,'incomplete');
});
test('only the custom supplier page can start identification or validation',async()=>{
  const e=engine();
  for(const page of ['providers','agents','usage','settings']){
    e.setPage(page);await e.detect();await e.validate(candidate('test','https://api.example/v1','demo_valid_any'));
    assert.equal(e.state.status,'idle');assert.equal(e.state.confirmation,false);
  }
});
test('success needs confirmation before saving and keeps the current supplier',async()=>{
  const e=engine();assert.equal(e.add(),false);await e.setPage('custom');
  assert.equal(e.state.status,'verified');assert.equal(e.state.confirmation,true);assert.equal(e.state.providers.length,2);
  assert.equal(e.add(),true);assert.equal(e.state.providers.length,3);assert.equal(e.state.page,'providers');
  assert.equal(e.state.providers.filter(p=>p.current).length,1);assert.equal(e.state.providers.find(p=>p.current).id,'deepseek');
  assert.equal(e.add(),false);
});
test('failed Key, timeout and missing fields never open the add prompt',async()=>{
  for(const fixture of ['invalid','timeout','incomplete']){
    const e=engine();e.setScenario(fixture);await e.setPage('custom');
    assert.ok(['failed','incomplete'].includes(e.state.status));assert.equal(e.state.confirmation,false);assert.equal(e.add(),false);assert.equal(e.state.providers.length,2);
  }
});
test('multi-key input waits for a selection and only imports the selected key',async()=>{
  const e=engine();e.setScenario('image');await e.setPage('custom');
  assert.equal(e.state.status,'selecting');assert.equal(e.state.confirmation,false);
  await e.selectCandidate(1);assert.equal(e.state.status,'verified');e.add();
  assert.equal(e.state.lastAdded.name,'BLG 2:1');assert.equal(e.state.lastAdded.key,'demo_valid_blg_two');assert.equal(e.state.providers.length,3);
});
test('cancel suppresses repeated prompts and manual re-detection is possible',async()=>{
  const e=engine();await e.setPage('custom');e.dismiss();e.setPage('providers');await e.setPage('custom');
  assert.equal(e.state.status,'dismissed');assert.equal(e.state.confirmation,false);
  await e.detect(true);assert.equal(e.state.confirmation,true);
});
test('existing credentials are detected before sending a simulated validation',async()=>{
  const e=engine();e.setScenario('duplicate');await e.setPage('custom');
  assert.equal(e.state.status,'duplicate');assert.equal(e.state.confirmation,false);assert.equal(e.cache.size,0);
});
test('leaving the page cancels an in-flight read without a late confirmation',async()=>{
  const queue=[];const e=new DemoEngine({delay:()=>new Promise(resolve=>queue.push(resolve))});
  const pending=e.setPage('custom');e.setPage('agents');queue.shift()();await pending;
  assert.equal(e.state.page,'agents');assert.equal(e.state.status,'idle');assert.equal(e.state.confirmation,false);
});
test('leaving during validation discards a late successful response',async()=>{
  const queue=[];const e=new DemoEngine({delay:()=>new Promise(resolve=>queue.push(resolve))});
  const pending=e.setPage('custom');queue.shift()();await new Promise(setImmediate);
  assert.equal(e.state.status,'validating');e.setPage('usage');queue.shift()();await pending;
  assert.equal(e.state.page,'usage');assert.equal(e.state.confirmation,false);assert.equal(e.state.providers.length,2);
});
test('changing clipboard during validation cannot import stale results',async()=>{
  const queue=[];const e=new DemoEngine({delay:()=>new Promise(resolve=>queue.push(resolve))});
  const old=e.setPage('custom');queue.shift()();await new Promise(setImmediate);
  e.state.auto=false;e.setClipboard({kind:'text',text:scenarios.unrelated.text});queue.shift()();await old;
  assert.equal(e.state.status,'idle');assert.equal(e.state.confirmation,false);assert.equal(e.add(),false);
});
test('changing validated credentials invalidates approval until reverified',async()=>{
  const e=engine();await e.setPage('custom');e.edit({key:'demo_invalid_changed'});
  assert.equal(e.state.status,'edited');assert.equal(e.state.confirmation,false);assert.equal(e.add(),false);
  await e.validate(e.state.selected,true);assert.equal(e.state.status,'failed');
});
test('automatic detection can be disabled; explicit detection still works',async()=>{
  const e=engine();e.setAuto(false);await e.setPage('custom');assert.equal(e.state.status,'idle');
  await e.detect(true);assert.equal(e.state.confirmation,true);
});
test('the deliverable has no real network or system clipboard integration',()=>{
  assert.doesNotMatch(source,/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|navigator\.clipboard|https:\/\/(?:api\.clodaw|jpn\.cdn\.moxuna)/);
  assert.doesNotMatch(source,/<(?:html|head|body)(?:\s|>)|<!doctype/i);
  assert.ok(Buffer.byteLength(source)<1000000);
});
