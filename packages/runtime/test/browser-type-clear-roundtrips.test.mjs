import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { browserAction, PAGE_ELEMENT_ACTION } from '../src/extended/browser-actions.mjs';
import { productionBrowserSessions } from '../src/extended/browser-endpoint.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

function pageInput({ password = false, value = 'before' } = {}) {
  const events = [];
  const state = { value };
  const proto = {
    set value(next) { events.push('native-setter'); state.value = next; },
    get value() { return state.value; },
  };
  const el = Object.create(proto);
  el.tagName = 'INPUT';
  el.scrollIntoView = () => events.push('scroll');
  el.focus = () => events.push('focus');
  el.dispatchEvent = event => { events.push(event.type); return true; };
  el.getBoundingClientRect = () => ({x:0,y:0,width:100,height:25});
  el.matches = pattern => password && pattern.includes('input[type="password"]');
  return { el, state, events };
}

test('type_clear focuses before clearing with native setter and input/change events',()=>{
  const {el,state,events} = pageInput();
  const result = runInNewContext(
    '(' + PAGE_ELEMENT_ACTION + ')("#field",null,"type_clear","")',
    {document:{querySelector:()=>el},Event:class {constructor(type){this.type=type;}}},
  );
  assert.deepEqual(events,['scroll','focus','native-setter','input','change']);
  assert.equal(state.value,'');
  assert.equal(result.value,'');
  assert.equal(result.tag,'input');
});

test('type without clear does not mutate field value or trigger change events',()=>{
  const {el,state,events} = pageInput();
  runInNewContext('('+PAGE_ELEMENT_ACTION+')("#field",null,"type","")',
    {document:{querySelector:()=>el},Event:class {}});
  assert.equal(state.value,'before');
  assert.deepEqual(events,['scroll','focus']);
});

test('type_clear never exposes password contents or previous credential value',()=>{
  const {el,state,events} = pageInput({password:true,value:'sensitive-old-password'});
  const result=runInNewContext('('+PAGE_ELEMENT_ACTION+')("#secret",null,"type_clear","")',
    {document:{querySelector:()=>el},Event:class {constructor(type){this.type=type;}}});
  assert.equal(result.value,'');
  assert.equal(state.value,'');
  assert.deepEqual(events,['scroll','focus','native-setter','input','change']);
  assert.doesNotMatch(JSON.stringify(result),/sensitive-old-password/);
});

function cachedTarget(t) {
  const previousEnv = process.env.NODE_ENV;
  const previousAllowed = process.env.REMCP_BROWSER_ALLOWED_HOSTS;
  process.env.NODE_ENV = 'production';
  process.env.REMCP_BROWSER_ALLOWED_HOSTS = '93.184.215.14';
  const port = 19489;
  const endpoint = 'http://127.0.0.1:' + port;
  const targetId = 'type-clear-qa';
  const target = {id:targetId,url:'https://93.184.215.14/form',
    webSocketDebuggerUrl:'ws://127.0.0.1:'+port+'/devtools/page/'+targetId};
  const calls=[];
  let value='existing';
  const session={
    url:target.webSocketDebuggerUrl,closed:false,socket:{readyState:1},
    async send(method,params){
      if (method==='Runtime.evaluate') {
        const expression=params.expression;
        calls.push({method,expression});
        if(expression==='location.href')return {result:{value:'https://93.184.215.14/form'}};
        if(expression.includes('"type_clear"')) {value='';return {result:{value:{tag:'input',value:'',x:0,y:0,width:100,height:25}}};}
        if(expression.includes('"type"'))return {result:{value:{tag:'input',value,x:0,y:0,width:100,height:25}}};
        if(expression.includes('"read_value"'))return {result:{value:{tag:'input',value,x:0,y:0,width:100,height:25}}};
        throw Error('unexpected browser expression (no page data logged)');
      }
      if(method==='Input.insertText'){
        calls.push({method});
        value+=params.text;
        return {};
      }
      throw Error('unexpected CDP command '+method);
    },
    close(){this.closed=true;},
  };
  const key=endpoint+'|'+targetId;
  productionBrowserSessions.set(key,{
    session,target,targetId,guardInstalled:true,removeGuard(){},schedule(){},
  });
  t.after(()=>{
    if(previousEnv===undefined)delete process.env.NODE_ENV;
    else process.env.NODE_ENV=previousEnv;
    if(previousAllowed===undefined)delete process.env.REMCP_BROWSER_ALLOWED_HOSTS;
    else process.env.REMCP_BROWSER_ALLOWED_HOSTS=previousAllowed;
    productionBrowserSessions.clear();
  });
  return {endpoint,targetId,calls};
}

test('clear:true reuses one CDP page evaluation for focus+clear and verifies inserted text',async t=>{
  const fixture=cachedTarget(t);
  const result=await browserAction({
    endpoint:fixture.endpoint,target_id:fixture.targetId,
    action:'type',selector:'#field',text:'QA',clear:true,
  });
  assert.equal(result.structuredContent.result.value,'QA');
  const methods=fixture.calls.map(x=>x.method);
  assert.deepEqual(methods,[
    'Runtime.evaluate', // required initial URL safety check
    'Runtime.evaluate', // combined focus + clear
    'Input.insertText', // real Chromium text input
    'Runtime.evaluate', // verified field value
    'Runtime.evaluate', // required final URL safety check
  ]);
  assert.equal(fixture.calls.filter(x=>x.expression?.includes('"type_clear"')).length,1);
  assert.equal(fixture.calls.filter(x=>x.expression?.includes('"read_value"')).length,1);
});

test('clear:false never uses the clearing action and still verifies an append',async t=>{
  const fixture=cachedTarget(t);
  const result=await browserAction({
    endpoint:fixture.endpoint,target_id:fixture.targetId,
    action:'type',selector:'#field',text:'QA',clear:false,
  });
  assert.equal(result.structuredContent.result.value,'existingQA');
  assert.equal(fixture.calls.filter(x=>x.expression?.includes('"type_clear"')).length,0);
  assert.equal(fixture.calls.filter(x=>x.expression?.includes('"type"')).length,1);
});

test('internal type_clear action is not exposed as a public browser_action choice',()=>{
  const tool=extendedToolDefinitions.find(item=>item.name==='browser_action');
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.action.enum.includes('type_clear'),false);
});
