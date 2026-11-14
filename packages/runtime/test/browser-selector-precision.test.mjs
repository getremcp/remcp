import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {PAGE_ELEMENT_ACTION,PAGE_SCROLL_ACTION} from '../src/extended/browser-actions.mjs';

function elements(count=2){
 const calls=[];
 const items=Array.from({length:count},(_,i)=>({
  tagName:'BUTTON',value:'',isConnected:true,
  focus(){calls.push('focus:'+i)},
  scrollIntoView(){calls.push('scrollIntoView:'+i)},
  dispatchEvent(){calls.push('dispatch:'+i)},
  matches(){return false},
  contains(){return false},
  getBoundingClientRect(){return {x:i*100,y:30,width:80,height:30}},
  getClientRects(){return [{x:i*100,y:30,width:80,height:30}]},
 }));
 return {calls,items,document:{
  querySelectorAll(){return items},
  querySelector(){throw new Error('first-match fallback is unsafe')},
  elementFromPoint(x){return items.find((_,i)=>x>=i*100&&x<i*100+80)},
 }};
}

test('ambiguous CSS selectors fail before clicks, input, focus or scroll',()=>{
 for(const action of ['click','focus','set_value','select','type_clear']){
  const {document,calls}=elements();
  assert.throws(()=>runInNewContext('('+PAGE_ELEMENT_ACTION+')("button","",'+JSON.stringify(action)+',"unsafe")',
    {document,Event:class Event{}}),/selector missing or ambiguous/);
  assert.deepEqual(calls,[],action+' must have no side effects');
 }
 const {document,calls}=elements();
 assert.throws(()=>runInNewContext('('+PAGE_SCROLL_ACTION+')("button","",0,180)',{document}),
  /Scroll selector missing or ambiguous/);
 assert.deepEqual(calls,[]);
});

test('an exact CSS selector preserves one-action fast path and hit-test checks',()=>{
 const {document,calls,items}=elements(1);
 const outcome=runInNewContext('('+PAGE_ELEMENT_ACTION+')("button","", "click", "")',{document});
 assert.equal(outcome.x,0);
 assert.equal(outcome.width,80);
 assert.deepEqual(calls,['scrollIntoView:0']);
 document.elementFromPoint=()=>null;
 assert.throws(()=>runInNewContext('('+PAGE_ELEMENT_ACTION+')("button","", "click", "")',{document}),
  /unobstructed clickable fragment/);
 assert.equal(items.length,1);
});

test('missing CSS selector does not fall back to broad matching',()=>{
 const {document}=elements(0);
 assert.throws(()=>runInNewContext('('+PAGE_ELEMENT_ACTION+')("#gone","danger", "click", "")',{document}),
   /selector missing or ambiguous/);
});


test('text locator chooses the exact interactive button, not its page container',()=>{
 const click=[];const make=(tag,text,x,width)=>({
  tagName:tag,innerText:text,textContent:text,isConnected:true,disabled:false,
  children:[],getAttribute(){return null;},closest(){return null;},
  getClientRects(){return [{x,y:15,width,height:35}]},
  getBoundingClientRect(){return {x,y:15,width,height:35}},
  scrollIntoView(){click.push(tag)},matches(){return false},contains(){return false},
 });
 const body=make('BODY','Settings Settings & Privacy',0,700);
 const exact=make('BUTTON','Settings',30,130);
 const fuzzy=make('BUTTON','Settings & Privacy',200,220);
 const document={
  querySelectorAll(selector){
   if(selector==='*')return [body,exact,fuzzy];
   return [exact,fuzzy];
  },
  elementFromPoint(x){return x<180?exact:fuzzy;},
 };
 const result=runInNewContext('('+PAGE_ELEMENT_ACTION+')(null,"Settings","click","")',{document});
 assert.equal(result.x,30,'must choose the exact button rather than a parent or substring');
 assert.deepEqual(click,['BUTTON']);
});

test('multiple equal visible text targets refuse to click or scroll',()=>{
 let mutations=0;
 const make=(x)=>({
  tagName:'BUTTON',innerText:'Settings',isConnected:true,disabled:false,
  children:[],getAttribute(){return null;},closest(){return null;},
  getClientRects(){return [{x,y:15,width:90,height:30}]},
  getBoundingClientRect(){return {x,y:15,width:90,height:30}},
  scrollIntoView(){mutations++},matches(){return false},contains(){return false},
 });
 const first=make(10),second=make(130);
 const document={
  querySelectorAll(selector){return selector==='*'?[{innerText:'Settings',tagName:'BODY'},first,second]:[first,second];},
  elementFromPoint(x){return x<100?first:second;},
 };
 assert.throws(()=>runInNewContext('('+PAGE_ELEMENT_ACTION+')(null,"Settings","click","")',{document}),
  /text locator.*ambiguous/i);
 assert.throws(()=>runInNewContext('('+PAGE_SCROLL_ACTION+')(null,"Settings",0,150)',{document}),
  /text locator.*ambiguous/i);
 assert.equal(mutations,0,'ambiguous text targets must have no scroll or focus side effects');
});


test('disabled exact text control blocks instead of clicking a fuzzy alternative',()=>{
 const calls=[];
 const item=(name,disabled,x)=>({
  tagName:'BUTTON',innerText:name,textContent:name,disabled,isConnected:true,
  getAttribute(){return null;},closest(){return null;},
  getClientRects(){return [{x,y:10,width:100,height:30}]},
  scrollIntoView(){calls.push(name)},
  getBoundingClientRect(){return {x,y:10,width:100,height:30}},
  matches(){return false},contains(){return false},
 });
 const exact=item('Settings',true,10),fuzzy=item('Settings advanced',false,120);
 const document={querySelectorAll(){return [exact,fuzzy]},elementFromPoint(){return fuzzy}};
 assert.throws(()=>runInNewContext('('+PAGE_ELEMENT_ACTION+')(null,"Settings","click","")',{document}),
   /exact target is unavailable/);
 assert.deepEqual(calls,[],'never fall back to a different actionable control');
});
