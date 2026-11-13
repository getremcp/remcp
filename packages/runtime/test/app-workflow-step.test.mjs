import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {guidedStepPolicy, chooseGuidedControl, guidedStepNames, validateGuidedQuery} from '../src/extended/app-workflow-step-policy.mjs';
import {PAGE_GUIDED_STEP,performGuidedBrowserStep} from '../src/extended/app-workflow-browser-step.mjs';
import {runGuidedStep} from '../src/extended/app-workflow-step.mjs';
import {appCatalogPayload,planAppNavigation,appNavigate} from '../src/extended/app-navigation.mjs';

const gmail=planAppNavigation({app:'Gmail',destination:'compose_email'},{platform:'linux'});
const thunderbird=planAppNavigation({app:'Thunderbird',destination:'compose_email'},{platform:'linux'});
const search=planAppNavigation({app:'Gmail',destination:'find_email'},{platform:'linux'});
const inspectedWeb={
  inspected:true,status:'inspected',target_id:'tab-a',host:'mail.google.com',
  controls:[{role:'button',name:'Compose'}],
};
const nativeUi={
  inspected:true,status:'inspected',
  window:{pid:72,app:'thunderbird',window_title:'Thunderbird',foreground_verified:true,
    controls:[{role:'button',name:'New message',id:'linux:72:compose'}]},
};

test('safe steps exist only for known guide plus action pairs',()=>{
  assert.deepEqual(guidedStepNames('compose_email'),['open_compose']);
  assert.deepEqual(guidedStepNames('find_email'),['set_search_query','focus_search']);
  assert.deepEqual(guidedStepNames('draft_chat'),['focus_message']);
  assert.equal(guidedStepPolicy('compose_email','send'),null);
  assert.equal(guidedStepPolicy('compose_email','delete'),null);
  assert.equal(guidedStepPolicy('blender_render','open_compose'),null);
  assert.equal(guidedStepPolicy('find_email','open_compose'),null);
  assert.equal(guidedStepPolicy('compose_email','focus_search'),null);
  const catalog=appCatalogPayload({app:'Gmail',include_guides:true,platform:'linux'});
  assert.deepEqual(catalog.apps[0].guides.find(x=>x.id==='compose_email').safe_steps,['open_compose']);
  assert.deepEqual(catalog.apps[0].guides.find(x=>x.id==='find_email').safe_steps,['set_search_query','focus_search']);
});

test('exact allowed role+label required; ambiguity and unsafe lookalike fail closed',()=>{
  const policy=guidedStepPolicy('compose_email','open_compose');
  assert.equal(chooseGuidedControl([{role:'button',name:'Compose'}],policy).ok,true);
  assert.equal(chooseGuidedControl([{role:'button',name:'Compose and Send'}],policy).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'button',name:'Send'}],policy).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'textbox',name:'Compose'}],policy).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'button',name:'Compose',disabled:true}],policy).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'button',name:'Compose',password:true}],policy).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'button',name:'Compose'},{role:'button',name:'Compose'}],policy).reason,'ambiguous_controls');
  assert.equal(chooseGuidedControl([{role:'button',name:'Napisz'}],policy).ok,true);
  assert.equal(chooseGuidedControl([{role:'SearchField',name:'Search in mail'}],guidedStepPolicy('find_email','focus_search')).ok,true);
  assert.equal(chooseGuidedControl([{role:'TextField',name:'Search in mail'}],guidedStepPolicy('find_email','focus_search')).ok,true);
  assert.equal(chooseGuidedControl([{role:'button',name:'Написать'}],policy).ok,true);
});

test('only the explicit search step can set search text; no step sends messages',()=>{
  for(const guide of ['compose_email','find_email','find_conversation','find_note','draft_chat']){
    for(const step of guidedStepNames(guide)){
      const p=guidedStepPolicy(guide,step);
      assert.ok(['focus','invoke','set_query'].includes(p.action));
      assert.ok(p.names.every(s=>!/send|delete|erase|publish|pay|transfer|remove/i.test(s)));
    }
  }
});

