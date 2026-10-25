import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PAGE_FILL_FORM,validateFormFields } from '../src/extended/browser-actions.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

const input = (type='text') => ({
  tagName:'INPUT',type,value:'',checked:false,
  getClientRects:()=>[{width:10,height:20}],
  matches:()=>false,
  dispatchEvent:()=>{},
});
function run(fields, elements) {
  return runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+')',{
    document:{querySelector(selector){return elements[selector]||null;}},
    Event:class {constructor(type){this.type=type;}},
  });
}
test('native Form Map fingerprint is optional and survives validation without exposing values',()=>{
  assert.deepEqual(validateFormFields([{selector:' #email ',value:'sensitive',
    expected_tag:'input',expected_type:'email'}]),
  [{selector:'#email',value:'sensitive',expected_tag:'input',expected_type:'email'}]);
  assert.throws(()=>validateFormFields([{selector:'#email',value:'secret',expected_type:'evil'}]),
    /Unsupported expected_type/);
  assert.throws(()=>validateFormFields([{selector:'#email',value:'secret',expected_tag:'form'}]),
    /Unsupported expected_tag/);
  assert.throws(()=>validateFormFields([{selector:'#same',value:'one'},
    {selector:' #same ',value:'two'}]),/Duplicate CSS selector/);
});
test('guarded batch rejects stale selectors before modifying any earlier fields',()=>{
  const first=input('text'), changed=input('checkbox');
  const fields=validateFormFields([
    {selector:'#first',value:'would-be-written',expected_tag:'input',expected_type:'text'},
    {selector:'#second',value:'secret',expected_tag:'input',expected_type:'email'},
  ]);
  assert.throws(()=>run(fields,{'#first':first,'#second':changed}),/kind changed/);
  assert.equal(first.value,'');
  assert.equal(changed.checked,false);
});
test('guarded batch rejects duplicate elements behind different selectors',()=>{
  const shared=input('text');
  assert.throws(()=>run([
    {selector:'#first',value:'private',expected_type:'text'},
    {selector:'input:first-child',value:'private2',expected_type:'text'},
  ],{'#first':shared,'input:first-child':shared}),/Duplicate form field target/);
  assert.equal(shared.value,'');
});
test('React-like rerender after the first input event blocks writes to detached controls',()=>{
  const first=input('text'),second=input('email');
  first.dispatchEvent=event=>{if(event.type==='input')second.isConnected=false;};
  second.isConnected=true;
  assert.throws(()=>run([
    {selector:'#first',value:'new state',expected_tag:'input',expected_type:'text'},
    {selector:'#second',value:'never-set',expected_tag:'input',expected_type:'email'}
  ],{'#first':first,'#second':second}),/rerendered during the batch/);
  assert.equal(second.value,'');
  assert.equal(first.value,'new state');
});
test('matching fingerprints fill a batch, without returning values',()=>{
  const email=input('email'),checkbox=input('checkbox');
  const result=run(validateFormFields([
    {selector:'#email',value:'secret@example.invalid',expected_tag:'input',expected_type:'email'},
    {selector:'#agree',value:true,expected_tag:'input',expected_type:'checkbox'}
  ]),{'#email':email,'#agree':checkbox});
  assert.equal(result.filled,2);
  assert.equal(email.value,'secret@example.invalid');
  assert.equal(checkbox.checked,true);
  assert.equal(JSON.stringify(result).includes('secret@example.invalid'),false);
});
test('both direct and workflow schemas advertise the optional safeguards',()=>{
  const props=extendedToolDefinitions.find(t=>t.name==='browser_action').inputSchema.properties;
  const workflow=props.steps.items.properties.fields.items.properties;
  const direct=props.fields.items.properties;
  for(const fieldProps of [workflow,direct]) {
    assert.ok(fieldProps.expected_tag.enum.includes('input'));
    assert.ok(fieldProps.expected_type.enum.includes('checkbox'));
  }
});
