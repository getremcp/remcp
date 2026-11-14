import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {PAGE_ELEMENT_ACTION} from '../src/extended/browser-actions.mjs';
import {PAGE_VERIFY_POINTER_TARGET, PAGE_DISCARD_POINTER_TARGET,
 dispatchVerifiedClick} from '../src/extended/browser-pointer-guard.mjs';

const key=token=>'__remcp_pointer_'+token;
function pageScene(){
 let current;
 const node=()=>({
  tagName:'BUTTON',isConnected:true,disabled:false,
  getAttribute(){return null},closest(){return null},contains(){return false},
  matches(){return false},scrollIntoView(){},
  getBoundingClientRect(){return {left:10,top:10,right:50,bottom:50,x:10,y:10,width:40,height:40}},
  getClientRects(){return [{x:10,y:10,width:40,height:40}]},
 });
 current=node();
 const document={
  querySelectorAll(){return [current]},
  elementFromPoint(){return current},
 };
 const model={document,location:{origin:'https://example.test'}};
 return {model,replace(){current=node()},get current(){return current}};
}

test('same CSS selector and identical geometry cannot authorize a replacement DOM node',()=>{
 const scene=pageScene();
 const token=randomUUID();
 const expression='('+PAGE_ELEMENT_ACTION+')("#target",null,"click","",'+JSON.stringify(token)+')';
 const rect=runInNewContext(expression,scene.model);
 assert.equal(rect.x,10);
 assert.equal(scene.model.document[key(token)],scene.current);
 scene.replace();
 assert.throws(()=>runInNewContext('('+PAGE_VERIFY_POINTER_TARGET+')("#target",null,30,30,"https://example.test",'+JSON.stringify(token)+')',scene.model),
  /identity changed after hover/);
 assert.equal(Object.hasOwn(scene.model.document,key(token)),false,'temporary page reference must be removed on refusal');
});

test('exact same live DOM element authorizes one press and consumes the identity',()=>{
 const scene=pageScene(),token=randomUUID();
 runInNewContext('('+PAGE_ELEMENT_ACTION+')("#target",null,"click","",'+JSON.stringify(token)+')',scene.model);
 assert.equal(runInNewContext('('+PAGE_VERIFY_POINTER_TARGET+')("#target",null,30,30,"https://example.test",'+JSON.stringify(token)+')',scene.model),true);
 assert.equal(Object.hasOwn(scene.model.document,key(token)),false);
 assert.throws(()=>runInNewContext('('+PAGE_VERIFY_POINTER_TARGET+')("#target",null,30,30,"https://example.test",'+JSON.stringify(token)+')',scene.model),
  /identity unavailable/,'replay must fail after proof is consumed');
});

test('explicit cleanup removes an abandoned identity',()=>{
 const scene=pageScene(),token=randomUUID();
 runInNewContext('('+PAGE_ELEMENT_ACTION+')("#target",null,"click","",'+JSON.stringify(token)+')',scene.model);
 assert.equal(runInNewContext('('+PAGE_DISCARD_POINTER_TARGET+')('+JSON.stringify(token)+')',scene.model),true);
 assert.equal(Object.hasOwn(scene.model.document,key(token)),false);
});

test('CDP hover failure does not press and cleans an abandoned identity',async()=>{
 const calls=[];
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelector')return {nodeId:25};
  calls.push(data.type);
  if(data.type==='mouseMoved')throw Error('CDP hover interrupted');
 }};
 const page=async(fn)=>{
  calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify');
 };
 await assert.rejects(dispatchVerifiedClick(session,
  {selector:'#target',needle:null,x:30,y:30,origin:'https://example.test',pointerToken:'test'},page),
  /CDP hover interrupted/);
 assert.deepEqual(calls,['mouseMoved','cleanup']);
});

test('successful click verifies before pressing without any extra cleanup evaluation',async()=>{
 const calls=[];
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelector')return {nodeId:25};
  calls.push(data.type);
 }};
 const page=async(fn)=>{calls.push(fn===PAGE_VERIFY_POINTER_TARGET?'verify':'cleanup')};
 await dispatchVerifiedClick(session,
  {selector:'#target',needle:null,x:30,y:30,origin:'https://example.test',pointerToken:'token'},page);
 assert.deepEqual(calls,['mouseMoved','verify','mousePressed','mouseReleased']);
});