test('search text validation refuses missing, multiline, credentials controls and overlong input',()=>{
  const policy=guidedStepPolicy('find_email','set_search_query');
  assert.equal(policy.action,'set_query');
  assert.equal(validateGuidedQuery({query:'  Україна ✅  '},policy),'Україна ✅');
  assert.throws(()=>validateGuidedQuery({},policy),/requires a string query/);
  assert.throws(()=>validateGuidedQuery({query:''},policy),/1–256/);
  assert.throws(()=>validateGuidedQuery({query:'hello'+String.fromCharCode(10)+'world'},policy),/1–256/);
  assert.throws(()=>validateGuidedQuery({query:'x'.repeat(257)},policy),/1–256/);
  assert.throws(()=>validateGuidedQuery({query:'abc'+String.fromCharCode(0x202E)+'def'},policy),/1–256/);
  assert.throws(()=>validateGuidedQuery({query:'should not be accepted'},guidedStepPolicy('compose_email','open_compose')),/only permitted/);
});

test('search step requires an exact search control, never a compose or password field',()=>{
  const p=guidedStepPolicy('find_email','set_search_query');
  assert.equal(chooseGuidedControl([{role:'searchbox',name:'Search in mail'}],p).ok,true);
  assert.equal(chooseGuidedControl([{role:'textbox',name:'Password'}],p).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'button',name:'Search in mail'}],p).reason,'control_not_found');
  assert.equal(chooseGuidedControl([{role:'searchbox',name:'Search in mail'},
    {role:'searchbox',name:'Search in mail'}],p).reason,'ambiguous_controls');
});

test('safe search text does not leave tool results, and no keyboard Enter is sent',async()=>{
  const p=planAppNavigation({app:'Gmail',destination:'find_email'},{platform:'linux'});
  const phrase='UniquePrivateSearch✔';
  let seen=0;
  const r=await runGuidedStep(p,{step:'set_search_query',query:phrase},{
    inspectGuidedWorkflow:async()=>({...inspectedWeb,
      controls:[{role:'searchbox',name:'Search in mail'}]}),
    performGuidedBrowserStep:async({policy,query})=>{
      seen++;assert.equal(policy.action,'set_query');assert.equal(query,phrase);
      return {dispatched:true,readback_confirmed:true,verified:false,target_id:'tab-a'};
    }
  });
  assert.equal(seen,1);
  assert.equal(r.status,'dispatched');
  assert.equal(r.query_length,phrase.length);
  assert.equal(r.verified,false);
  assert.ok(!JSON.stringify(r).includes(phrase));
  const plan=await appNavigate({app:'Gmail',destination:'find_email',
    step:'set_search_query',query:phrase,dry_run:true});
  assert.equal(plan.structuredContent.query_length,phrase.length);
  assert.ok(!JSON.stringify(plan).includes(phrase));
  await assert.rejects(appNavigate({app:'Gmail',destination:'compose_email',
    step:'open_compose',query:'unexpected',dry_run:true}),/only permitted/);
});

test('native search uses strict one-field value setting with no submit or coordinate fallback',async()=>{
  const p=planAppNavigation({app:'thunderbird',destination:'find_email'},{platform:'linux'});
  const phrase='invoice number 42';
  let called=0;
  const r=await runGuidedStep(p,{step:'set_search_query',query:phrase},{
    inspectGuidedWorkflow:async()=>({...nativeUi,window:{...nativeUi.window,
      controls:[{id:'linux:72:search',role:'searchbox',name:'Search in mail'}]}}),
    uiAction:async options=>{
      called++;assert.equal(options.action,'set_value');assert.equal(options.value,phrase);
      assert.equal(options.semantic_only,true);assert.equal(options.strict_target_id,true);
      return {structuredContent:{backend:'accessibility',action:'set_value'}};
    }
  });
  assert.equal(called,1);assert.equal(r.status,'dispatched');assert.equal(r.verified,false);
  assert.ok(!JSON.stringify(r).includes(phrase));
});

test('unrecognized step rejected before consulting desktop or browser state',async()=>{
  let inspected=0,actions=0;
  await assert.rejects(runGuidedStep(gmail,{step:'send'},{
    inspectGuidedWorkflow:async()=>{inspected++;},
    performGuidedBrowserStep:async()=>{actions++;},
  }),/does not have the requested safe atomic step/);
  assert.equal(inspected,0);
  assert.equal(actions,0);
});

