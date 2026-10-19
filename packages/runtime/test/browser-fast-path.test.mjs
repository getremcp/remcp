import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { filterBrowserTargets } from '../src/extended/browser-endpoint.mjs';
import { callPageFunction } from '../src/extended/browser-session.mjs';
import { PAGE_FILL_FORM, validateFormFields } from '../src/extended/browser-actions.mjs';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';

const tab = i => ({
  id:String(i), type:'page', url:'https://example.test/page/' + i,
  webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/' + i,
});

test('explicit target ID filters before DNS and never exposes other tab URLs', async () => {
  const tabs = Array.from({length:700}, (_,i)=>tab(i));
  let validated = 0;
  const found = await filterBrowserTargets(tabs, {
    targetId:'690', validate:async () => { validated++; },
  });
  assert.deepEqual(found.map(v=>v.id), ['690']);
  assert.equal(validated,1);
  const unsafe = await filterBrowserTargets(tabs, {
    targetId:'690', validate:async () => { throw new Error('private URL'); },
  });
  assert.deepEqual(unsafe,[]);
});

test('page actions require one CDP roundtrip and keep argument values as data', async () => {
  const requests=[];
  const fake={
    async send(method,params) {
      requests.push({method,params});
      return {result:{value:runInNewContext(params.expression,{})}};
    },
  };
  const injected="x');globalThis.leaked=true;// \u{1F30D}";
  const fn='function(v){return v}';
  assert.equal(await callPageFunction(fake,fn,[injected]),injected);
  assert.equal(requests.length,1);
  assert.equal(requests[0].method,'Runtime.evaluate');
  assert.equal(requests[0].params.returnByValue,true);
});

test('fill_form validates bounds, supported values and selectors before CDP', () => {
  assert.deepEqual(validateFormFields([{selector:'  #name  ',value:'Анна'}]),[{selector:'#name',value:'Анна'}]);
  assert.throws(()=>validateFormFields([]),/1 to 20/);
  assert.throws(()=>validateFormFields(Array(21).fill({selector:'#a',value:'x'})),/1 to 20/);
  assert.throws(()=>validateFormFields([{selector:'',value:'x'}]),/CSS selector/);
  assert.throws(()=>validateFormFields([{selector:'#a'}]),/CSS selector/);
  assert.throws(()=>validateFormFields([{selector:'#a',value:'x'.repeat(16385)}]),/exceeds/);
  const action=extendedToolDefinitions.find(t=>t.name==='browser_action');
  assert.ok(action.inputSchema.properties.action.enum.includes('fill_form'));
  assert.equal(action.inputSchema.properties.fields.maxItems,20);
});

test('fill_form preflights all fields, fires native events and never returns field data', () => {
  const events=[];
  class Input {
    constructor(type='text'){this.tagName='INPUT';this.type=type;this.value='';this.checked=false;}
    getClientRects(){return [{width:12,height:20}];}
    matches(){return false;}
    dispatchEvent(e){events.push(e.type);}
  }
  class Select extends Input {
    constructor(){super('select');this.tagName='SELECT';this.options=[{value:'basic'},{value:'pro'}];}
  }
  const a=new Input(), b=new Select(), checkbox=new Input('checkbox');
  const elements={'#a':a,'#b':b,'#c':checkbox};
  const fake={
    document:{querySelector(selector){return elements[selector]??null;}},
    Event:class {constructor(type){this.type=type;}},
  };
  const perform=fields=>runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+')',fake);
  assert.throws(()=>perform([{selector:'#a',value:'unsafe'},{selector:'#missing',value:'x'}]),/not editable/);
  assert.equal(a.value,'','a partial form must never be written when validation fails');
  assert.throws(()=>perform([{selector:'#a',value:'partial'},{selector:'#c',value:'false'}]),/boolean/);
  assert.equal(a.value,'','ambiguous checkbox values must fail before any form is written');
  assert.equal(checkbox.checked,false);
  const result=perform([{selector:'#a',value:'Проверка 🌍'},{selector:'#b',value:'pro'},{selector:'#c',value:true}]);
  assert.equal(a.value,'Проверка 🌍');
  assert.equal(b.value,'pro');
  assert.equal(checkbox.checked,true);
  assert.equal(result.filled,3);
  assert.equal(JSON.stringify(result).includes('Проверка'),false);
  assert.deepEqual(events,['input','change','input','change','input','change']);
});
