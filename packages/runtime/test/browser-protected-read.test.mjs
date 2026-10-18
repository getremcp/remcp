import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {endpointUrl} from '../src/extended/browser-endpoint.mjs';
import {safeAccessibilityValue,sensitiveAccessibilityDescendants,findExpression} from '../src/extended/browser-read.mjs';

test('CDP endpoint accepts safe URL objects without reverting to the default port',()=>{
  const url=new URL('http://127.0.0.1:19325/');
  assert.equal(endpointUrl(url).origin,url.origin);
  assert.equal(endpointUrl(url.href).origin,url.origin);
  assert.throws(()=>endpointUrl(new URL('https://example.com:19325/')),/loopback-only/);
  assert.throws(()=>endpointUrl(new URL('http://user:password@127.0.0.1:19325/')),/credentials/);
  assert.throws(()=>endpointUrl({href:url.href}),/endpoint must be/);
});

test('AX data in input-value subtrees is removed before producing snapshot diff',()=>{
  const nodes=[
    {nodeId:'root',role:{value:'RootWebArea'},childIds:['field','visible']},
    {nodeId:'field',role:{value:'textbox'},value:{value:'otp-sensitive'},name:{value:'Security code'},childIds:['container']},
    {nodeId:'container',role:{value:'generic'},childIds:['text']},
    {nodeId:'text',role:{value:'StaticText'},name:{value:'otp-sensitive'},childIds:['inline']},
    {nodeId:'inline',role:{value:'InlineTextBox'},name:{value:'otp-sensitive'}},
    {nodeId:'visible',role:{value:'StaticText'},name:{value:'Public page heading'}},
  ];
  const sensitive=sensitiveAccessibilityDescendants(nodes);
  for(const id of ['field','container','text','inline'])assert.equal(sensitive.has(id),true);
  assert.equal(sensitive.has('visible'),false);
  assert.equal(safeAccessibilityValue({role:{value:'textbox'},properties:[{name:'protected',value:{value:true}}],value:{value:'super-secret'}}),'');
  assert.equal(safeAccessibilityValue({role:{value:'StaticText'},value:{value:'regular text'}}),'regular text');
});

test('DOM locator hides ordinary OTP and token field values as well as password fields',()=>{
  const cases=[
    ['password','', '','','secret-one'],
    ['text','one-time-code','','','secret-two'],
    ['text','','access_token','','secret-three'],
    ['text','','','apiKey','secret-four'],
    ['text','','','username','ordinary-value'],
  ];
  for(const [type,autocomplete,name,id,value] of cases){
    const attrs={name,autocomplete,id};
    const el={
      tagName:'INPUT', type, value, disabled:false, parentElement:null,
      getAttribute:key=>attrs[key]||'',
      hasAttribute:()=>false,
      getBoundingClientRect:()=>({x:1,y:2,width:100,height:24}),
      getClientRects:()=>[{width:100,height:24}],
      innerText:'',textContent:'',outerHTML:'',
    };
    const sandbox={
      document:{querySelectorAll:()=>[el],documentElement:{}},
      getComputedStyle:()=>({visibility:'visible',display:'block'}),
      CSS:{escape:v=>v},
    };
    const match=runInNewContext(findExpression({selector:'input'}),sandbox);
    assert.equal(match.length,1);
    assert.equal(match[0].value,id==='username'?'ordinary-value':'');
  }
});
