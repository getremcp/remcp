import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeComputedStyle, summarizeBoxModel, inspectScopedStyles } from '../src/extended/browser-styles.mjs';
import { buildDevtoolsReport, browserDevtools } from '../src/extended/browser-devtools.mjs';

const raw=[
  {name:'display',value:'flex'}, {name:'overflow-x',value:'auto'},
  {name:'position',value:'absolute'}, {name:'z-index',value:'55'},
  {name:'opacity',value:'0.75'}, {name:'font-size',value:'14px'},
  {name:'padding-left',value:'12px'},
  {name:'background-image',value:'url(https://private.example/secret?k=token)'},
  {name:'content',value:'PRIVATE USER DETAILS'},
  {name:'font-family',value:'Sensitive Personal User'},
  {name:'--account-token',value:'SENSITIVE_PRIVATE_TOKEN'},
];
test('computed style returns only allowlisted enum and numeric values',()=>{
  const report=summarizeComputedStyle(raw);
  assert.deepEqual(report,{display:'flex',position:'absolute',overflowX:'auto',
    font_size_px:14,padding_left_px:12,opacity:.75,z_index:55});
  const json=JSON.stringify(report);
  for(const s of ['private.example','secret','PRIVATE','Sensitive Personal User'])
    assert.ok(!json.includes(s));
});
test('invalid CSS and non-pixel values cannot escape the style allowlist',()=>{
  const report=summarizeComputedStyle([
    {name:'display',value:'url(https://token.private)'},{name:'overflow-y',value:'visible !important'},
    {name:'height',value:'42%'},{name:'font-size',value:'calc(4px + var(--password))'},
    {name:'opacity',value:'Infinity'},{name:'z-index',value:'var(--private)'}
  ]);
  assert.deepEqual(report,{});
});
test('box model uses bounded numeric geometry only',()=>{
  assert.deepEqual(summarizeBoxModel({
    border:[1,2,21,2,21,12,1,12],
    content:[3,4,19,4,19,10,3,10],
    width:16,height:6
  }),{border:{x:1,y:2,width:20,height:10},content:{x:3,y:4,width:16,height:6},
    content_width_px:16,content_height_px:6});
  assert.equal(summarizeBoxModel({border:['x']}),null);
});
test('scoped CSS inspector uses native CDP commands and leaves no private data',async()=>{
  const calls=[];
  const session={send:async (method,params)=>{
    calls.push(method);
    if(method==='DOM.getDocument')return {root:{nodeId:1}};
    if(method==='DOM.querySelector')return {nodeId:7};
    if(method==='CSS.getComputedStyleForNode')return {computedStyle:raw};
    if(method==='DOM.getBoxModel')return {model:{border:[1,2,21,2,21,12,1,12],content:[1,2,21,2,21,12,1,12],width:20,height:10}};
    return {};
  }};
  const result=await inspectScopedStyles(session,'html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)');
  assert.equal(result.found,true);
  assert.equal(result.style.font_size_px,14);
  assert.equal(result.box.border.width,20);
  assert.deepEqual(calls,['DOM.enable','CSS.enable','DOM.getDocument','DOM.querySelector',
    'CSS.getComputedStyleForNode','DOM.getBoxModel','CSS.disable','DOM.disable']);
  assert.ok(!JSON.stringify(result).includes('private.example'));
  assert.ok(!JSON.stringify(result).includes('html:nth-of-type(1)'));
});
test('missing node returns found=false and always disables domains',async()=>{
  const calls=[];
  const result=await inspectScopedStyles({send:async method=>{
    calls.push(method);
    if(method==='DOM.getDocument')return {root:{nodeId:2}};
    if(method==='DOM.querySelector')return {nodeId:0};
    return {};
  }},'#nothing');
  assert.equal(result.found,false);
  assert.ok(calls.includes('CSS.disable')&&calls.includes('DOM.disable'));
});
test('scoped styles require selector and exact target; no tab URL is returned',async()=>{
  let calls=0;
  await assert.rejects(inspectScopedStyles({send(){calls++;}},'<script>'),/selector/);
  assert.equal(calls,0);
  await assert.rejects(browserDevtools({action:'styles',selector:'.form'}),/target_id/);
  await assert.rejects(browserDevtools({action:'styles',target_id:'any'}),/CSS selector/);
  const report=buildDevtoolsReport({id:'a',url:'https://private.example/reset?auth=secret'},
    'styles',{action:'styles',found:false});
  assert.equal(report.url,undefined);
});