test('Mac Notes search text field is a reviewed and actionable AX role/name pair',()=>{
  const p=guidedStepPolicy('find_note','focus_search');
  const q=guidedStepPolicy('find_note','set_search_query');
  assert.equal(chooseGuidedControl([{role:'TextField',name:'search text field'}],p).ok,true);
  assert.equal(chooseGuidedControl([{role:'TextField',name:'search text field'}],q).ok,true);
  assert.equal(chooseGuidedControl([{role:'TextField',name:'search text field',password:true}],q).reason,'control_not_found');
});

test('native guarded step refuses truncated tree even if one target appears',async()=>{
  const p=planAppNavigation({app:'apple-notes',destination:'find_note'},{platform:'darwin'});
  let actions=0;
  const result=await runGuidedStep(p,{step:'focus_search'},{
    inspectGuidedWorkflow:async()=>({inspected:true,window:{
      app:'Notes',pid:888,foreground_verified:true,truncated:true,
      controls:[{id:'mac:888:r.1.1',role:'TextField',name:'search text field'}]
    }}),
    uiAction:async()=>{actions++;},
  });
  assert.equal(result.status,'blocked');
  assert.equal(result.reason,'native_snapshot_truncated');
  assert.equal(actions,0);
});

test('no tab, ambiguous or unverified control leaves app untouched',async()=>{
  let actions=0;
  const unavailable=await runGuidedStep(gmail,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>({inspected:false,reason:'multiple_matching_tabs'}),
    performGuidedBrowserStep:async()=>{actions++;},
  });
  assert.equal(unavailable.status,'blocked');
  const duplicate=await runGuidedStep(gmail,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>({...inspectedWeb,
      controls:[{role:'button',name:'Compose'},{role:'button',name:'Compose'}]}),
    performGuidedBrowserStep:async()=>{actions++;},
  });
  assert.equal(duplicate.reason,'ambiguous_controls');
  const wrong=await runGuidedStep(gmail,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>({...inspectedWeb,controls:[{role:'button',name:'Send'}]}),
    performGuidedBrowserStep:async()=>{actions++;},
  });
  assert.equal(wrong.reason,'control_not_found');
  assert.equal(actions,0);
});

test('browser atomic step dispatches only one registered control, never claims send',async()=>{
  const calls=[];
  const x=await runGuidedStep(gmail,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>inspectedWeb,
    performGuidedBrowserStep:async({plan,inspection,policy})=>{
      calls.push({app:plan.app,tab:inspection.target_id,step:policy.step});
      return {dispatched:true,verified:false,target_id:'tab-a'};
    },
  });
  assert.equal(x.status,'dispatched');
  assert.equal(x.executed,true);
  assert.equal(x.verified,false);
  assert.deepEqual(calls,[{app:'gmail-web',tab:'tab-a',step:'open_compose'}]);
  assert.match(x.note,/no message was sent/i);
});

test('native action requires current verified foreground and exact accessibility ID',async()=>{
  let actions=0;
  const inactive=await runGuidedStep(thunderbird,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>({...nativeUi,
      window:{...nativeUi.window,foreground_verified:false}}),
    uiAction:async()=>{actions++;},
  });
  assert.equal(inactive.reason,'foreground_not_verified');
  const noId=await runGuidedStep(thunderbird,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>({...nativeUi,
      window:{...nativeUi.window,controls:[{role:'button',name:'New message'}]}}),
    uiAction:async()=>{actions++;},
  });
  assert.equal(noId.reason,'native_element_id_unavailable');
  assert.equal(actions,0);
  const real=await runGuidedStep(thunderbird,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>nativeUi,
    uiAction:async opts=>{actions++;assert.deepEqual(opts,{
      action:'invoke',id:'linux:72:compose',pid:72,app:'thunderbird',
      name:'New message',role:'button',semantic_only:true,strict_target_id:true
    });return {structuredContent:{action:'invoke',id:'linux:72:compose',pid:72,name:'New message',role:'button',backend:'accessibility'}};},
  });
  assert.equal(real.status,'dispatched');
  assert.equal(real.verified,false);
  assert.equal(actions,1);
});

