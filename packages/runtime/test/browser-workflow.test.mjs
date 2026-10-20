import { runInNewContext } from 'node:vm';
import { PAGE_ELEMENT_ACTION, PAGE_SCROLL_ACTION } from '../src/extended/browser-actions.mjs';
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


test('browser workflow origin is fixed for one task, without leaking target URLs', async () => {
  const { assertWorkflowOrigin } = await import('../src/extended/browser-workflow.mjs');
  assert.equal(assertWorkflowOrigin(null, 'about:blank'), 'null');
  assert.equal(assertWorkflowOrigin('https://example.com', 'https://example.com/next?q=1'), 'https://example.com');
  assert.throws(
    () => assertWorkflowOrigin('https://example.com', 'https://other.example.net/credential'),
    error => error.message === 'Browser workflow origin changed' && !error.message.includes('credential'),
  );
  assert.throws(
    () => assertWorkflowOrigin('null', 'not a URL'),
    /origin could not be verified/,
  );
});

test('cross-origin redirect after a completed field edit blocks every later edit', async () => {
  const secret='highly-confidential-form-value';
  const steps=validate([
    {action:'set_value',selector:'#first',value:secret},
    {action:'set_value',selector:'#second',value:'do not write'},
  ]);
  let locationReads=0;
  let writes=0;
  const mock={async send(method, payload) {
    assert.equal(method, 'Runtime.evaluate');
    if (payload.expression === 'location.href') {
      locationReads++;
      return {result:{value:locationReads===1?'about:blank':'https://unexpected.example.test/redirect'}};
    }
    if (payload.expression.includes('workflow_origin_changed')) {
      writes++;
      return {result:{value:true}};
    }
    throw new Error('unexpected CDP operation');
  }};
  await assert.rejects(
    executeBrowserWorkflow(mock, steps, {pageElementAction:'function(){return true}',pageFillForm:'function(){return true}'}),
    error=>error.message.includes('step 2') && error.message.includes('1 steps completed') &&
      !error.message.includes(secret) && !error.message.includes('unexpected.example.test'),
  );
  assert.equal(writes,1,'second field cannot be written after cross-origin navigation');
});

test('origin is checked in the same page-evaluation as a write to avoid a redirect race', async () => {
  const steps=validate([{action:'set_value',selector:'#account',value:'private-account'}]);
  const statements=[];
  const mock={async send(method,payload){
    assert.equal(method,'Runtime.evaluate');
    if(payload.expression==='location.href')return {result:{value:'about:blank'}};
    statements.push(payload.expression);
    assert.throws(
      ()=>runInNewContext(payload.expression,{
        location:{origin:'https://unrelated.example.test'},
      }),
      /workflow_origin_changed/,
    );
    throw new Error('workflow_origin_changed');
  }};
  await assert.rejects(
    executeBrowserWorkflow(mock,steps,{pageElementAction:'function(){return true}',pageFillForm:'function(){return true}'}),
    error=>error.message.includes('step 1') && !error.message.includes('private-account'),
  );
  assert.equal(statements.length,1);
  assert.ok(statements[0].includes('location.origin'));
});

test('workflow wait never treats an element on a redirected origin as a match', async () => {
  const steps=validate([{action:'wait_for',condition:'selector',selector:'#confirmed',timeout_ms:150}]);
  const mock={async send(method,payload){
    if(payload.expression==='location.href')return {result:{value:'about:blank'}};
    return {result:{value:{url:'https://other.example.test/receipt',matched:true}}};
  }};
  await assert.rejects(
    executeBrowserWorkflow(mock,steps,{}),
    error=>error.message.includes('step 1') && error.message.includes('Condition not satisfied') &&
      !error.message.includes('other.example.test'),
  );
});

test('failed batched workflow warns about possible partial writes without exposing entered values', async () => {
  const secret='private-batch-value-sentinel';
  const steps=validate([{action:'fill_form',fields:[
    {selector:'#first',value:secret},{selector:'#second',value:'next'},
  ]}]);
  const mock={async send(_method,payload) {
    if(payload.expression==='location.href')return {result:{value:'about:blank'}};
    throw new Error('Form field changed during fill; 1 field may be modified '+secret);
  }};
  await assert.rejects(
    executeBrowserWorkflow(mock,steps,{pageFillForm:'function(){return true}'}),
    error=>error.message.includes('step 1') &&
      /partial|may have been modified/i.test(error.message) &&
      /inspect/i.test(error.message) && !error.message.includes(secret),
  );
});


test('explicit stale selector never silently falls back to a visible text match', () => {
  const other={
    tagName:'BUTTON',textContent:'Delete all',value:'',scrollIntoView(){},focus(){},
    matches(){return false;},
    getBoundingClientRect(){return {x:0,y:0,width:50,height:20};},
    getClientRects(){return [{x:0,y:0,width:50,height:20}];},
    contains(){return false;},
  };
  const fake={document:{
    querySelector(){return null;},
    querySelectorAll(){return [other];},
    elementFromPoint(){return other;},
  }};
  const invoke=(selector,needle,action='click')=>
    runInNewContext('('+PAGE_ELEMENT_ACTION+')('+JSON.stringify(selector)+','+
      JSON.stringify(needle)+','+JSON.stringify(action)+',"")',fake);
  assert.throws(()=>invoke('#missing','Delete all'),/Element not found/);
  assert.throws(()=>invoke('#missing','Delete all','set_value'),/Element not found/);
  assert.equal(invoke(null,'Delete all').tag,'button','text-only legacy lookup remains valid');
});

test('explicit stale scroll selector never redirects scroll to another text match', () => {
  const scroller={scrollTop:0,scrollLeft:0,scrollWidth:700,clientWidth:100,
    scrollHeight:900,clientHeight:100,parentElement:null,tagName:'DIV'};
  const other=scroller; other.textContent='Delete all';
  const page={scrollTop:0,scrollLeft:0,tagName:'HTML'};
  const fake={document:{
    querySelector(){return null;},
    querySelectorAll(){return [other];},
    documentElement:page,scrollingElement:page,
  },getComputedStyle(){return {overflowX:'auto',overflowY:'auto'};}};
  const run=(selector,needle)=>runInNewContext('('+PAGE_SCROLL_ACTION+')('+JSON.stringify(selector)+','+
    JSON.stringify(needle)+',0,120)',fake);
  assert.throws(()=>run('#missing','Delete all'),/Element not found/);
  assert.equal(scroller.scrollTop,0);
  assert.equal(run(null,'Delete all').target,'div');
});