test('post-hover identity refusal does not emit any mouse press or release',async()=>{
 const calls=[];
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelector')return {nodeId:25};
  calls.push(data.type);
 }};
 const page=async(fn)=>{
  calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify');
  if(fn===PAGE_VERIFY_POINTER_TARGET)throw Error('Pointer target identity changed after hover');
 };
 await assert.rejects(dispatchVerifiedClick(session,
  {selector:'#target',needle:null,x:30,y:30,origin:'https://example.test',pointerToken:'token'},page),
  /identity changed after hover/);
 assert.deepEqual(calls,['mouseMoved','verify','cleanup']);
});


test('ambiguous CDP release does not retry the press and discards identity',async()=>{
 const calls=[];
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelector')return {nodeId:25};
  calls.push(data.type);
  if(data.type==='mouseReleased')throw Error('release acknowledgement lost');
 }};
 const page=async(fn)=>{calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify')};
 await assert.rejects(dispatchVerifiedClick(session,
  {selector:'#target',needle:null,x:30,y:30,origin:'https://example.test',pointerToken:'token'},page),
  /release acknowledgement lost/);
 assert.deepEqual(calls,['mouseMoved','verify','mousePressed','mouseReleased','cleanup'],
  'never repeat an already-pressed mouse action on uncertain acknowledgement');
});

test('page-owned DOM proof cannot override independent Chromium selector-node identity',async()=>{
 const calls=[];
 let reads=0;
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelector'){
   calls.push('cdp-selector');
   return {nodeId:++reads===1?140:141};
  }
  calls.push(data.type);
 }};
 // Simulates a page script forging the document expando used by the
 // earlier proof. Trusted page evaluation now reports a false success.
 const forgedPageProof=async fn=>{calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify');return true};
 await assert.rejects(dispatchVerifiedClick(session,
  {selector:'#target',needle:null,x:30,y:30,origin:'https://example.test',pointerToken:'token'},forgedPageProof),
  /CDP selector target changed after hover/);
 assert.equal(calls.includes('mousePressed'),false);
 assert.equal(calls.includes('mouseReleased'),false);
 assert.equal(reads,2);
});


test('CDP text-only click pins and releases the same native DOM node',async()=>{
 const calls=[];
 let reads=0;
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='Runtime.evaluate'){
   assert.match(data.expression,/Text locator|function\(needle|Safe text/i);
   assert.equal(data.returnByValue,false);
   calls.push('evaluate');
   return {result:{type:'object',subtype:'node',objectId:'text-'+(++reads)}};
  }
  if(method==='DOM.requestNode'){calls.push('resolve');return {nodeId:34};}
  if(method==='Runtime.releaseObject'){calls.push('release');return {};}
  calls.push(data.type);
 }};
 const verify=async fn=>{calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify')};
 await dispatchVerifiedClick(session,
  {selector:null,needle:'Safe text target',x:30,y:30,origin:'https://example.test',
   pointerToken:'pointer-test'},verify);
 assert.deepEqual(calls,[
  'evaluate','resolve','release','mouseMoved','verify',
  'evaluate','resolve','release','mousePressed','mouseReleased']);
});

test('forged page proof cannot authorize a swapped text-only CDP node',async()=>{
 const calls=[];
 let reads=0;
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='Runtime.evaluate')return {
   result:{type:'object',subtype:'node',objectId:'text-'+(++reads)},
  };
  if(method==='DOM.requestNode'){calls.push('resolve');return {nodeId:reads===1?81:82};}
  if(method==='Runtime.releaseObject'){calls.push('release');return {};}
  calls.push(data.type);
 }};
 const forged=async fn=>{calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify');return true};
 await assert.rejects(dispatchVerifiedClick(session,
  {selector:null,needle:'Safe text target',x:30,y:30,origin:'https://example.test',
   pointerToken:'pointer-test'},forged),
  /CDP text target changed after hover/);
 assert.deepEqual(calls,[
  'resolve','release','mouseMoved','verify','resolve','release','cleanup']);
});

test('text-only click fails closed if CDP node resolution fails',async()=>{
 const calls=[];
 const session={async send(method,data){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='Runtime.evaluate')return {
   result:{type:'object',subtype:'node',objectId:'node-handle'},
  };
  if(method==='DOM.requestNode')throw Error('CDP detached node');
  if(method==='Runtime.releaseObject'){calls.push('release');return {};}
  calls.push(data?.type||method);
 }};
 const verify=async fn=>{calls.push(fn===PAGE_DISCARD_POINTER_TARGET?'cleanup':'verify')};
 await assert.rejects(dispatchVerifiedClick(session,
  {selector:null,needle:'Safe text target',x:30,y:30,origin:'https://example.test',
   pointerToken:'pointer-test'},verify),
  /CDP text target unavailable; click suppressed/);
 assert.deepEqual(calls,['release','cleanup']);
});