test('MacBook Notes focus readback is required before calling a guided step verified',async()=>{
  const p=planAppNavigation({app:'apple-notes',destination:'find_note'},{platform:'darwin'});
  const control={id:'mac:98993:r.1.11.0',role:'TextField',name:'search text field'};
  const window={pid:98993,app:'Notes',window_title:'All iCloud',foreground_verified:true,controls:[control]};
  let sent=0;
  const inspectGuidedWorkflow=async()=>({inspected:true,window});
  const uiAction=async()=>{sent++;return {structuredContent:{
    action:'focus',id:control.id,pid:window.pid,name:control.name,role:control.role,
    backend:'accessibility',foreground_after:true,focused_after:false,
  }};};
  const x=await runGuidedStep(p,{step:'focus_search'},{inspectGuidedWorkflow,uiAction});
  assert.equal(x.status,'outcome_unknown');
  assert.equal(x.reason,'focus_not_confirmed');
  assert.equal(x.verified,false);
  assert.equal(x.executed,null);
  assert.equal(sent,1);
  const success=await runGuidedStep(p,{step:'focus_search'},{
    inspectGuidedWorkflow,
    uiAction:async()=>({structuredContent:{
      action:'focus',id:control.id,pid:window.pid,name:control.name,role:control.role,
      backend:'accessibility',foreground_after:true,focused_after:true,
    }})
  });
  assert.equal(success.status,'dispatched');
  assert.equal(success.verified,true);
  const switched=await runGuidedStep(p,{step:'focus_search'},{
    inspectGuidedWorkflow,
    uiAction:async()=>({structuredContent:{
      action:'focus',id:control.id,pid:window.pid,name:control.name,role:control.role,
      foreground_after:false,focused_after:true,
    }})
  });
  assert.equal(switched.status,'outcome_unknown');
  assert.equal(switched.reason,'foreground_not_confirmed');
});

test('macOS search value attestation is boolean only and never echoes a query',async()=>{
  const p=planAppNavigation({app:'apple-notes',destination:'find_note'},{platform:'darwin'});
  const control={id:'mac:98993:r.1.11.0',role:'TextField',name:'search text field'};
  const phrase='confidential personal search';
  const base={inspected:true,window:{pid:98993,app:'Notes',foreground_verified:true,controls:[control]}};
  const response=async value_matches_after=>runGuidedStep(p,{step:'set_search_query',query:phrase},{
    inspectGuidedWorkflow:async()=>base,
    uiAction:async args=>{
      assert.equal(args.value,phrase);
      return {structuredContent:{action:'set_value',id:control.id,pid:98993,
        name:control.name,role:control.role,foreground_after:true,value_matches_after}};
    },
  });
  const good=await response(true);
  assert.equal(good.status,'dispatched');
  assert.equal(good.verified,true);
  assert.equal(good.query_length,phrase.length);
  assert.ok(!JSON.stringify(good).includes(phrase));
  const bad=await response(false);
  assert.equal(bad.status,'outcome_unknown');
  assert.equal(bad.reason,'search_text_not_confirmed');
  assert.equal(bad.verified,false);
  assert.ok(!JSON.stringify(bad).includes(phrase));
});

test('native guarded UI action rejects mismatched ID, name and missing action acknowledgement',async()=>{
  let calls=0;
  const cases=[
    {action:'invoke',id:'linux:73:compose'},
    {action:'focus',id:'linux:72:compose'},
    {action:'invoke',id:'linux:72:compose',name:'Delete'},
    {backend:'accessibility'},
  ];
  for(const response of cases){
    const x=await runGuidedStep(thunderbird,{step:'open_compose'},{
      inspectGuidedWorkflow:async()=>nativeUi,
      uiAction:async()=>{calls++;return {structuredContent:response};},
    });
    assert.equal(x.status,'outcome_unknown');
    assert.equal(x.verified,false);
    assert.equal(x.reason,'native_action_rejected_or_failed');
  }
  assert.equal(calls,cases.length);
});

test('uncertain action outcome must never be presented as a verified success',async()=>{
  const x=await runGuidedStep(gmail,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>inspectedWeb,
    performGuidedBrowserStep:async()=>{throw new Error('CDP socket disconnected');},
  });
  assert.equal(x.status,'outcome_unknown');
  assert.equal(x.executed,null);
  assert.equal(x.verified,false);
});

