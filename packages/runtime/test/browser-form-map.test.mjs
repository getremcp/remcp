import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFormMap, inspectFormMap } from '../src/extended/browser-form-map.mjs';
import { buildDevtoolsReport, browserDevtools } from '../src/extended/browser-devtools.mjs';

function makeSnapshot() {
  const strings=[],ids=new Map();
  const intern=value=>{if(!ids.has(value)){ids.set(value,strings.length);strings.push(value);}return ids.get(value);};
  const nodeName=[],parentIndex=[],attributes=[];
  const push=(tag,parent,attrs={})=>{
    nodeName.push(intern(tag));parentIndex.push(parent);
    attributes.push(Object.entries(attrs).flatMap(([key,value])=>[intern(key),intern(String(value))]));
    return nodeName.length-1;
  };
  const root=push('#document',-1);
  push('html',root); // Real Chrome DOMSnapshot includes this non-element doctype.
  const html=push('HTML',root),body=push('BODY',html),form=push('FORM',body);
  push('LABEL',form,{for:'contact-email'});
  push('INPUT',form,{id:'contact-email',type:'email',required:'',value:'SECRET_FORM_VALUE',autocomplete:'email'});
  push('INPUT',form,{type:'password',required:'',value:'PRIVATE-PASSWORD'});
  push('BUTTON',form,{type:'submit'});
  push('SELECT',form,{name:'SECRET_PERSONAL_NAME'});
  const second=push('FORM',body);
  push('TEXTAREA',second,{'aria-label':'Private contents',value:'SENSITIVE'});
  return {strings,documents:[{nodes:{nodeName,parentIndex,attributes}}]};
}

test('native form map identifies field structure and unlabeled candidates without raw values',()=>{
  const snapshot=makeSnapshot();
  const nodes=snapshot.documents[0].nodes;
  // Chrome uses -1 as the value string index for a valueless required attribute.
  for(const list of nodes.attributes)for(let j=0;j<list.length;j+=2)
    if(snapshot.strings[list[j]]==='required')list[j+1]=-1;
  const result=summarizeFormMap(snapshot);
  assert.equal(result.form_count,2);
  assert.equal(result.field_count,4);
  assert.equal(result.required_count,2);
  assert.equal(result.unlabeled_candidate_count,2);
  assert.equal(result.submit_count,1);
  assert.equal(result.by_type.email,1);
  assert.equal(result.by_type.password,1);
  assert.equal(result.forms[0].field_count,3);
  assert.equal(result.fields[0].autocomplete,'email');
  assert.equal(result.fields[0].has_label,true);
  assert.match(result.fields[0].selector,/html:nth-of-type\(1\) > body:nth-of-type\(1\) > form:nth-of-type\(1\) > input:nth-of-type\(1\)/);
  assert.equal(result.fields[1].has_label,false);
  const output=JSON.stringify(result);
  for(const unsafe of ['SECRET_FORM_VALUE','PRIVATE-PASSWORD','SENSITIVE','contact-email','Private contents','SECRET_PERSONAL_NAME']) {
    assert.equal(output.includes(unsafe),false,unsafe);
  }
});

test('form map caps fields and handles malformed data',()=>{
  assert.equal(summarizeFormMap(null).field_count,0);
  const snapshot=makeSnapshot(),nodes=snapshot.documents[0].nodes;
  const inputName=snapshot.strings.indexOf('INPUT');
  for(let i=0;i<55;i++){
    nodes.nodeName.push(inputName);
    nodes.parentIndex.push(3);
    nodes.attributes.push([]);
  }
  const report=summarizeFormMap(snapshot);
  assert.equal(report.field_count,59);
  assert.equal(report.fields.length,40);
  assert.equal(report.truncated,true);
});

test('native CDP snapshot uses single domain call, no Runtime.evaluate',async()=>{
  const calls=[],fixture=makeSnapshot();
  const result=await inspectFormMap({send:async (method,params)=>{
    calls.push({method,params});
    assert.equal(method,'DOMSnapshot.captureSnapshot');
    return fixture;
  }});
  assert.deepEqual(calls.map(call=>call.method),['DOMSnapshot.captureSnapshot']);
  assert.deepEqual(calls[0].params,{computedStyles:[],includePaintOrder:false,includeDOMRects:false});
  assert.equal(result.action,'form_map');
  assert.equal(result.form_map.field_count,4);
});

test('form map requires exact CDP target and reports no URL',async()=>{
  await assert.rejects(browserDevtools({action:'form_map'}),/target_id/);
  const result=buildDevtoolsReport({id:'tab-1',url:'https://secret.example/credentials?token=private'},
    'form_map',{action:'form_map',form_map:summarizeFormMap(makeSnapshot())});
  assert.equal(result.target_id,'tab-1');
  assert.equal(result.url,undefined);
  assert.equal(JSON.stringify(result).includes('secret.example'),false);
});
