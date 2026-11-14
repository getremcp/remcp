import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {PAGE_VERIFY_POINTER_TARGET} from '../src/extended/browser-pointer-guard.mjs';
import {executeBrowserWorkflow} from '../src/extended/browser-workflow.mjs';

function scene({blocked=false,shifted=false,duplicate=false}={}){
 const target={isConnected:true,disabled:false,
  getAttribute(){return null},closest(){return null},
  getBoundingClientRect(){return {left:shifted?70:10,top:10,right:shifted?110:50,bottom:50}},
  contains(){return false},
 };
 const other={};
 return {
  location:{origin:'https://example.test'},
  document:{
   querySelectorAll(){return duplicate?[target,other]:[target]},
   elementFromPoint(){return blocked?other:target},
  },
 };
}

const run=(model,args=['#safe',null,30,30,'https://example.test'])=>
 runInNewContext('('+PAGE_VERIFY_POINTER_TARGET+')(...'+JSON.stringify(args)+')',model);

test('stable hover target remains clickable after pointer movement',()=>{
 assert.equal(run(scene()),true);
});

test('new overlay, element movement and selector duplication abort before mouse press',()=>{
 for(const model of [scene({blocked:true}),scene({shifted:true}),scene({duplicate:true})]){
  assert.throws(()=>run(model),/Pointer target .* after hover|Pointer target selector changed/);
 }
 assert.throws(()=>run({...scene(),location:{origin:'https://other.test'}}),
  /Pointer target origin changed/);
});

test('workflow does not press or release after hover invalidates target',async()=>{
 const calls=[];
 const session={async send(method,params){
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.querySelector')return {nodeId:25};
  calls.push(method==='Input.dispatchMouseEvent'?params.type:method);
  if(method==='Runtime.evaluate'){
   if(params.expression.includes('PAGE_VERIFY_POINTER_TARGET')||
      params.expression.includes('Pointer target obstructed after hover'))
     return {exceptionDetails:{text:'Pointer target obstructed after hover; click suppressed'}};
   if(params.expression==='location.href')
     return {result:{value:'https://example.test/path'}};
   return {result:{value:{x:10,y:10,width:40,height:40}}};
  }
  return {};
 }};
 await assert.rejects(executeBrowserWorkflow(session,[{action:'click',selector:'#safe'}],{
  expectedOrigin:'https://example.test',
  pageElementAction:'function(){return {x:10,y:10,width:40,height:40}}',
 }),/Browser workflow stopped at step 1/);
 assert.equal(calls.includes('mouseMoved'),true);
 assert.equal(calls.includes('mousePressed'),false);
 assert.equal(calls.includes('mouseReleased'),false);
});
