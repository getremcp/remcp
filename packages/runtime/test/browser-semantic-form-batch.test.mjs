import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {PAGE_FILL_FORM,validateFormFields} from '../src/extended/browser-actions.mjs';

function control(label,initial='',type='text'){
 const value={tagName:'INPUT',type,value:initial,checked:false,
   labels:[{textContent:label}],isConnected:true,
   getClientRects(){return [{width:40,height:20}]},
   getAttribute(){return null},
   matches(){return false},
   dispatchEvent(){},
 };
 return value;
}
function execute(fields,controls,{origin='https://crm.example'}={}){
 return runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+','+JSON.stringify(origin)+')',{
  document:{
   querySelectorAll(selector){
    if(selector==='input,textarea,select')return Object.values(controls);
    if(selector.startsWith('#'))return controls[selector]?[controls[selector]]:[];
    return [];
   },
   querySelector(selector){return controls[selector]||null},
   getElementById(){return null},
  },
  location:{origin:'https://crm.example'},
  Event:class{constructor(name){this.type=name}},
 });
}
test('semantic label fills exact field and verifies without returning values',()=>{
 const a=control('Email','before@example.test','email');
 const r=execute(validateFormFields([{label:'Email',value:'after@example.test',expected_value:'before@example.test',expected_tag:'input',expected_type:'email'}]),{'#mail':a});
 assert.equal(r.filled,1);
 assert.equal(r.verified,true);
 assert.equal(r.submitted,false);
 assert.equal(a.value,'after@example.test');
 assert.ok(!JSON.stringify(r).includes('after@example.test'));
});
test('CAS and ambiguous labels reject all fields before any mutation',()=>{
 const a=control('Email','old'),b=control('Email','other');
 assert.throws(()=>execute(validateFormFields([{label:'Email',value:'secret'}]),{'#a':a,'#b':b}),/not editable/);
 assert.equal(a.value,'old');assert.equal(b.value,'other');
 const name=control('Name','original'),email=control('Email','old');
 const fields=validateFormFields([{label:'Name',value:'not_written'},{label:'Email',value:'new',expected_value:'stale'}]);
 assert.throws(()=>execute(fields,{'#name':name,'#mail':email}),/changed before write/);
 assert.equal(name.value,'original');
});
test('origin changes and mismatched readback stop execution',()=>{
 const a=control('Email','old');
 assert.throws(()=>execute([{label:'Email',value:'secret'}],{'#mail':a},{origin:'https://other.example'}),/origin changed/);
 assert.equal(a.value,'old');
 a.dispatchEvent=event=>{if(event.type==='input')a.value='managed_by_react'};
 assert.throws(()=>execute([{label:'Email',value:'proposed'}],{'#mail':a}),/readback mismatch/);
});
test('input guard requires unique target, typed old value and bounded labels',()=>{
 assert.throws(()=>validateFormFields([{selector:'#a',label:'Name',value:'x'}]),/one CSS selector/);
 assert.throws(()=>validateFormFields([{label:'Name',value:'x',expected_value:12}]),/Expected form/);
 assert.throws(()=>validateFormFields([{label:'Name\nadmin',value:'x'}]),/one CSS selector/);
 assert.throws(()=>validateFormFields([{label:'Name',value:'x'},{label:' name ',value:'y'}]),/Duplicate/);
});