test('native pointer fallback is not accepted as a successful protected step',async()=>{
  const result=await runGuidedStep(thunderbird,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>nativeUi,
    uiAction:async()=>({structuredContent:{action:'invoke',backend:'pointer_fallback'}}),
  });
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.verified,false);
});

test('invalid guided dry-run steps are refused, valid steps are planned only',async()=>{
  await assert.rejects(appNavigate({app:'Gmail',destination:'compose_email',step:'send',dry_run:true}),
    /Unknown or unsafe guided atomic step/);
  const plan=await appNavigate({app:'Gmail',destination:'compose_email',step:'open_compose',dry_run:true});
  assert.equal(plan.structuredContent.status,'planned');
  assert.equal(plan.structuredContent.step.action,'invoke');
});

test('atomic steps never mix with simultaneous inspection or fake verification',async()=>{
  await assert.rejects(runGuidedStep(gmail,{step:'open_compose',inspect:true}),/not both/);
  await assert.rejects(runGuidedStep(gmail,{step:'open_compose',verify:true}),/cannot be treated as verified/);
});

function fakeElement({label='Compose',role='button',type='button',disabled=false,hidden=false}={}){
  let clicks=0;
  const attrs={'aria-label':label,role,'type':type};
  const el={
    tagName:role==='button'?'BUTTON':'INPUT',disabled,isConnected:true,
    getAttribute:key=>attrs[key]??null,
    hasAttribute:key=>Object.hasOwn(attrs,key),
    closest:selector=>selector==='form' ? null : hidden?{}:null,
    getBoundingClientRect:()=>({width:100,height:32}),
    value:'',readOnly:false,
    focus(){this._focused=true;},click(){clicks++;},
    dispatchEvent(event){this.last_event=event.type;return true;},
    get clicked(){return clicks;},get innerText(){return label;},get textContent(){return label;},
    isContentEditable:false,
  };
  return el;
}
function evaluatePage(elements,{host='mail.google.com',urlHost='mail.google.com'}={}){
  const document={activeElement:null,querySelectorAll:()=>elements};
  for(const el of elements){el.focus=()=>{document.activeElement=el;};}
  const HTMLInputElement={prototype:{}};
  Object.defineProperty(HTMLInputElement.prototype,'value',{set(value){this.value=value;}});
  class Event {constructor(type){this.type=type;}}
  const scope={document,HTMLInputElement,Event,
    location:{protocol:'https:',hostname:urlHost,username:'',password:'',port:''},
    getComputedStyle:()=>({display:'block',visibility:'visible'})};
  const page=vm.runInNewContext('('+PAGE_GUIDED_STEP+')',scope);
  return (policy,query)=>page(host,policy,query);
}

test('real page-side DOM function triggers exactly one compose button click',()=>{
  const button=fakeElement();
  const run=evaluatePage([button]);
  const result=run(guidedStepPolicy('compose_email','open_compose'));
  assert.equal(result.dispatched,true);
  assert.equal(result.verified,false);
  assert.equal(button.clicked,1);
});

test('real page-side guard blocks duplicate, submit, disabled and origin-lookalike controls',()=>{
  const btn=fakeElement();
  let result=evaluatePage([btn,fakeElement()])(guidedStepPolicy('compose_email','open_compose'));
  assert.equal(result.reason,'ambiguous_controls');
  assert.equal(btn.clicked,0);
  const submit=fakeElement({type:'submit'});
  result=evaluatePage([submit])(guidedStepPolicy('compose_email','open_compose'));
  assert.equal(result.reason,'control_not_found');
  assert.equal(submit.clicked,0);
  const disabled=fakeElement({disabled:true});
  result=evaluatePage([disabled])(guidedStepPolicy('compose_email','open_compose'));
  assert.equal(result.reason,'control_not_found');
  assert.equal(disabled.clicked,0);
  assert.throws(()=>evaluatePage([btn],{urlHost:'mail.google.com.evil.example'})(guidedStepPolicy('compose_email','open_compose')),
    /origin changed/);
  assert.equal(btn.clicked,0);
});

