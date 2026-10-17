import { runInNewContext } from 'node:vm';
import { PAGE_ELEMENT_ACTION } from '../src/extended/browser-actions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserWorkflow, executeBrowserWorkflow } from '../src/extended/browser-workflow.mjs';
import { validateFormFields } from '../src/extended/browser-actions.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

const validate = steps => validateBrowserWorkflow(steps,{validateFormFields});

test('workflow validates every step before any browser action', () => {
  assert.equal(validate([{action:'focus',selector:'#first'}]).length,1);
  assert.throws(()=>validate([]),/1 to 12/);
  assert.throws(()=>validate(Array(13).fill({action:'click',selector:'#ok'})),/1 to 12/);
  assert.throws(()=>validate([{action:'evaluate',expression:'document.cookie'}]),/Unsupported/);
  assert.throws(()=>validate([{action:'click',selector:''}]),/CSS selector/);
  assert.throws(()=>validate([{action:'set_value',selector:'#password'}]),/input requires/);
  assert.throws(()=>validate([{action:'set_value',selector:'#password',value:'a'.repeat(16385)}]),/exceeds/);
  assert.throws(()=>validate([{action:'wait_for',condition:'script',text:'x'}]),/Unsupported/);
  assert.throws(()=>validate([{action:'wait_for',condition:'selector'}]),/criterion/);
  assert.throws(()=>validate([{action:'wait_for',condition:'selector',selector:'#a',timeout_ms:4200}]),/100-4000/);
  assert.throws(()=>validate([{action:'fill_form',fields:[{selector:'#a'}]}]),/CSS selector/);
});

test('workflow JSON schema is bounded and part of existing browser_action', () => {
  const browser = extendedToolDefinitions.find(x=>x.name==='browser_action');
  assert.ok(browser.inputSchema.properties.action.enum.includes('workflow'));
  assert.equal(browser.inputSchema.properties.steps.maxItems,12);
  const schema=browser.inputSchema.properties.steps.items.properties;
  assert.ok(!schema.expression,'no raw JS in workflow');
  assert.ok(!schema.path,'no file uploads in workflow');
});

test('workflow reports partial actions without echoing secrets', async () => {
  const injected='password\u00a3secret\u{1F30D}';
  const steps=validate([
    {action:'set_value',selector:'#password',value:injected},
    {action:'wait_for',condition:'selector',selector:'#never',timeout_ms:100},
  ]);
  const mock={async send(method,payload){
    if(method!=='Runtime.evaluate')throw Error('unexpected method '+method);
    if(payload.expression==='location.href')return {result:{value:'about:blank'}};
    if(payload.expression.startsWith('({url:location.href,matched:'))return {result:{value:{url:'about:blank',matched:false}}};
    if(payload.expression.includes('document.querySelector("#never")'))return {result:{value:false}};
    return {result:{value:{tag:'input',value:injected}}};
  }};
  await assert.rejects(
    executeBrowserWorkflow(mock,steps,{pageElementAction:'function(){return true}',pageFillForm:'function(){return true}'}),
    error=>error.message.includes('step 2') && error.message.includes('1 steps completed') &&
      !error.message.includes(injected),
  );
});

test('workflow completes a matching wait without fixed sleep', async () => {
  const steps=validate([{action:'wait_for',condition:'load',timeout_ms:200}]);
  const mock={async send(method,payload){
    return {result:{value:payload.expression==='location.href'?'about:blank':{url:'about:blank',matched:true}}};
  }};
  const result=await executeBrowserWorkflow(mock,steps,{});
  assert.equal(result.completed,1);
  assert.equal(result.steps[0].action,'wait_for');
  assert.ok(result.elapsed_ms<150);
});


test('fragmented inline anchor click targets a visible fragment, never a covered input', () => {
  const input={tagName:'INPUT'};
  const link={
    tagName:'A', scrollIntoView(){},
    getBoundingClientRect(){return {x:0,y:0,width:1000,height:110};},
    getClientRects(){return [{x:0,y:0,width:1000,height:40},{x:5,y:90,width:80,height:19}];},
    matches(){return false;},contains(){return false;},
  };
  const doc={
    querySelector(){return link;},
    elementFromPoint(x,y){return y<60?input:link;},
  };
  const evaluate=()=>runInNewContext('('+PAGE_ELEMENT_ACTION+')("#nav",null,"click","")',{document:doc});
  const result=evaluate();
  assert.equal(result.x,5);
  assert.equal(result.y,90);
  assert.equal(result.width,80);
  doc.elementFromPoint=()=>input;
  assert.throws(evaluate,/no unobstructed clickable fragment/);
});

test('semantic element results redact credential input values', () => {
  const password={
    tagName:'INPUT', value:'dont-leak-me',scrollIntoView(){},focus(){},
    matches(selector){return selector.includes('input[type="password"]');},
    getBoundingClientRect(){return {x:0,y:0,width:80,height:20};},
  };
  const result=runInNewContext('('+PAGE_ELEMENT_ACTION+')("#password",null,"focus","")',
    {document:{querySelector:()=>password}});
  assert.equal(result.value,'');
  assert.equal(JSON.stringify(result).includes('dont-leak-me'),false);
});
