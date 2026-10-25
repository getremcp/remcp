import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeElementListeners, inspectElementListeners } from '../src/extended/browser-listeners.mjs';
import { buildDevtoolsReport, browserDevtools } from '../src/extended/browser-devtools.mjs';

const listener = (type, overrides={})=>({
  type,scriptId:'SECRET SCRIPT',lineNumber:182,columnNumber:3,
  handler:{description:'function(){ let PASSWORD = "SECRET"; }'},
  originalHandler:{description:'SECRET CALLBACK'},
  ...overrides,
});
test('native listener summary never exposes handler code, custom types or script locations',()=>{
  const report=summarizeElementListeners([
    listener('click',{passive:true}),
    listener('click',{once:true,useCapture:true}),
    listener('SECRET_CUSTOM_EVENT',{passive:true}),
    listener('input'),listener('submit'),
  ]);
  assert.equal(report.listener_count,5);
  assert.deepEqual(report.by_type,{click:2,input:1,other:1,submit:1});
  assert.equal(report.repeated_event_types,1);
  assert.equal(report.passive_count,2);
  assert.equal(report.capture_count,1);
  assert.equal(report.once_count,1);
  assert.doesNotMatch(JSON.stringify(report),/SECRET|scriptId|lineNumber|originalHandler|PASSWORD/);
});
test('large reports are bounded with strict sample and event-type caps',()=>{
  const report=summarizeElementListeners(Array.from({length:1_000},()=>listener('click')));
  assert.equal(report.listener_count,1000);
  assert.equal(report.sampled_listeners,200);
  assert.equal(report.by_type.click,200);
  assert.equal(report.truncated,true);
});
test('selected element audit uses read-only native CDP commands, releases remote objects',async()=>{
  const calls=[];
  const session={async send(method,args){
    calls.push([method,args]);
    if(method==='DOM.getDocument')return {root:{nodeId:1,outerHTML:'DO NOT RETURN'}};
    if(method==='DOM.querySelector')return {nodeId:4};
    if(method==='DOM.resolveNode')return {object:{objectId:'remote-private-id'}};
    if(method==='DOMDebugger.getEventListeners')return {listeners:[listener('click'),listener('wheel',{passive:true})]};
    return {};
  }};
  const result=await inspectElementListeners(session,'#secret-login');
  assert.equal(result.found,true);
  assert.equal(result.listeners.listener_count,2);
  assert.deepEqual(calls.map(call=>call[0]),[
    'DOM.getDocument','DOM.querySelector','DOM.resolveNode',
    'DOMDebugger.getEventListeners','Runtime.releaseObject','DOM.disable',
  ]);
  assert.deepEqual(calls[0][1],{depth:0,pierce:false});
  assert.deepEqual(calls[3][1],{objectId:'remote-private-id',depth:0,pierce:false});
  assert.doesNotMatch(JSON.stringify(result),/secret-login|remote-private-id|SECRET|scriptId|lineNumber/);
});
test('missing node returns no matching-element metadata and disables DOM',async()=>{
  const calls=[];
  const session={async send(method,args){calls.push(method);return method==='DOM.getDocument'?{root:{nodeId:1}}:{nodeId:0};}};
  const result=await inspectElementListeners(session,'button');
  assert.equal(result.found,false);
  assert.equal(result.listeners.listener_count,0);
  assert.deepEqual(calls,['DOM.getDocument','DOM.querySelector','DOM.disable']);
});
test('event listener audit releases object even when Chrome listener call fails',async()=>{
  const calls=[];
  const session={async send(method){
    calls.push(method);
    if(method==='DOM.getDocument')return {root:{nodeId:1}};
    if(method==='DOM.querySelector')return {nodeId:2};
    if(method==='DOM.resolveNode')return {object:{objectId:'private-object'}};
    if(method==='DOMDebugger.getEventListeners')throw new Error('CDP failed');
    return {};
  }};
  await assert.rejects(inspectElementListeners(session,'a'),/CDP failed/);
  assert.deepEqual(calls.slice(-2),['Runtime.releaseObject','DOM.disable']);
});
test('malformed selectors are rejected before any CDP request',async()=>{
  const session={send(){throw new Error('no browser call expected')}};
  for (const selector of ['', '<script>', 'button\ninput', 'x'.repeat(121), null]){
    await assert.rejects(inspectElementListeners(session,selector),/selector/i);
  }
});
test('listener diagnostics omit inspected tab URL even when it includes secrets',()=>{
  const report=buildDevtoolsReport({id:'target-9',url:'https://private.example/token?code=secret'},'listeners',{action:'listeners',found:true,listeners:summarizeElementListeners([listener('click')])});
  assert.equal(report.target_id,'target-9');
  assert.equal('url' in report,false);
  assert.doesNotMatch(JSON.stringify(report),/private\.example|code=secret|PASSWORD/);
});
test('listener mode cannot be invoked without an explicit target ID',async()=>{
  await assert.rejects(browserDevtools({action:'listeners',selector:'button'}),/target_id/);
});