test('page-side focus changes only focus and never types or clicks',()=>{
  const searchBox=fakeElement({role:'searchbox',label:'Search in mail',type:'search'});
  const r=evaluatePage([searchBox])(guidedStepPolicy('find_email','focus_search'));
  assert.equal(r.dispatched,true);
  assert.equal(r.focused,true);
  assert.equal(searchBox.clicked,0);
});

test('page-side search query uses only native input setter and input event',()=>{
  const field=fakeElement({role:'searchbox',label:'Search in mail',type:'search'});
  const query='invoice ☀ 2026';
  const r=evaluatePage([field])(guidedStepPolicy('find_email','set_search_query'),query);
  assert.equal(r.dispatched,true);
  assert.equal(r.action,'set_query');
  assert.equal(r.readback_confirmed,true);
  assert.equal(r.focused,true);
  assert.equal(field.value,query);
  assert.equal(field.last_event,'input');
  assert.equal(field.clicked,0);
  assert.equal(r.query_length,query.length);
  assert.ok(!JSON.stringify(r).includes(query));
});

test('page-side search refuses password, submit, duplicate, or wrong-origin targets',()=>{
  const search=guidedStepPolicy('find_email','set_search_query');
  const password=fakeElement({role:'searchbox',label:'Search in mail',type:'password'});
  assert.equal(evaluatePage([password])(search,'hello').reason,'control_not_found');
  assert.equal(password.value,'');
  const submit=fakeElement({role:'searchbox',label:'Search in mail',type:'submit'});
  assert.equal(evaluatePage([submit])(search,'hello').reason,'control_not_found');
  const a=fakeElement({role:'searchbox',label:'Search in mail',type:'search'});
  const b=fakeElement({role:'searchbox',label:'Search in mail',type:'search'});
  assert.equal(evaluatePage([a,b])(search,'hello').reason,'ambiguous_controls');
  assert.equal(a.value,'');
  assert.throws(()=>evaluatePage([a],{urlHost:'attacker.example'})(search,'secret'),/origin changed/);
  assert.equal(a.value,'');
  assert.throws(()=>evaluatePage([a])(search,'line'+String.fromCharCode(10)+'line'),/Invalid registered search query/);
  assert.equal(a.value,'');
});

test('browser helper checks host again inside the same CDP target session',async()=>{
  const policy=guidedStepPolicy('compose_email','open_compose');
  let calls=0;
  const inspected={inspected:true,target_id:'tab-a'};
  const bad=await performGuidedBrowserStep({plan:gmail,inspection:inspected,policy},{
    withTarget:async(args,cb)=>cb({},{url:'https://evil.example'}),
    callPageFunction:async()=>{calls++;return {};},
  });
  assert.equal(bad.dispatched,false);
  assert.equal(calls,0);
  const good=await performGuidedBrowserStep({plan:gmail,inspection:inspected,policy},{
    withTarget:async(args,cb)=>cb({},{url:'https://mail.google.com/mail/u/0'}),
    callPageFunction:async(_s,fn,args)=>{
      calls++;assert.match(fn,/origin changed/);
      assert.deepEqual(args[0],'mail.google.com');
      return {dispatched:true,action:'invoke',verified:false};
    },
  });
  assert.equal(good.dispatched,true);
  assert.equal(good.verified,false);
  assert.equal(calls,1);
});

test('ordinary guide call still has no side effects or browser access',async()=>{
  const r=await appNavigate({app:'Gmail',destination:'compose_email'});
  assert.equal(r.structuredContent.status,'guidance_only');
  assert.equal(r.structuredContent.executed,false);
  assert.deepEqual(r.structuredContent.guide.safe_steps,['open_compose']);
});

test('guided native action propagates exact observed HWND without modifying Linux policy',async()=>{
  let sent;
  const result=await runGuidedStep(thunderbird,{step:'open_compose'},{
    inspectGuidedWorkflow:async()=>({...nativeUi,
      window:{...nativeUi.window,window_id:'0xB009A'}}),
    uiAction:async options=>{
      sent=options;
      return {structuredContent:{action:'invoke',id:'linux:72:compose',
        pid:72,name:'New message',role:'button',backend:'accessibility'}};
    },
  });
  assert.equal(result.status,'dispatched');
  assert.equal(sent.window_id,'0xB009A');
  assert.equal(sent.window_title,'Thunderbird');
  assert.equal(sent.strict_target_id,true);
});
