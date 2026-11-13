import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {PAGE_FILL_FORM, PAGE_VERIFY_FORM,validateFormFields} from '../src/extended/browser-actions.mjs';

function input(type='text'){
 const node={tagName:'INPUT',type,value:'',checked:false,isConnected:true,
   disabled:false,readOnly:false,
   getClientRects:()=>[{width:10,height:20}],matches:()=>false,
   dispatchEvent:()=>{},};
 return node;
}
function env(elements) {
 return {document:{
   querySelector:s=>elements[s]?.[0]||null,
   querySelectorAll:s=>elements[s]||[],
 },Event:class {constructor(type){this.type=type;}}};
}
function execute(functionSource,fields,elements){
 return runInNewContext('('+functionSource+')('+JSON.stringify(fields)+')',env(elements));
}

test('regression: controlled UI overrides a DOM mutation; never report verified success',()=>{
 const controlled=input();
 controlled.dispatchEvent=function(ev){ if(ev.type==='change')this.value='previous'; };
 assert.throws(()=>execute(PAGE_FILL_FORM,[{selector:'#name',value:'requested'}],{'#name':[controlled]}),
   /verification|readback|changed|rerender/i);
 assert.equal(controlled.value,'previous');
});

test('regression: a detached/replaced target cannot be counted as a successful write',()=>{
 const element=input();
 const successor=input();
 const nodes={'#name':[element]};
 element.dispatchEvent=function(event){
  if(event.type==='input'){element.isConnected=false;nodes['#name']=[successor];}
 };
 assert.throws(()=>execute(PAGE_FILL_FORM,[{selector:'#name',value:'write'}],nodes),
   /detached|rerender|changed|verification/i);
 assert.equal(successor.value,'');
});

test('regression: two matching selector targets must fail before the first write',()=>{
 const first=input(),second=input();
 assert.throws(()=>execute(PAGE_FILL_FORM,[{selector:'input',value:'private'}],{input:[first,second]}),
   /ambiguous|unique|multiple/i);
 assert.equal(first.value,'');
 assert.equal(second.value,'');
});

test('independent final verification catches async changes without returning private values',()=>{
 const email=input('email');email.value='visible@example.invalid';
 const fields=validateFormFields([{selector:'#email',value:'visible@example.invalid',expected_type:'email'}]);
 const result=execute(PAGE_VERIFY_FORM,fields,{'#email':[email]});
 assert.equal(result.verified,true);
 assert.equal(result.count,1);
 assert.doesNotMatch(JSON.stringify(result),/visible@example/);
 email.value='stale@example.invalid';
 assert.throws(()=>execute(PAGE_VERIFY_FORM,fields,{'#email':[email]}),/verification/i);
});

test('batch succeeds for typed inputs and checkbox without exposing entered data',()=>{
 const email=input('email'), box=input('checkbox');
 const fields=validateFormFields([{selector:'#email',value:'confidential@example.invalid',expected_type:'email'},
   {selector:'#box',value:true,expected_type:'checkbox'}]);
 const elements={'#email':[email],'#box':[box]};
 const write=execute(PAGE_FILL_FORM,fields,elements);
 assert.equal(write.filled,2);
 assert.equal(write.verified,true);
 assert.equal(execute(PAGE_VERIFY_FORM,fields,elements).verified,true);
 assert.equal(email.value,'confidential@example.invalid');
 assert.equal(box.checked,true);
 assert.doesNotMatch(JSON.stringify(write),/confidential/);
});

test('input type drift must fail final verification',()=>{
 const el=input('text'),fields=[{selector:'#name',value:'test',expected_type:'text'}];
 el.value='test';el.type='password';
 assert.throws(()=>execute(PAGE_VERIFY_FORM,fields,{'#name':[el]}),/kind changed|verification/i);
});

test('origin binding prevents writes and post-write confirmation on redirected pages',()=>{
 const el=input('text');
 const fields=[{selector:'#email',value:'private@example.invalid'}];
 const scope={...env({'#email':[el]}),location:{origin:'https://unexpected.invalid'}};
 for(const fn of [PAGE_FILL_FORM,PAGE_VERIFY_FORM]){
   assert.throws(()=>runInNewContext('('+fn+')('+JSON.stringify(fields)+',"https://approved.invalid")',scope),
     /Form origin changed/);
 }
 assert.equal(el.value,'','cross-origin form target must not be edited');
});
