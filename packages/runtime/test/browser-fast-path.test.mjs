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


test('fill_form stops if a previous input handler replaced the next field', () => {
  class Input {
    constructor() { this.tagName='INPUT'; this.type='text'; this.value=''; this.isConnected=true; this.onEvent=null; }
    getClientRects() { return [{width:12,height:20}]; }
    matches() { return false; }
    dispatchEvent(event) { this.onEvent?.(event); }
  }
  const a=new Input(), stale=new Input(), replacement=new Input();
  const elements={'#a':a,'#b':stale};
  a.onEvent=event => {
    if (event.type==='input') {
      stale.isConnected=false;
      elements['#b']=replacement;
    }
  };
  const fake={document:{querySelector:s=>elements[s]??null},Event:class{constructor(type){this.type=type;}}};
  const fill=fields=>runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+')',fake);
  assert.throws(()=>fill([{selector:'#a',value:'first'},{selector:'#b',value:'second'}]),
    /Form field changed during fill.*1 field/);
  assert.equal(a.value,'first', 'the first action may already have changed page state');
  assert.equal(stale.value,'', 'a detached element must never be written');
  assert.equal(replacement.value,'', 'a rerendered replacement needs a fresh explicit action');
});

test('fill_form rejects duplicate DOM targets before any field is changed', () => {
  const field={
    tagName:'INPUT',type:'text',value:'',isConnected:true,
    getClientRects(){return [{width:12,height:20}];},
    matches(){return false;},
    dispatchEvent(){},
  };
  const fake={
    document:{querySelector:s=>s==='#name'||s==='input[name=name]'?field:null},
    Event:class{constructor(type){this.type=type;}},
  };
  const fill=fields=>runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+')',fake);
  assert.throws(()=>fill([{selector:'#name',value:'first'},{selector:'input[name=name]',value:'second'}]),
    /same DOM element more than once/);
  assert.equal(field.value,'');
});

test('fill_form never dispatches change on a field detached by its input listener', () => {
  const events=[];
  const field={
    tagName:'INPUT',type:'text',value:'',isConnected:true,
    getClientRects(){return [{width:12,height:20}];},
    matches(){return false;},
    dispatchEvent(event) {
      events.push(event.type);
      if(event.type==='input') { this.isConnected=false; }
    },
  };
  let current=field;
  const fake={
    document:{querySelector:()=>current},
    Event:class{constructor(type){this.type=type;}},
  };
  const fill=fields=>runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+')',fake);
  assert.throws(()=>fill([{selector:'#field',value:'new'}]),/Form field changed during fill/);
  assert.deepEqual(events,['input'], 'the detached control must not receive change');
  assert.equal(field.value,'new', 'the first field mutation may already have occurred');
});

test('fill_form stops before dispatching events when a native setter detaches its own field', () => {
  const events=[];
  const field={
    tagName:'INPUT',type:'text',isConnected:true,
    getClientRects(){return [{width:12,height:20}];},
    matches(){return false;},
    dispatchEvent(event){events.push(event.type);},
  };
  Object.defineProperty(field,'value',{
    get(){return this._value??'';},
    set(value){this._value=value;this.isConnected=false;},
  });
  const fake={
    document:{querySelector:()=>field},
    Event:class{constructor(type){this.type=type;}},
  };
  const fill=fields=>runInNewContext('('+PAGE_FILL_FORM+')('+JSON.stringify(fields)+')',fake);
  assert.throws(()=>fill([{selector:'#field',value:'new'}]),/Form field changed during fill/);
  assert.deepEqual(events,[]);
});
