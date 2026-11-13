import test from 'node:test';
import assert from 'node:assert/strict';
import {matchingWebTabs,selectedWebTarget,summarizeAppWindow,inspectGuidedWorkflow}
  from '../src/extended/app-workflow-inspect.mjs';
import {planAppNavigation,appNavigate} from '../src/extended/app-navigation.mjs';

const browserPlan=planAppNavigation({app:'Gmail',destination:'compose_email'},{platform:'linux'});
const nativePlan=planAppNavigation({app:'calculator',destination:'inspect_app'},{platform:'linux'});
const tab=(id,url,title='Inbox')=>({id,url,title});

test('exact verified HTTPS web origin; block lookalikes, credentials and path leaks',()=>{
  const result=matchingWebTabs([
    tab('a','https://mail.google.com/mail/u/0/#inbox','Inbox'),
    tab('b','https://www.mail.google.com/mail/u/1/#inbox','Work'),
    tab('c','https://mail.google.com.evil.example/','Fake'),
    tab('d','https://evil.example/?url=https://mail.google.com','Fake'),
    tab('e','http://mail.google.com/mail/','Insecure'),
    tab('f','https://MAIL.GOOGLE.COM/mail/u/2/#sent','Sent'),
    tab('g','about:blank','Blank'),
    tab('h','https://person:password@mail.google.com/mail/','Credentials'),
    tab('i','https://mail.google.com:8443/','Unexpected port'),
  ],'mail.google.com');
  assert.deepEqual(result.map(x=>x.target_id),['a','b','f']);
  assert.ok(result.every(x=>x.origin==='https://mail.google.com'||x.origin==='https://www.mail.google.com'));
  assert.ok(result.every(x=>!JSON.stringify(x).includes('#inbox')&&!JSON.stringify(x).includes('/mail/u')));
  assert.deepEqual(matchingWebTabs([tab('a','https://mail.google.com')],'google.com'),[]);
  assert.deepEqual(matchingWebTabs([],''),[]);
});

test('Jira tenant subdomains match strictly, not lookalike hosts',()=>{
  const data=matchingWebTabs([
    tab('a','https://example.atlassian.net/jira/software'),
    tab('b','https://another.atlassian.net/browse/PROJ-1'),
    tab('evil','https://another.atlassian.net.evil.example/browse/PROJ-1'),
    tab('http','http://example.atlassian.net/'),
    tab('port','https://example.atlassian.net:8443/'),
  ],'atlassian.net');
  assert.deepEqual(data.map(x=>x.target_id),['a','b']);
  assert.deepEqual(matchingWebTabs([tab('c','https://drive.google.com.evil.example')],'drive.google.com'),[]);
});

test('web tab selection refuses ambiguity and stale target IDs',()=>{
  const choices=matchingWebTabs([tab('one','https://mail.google.com'),tab('two','https://mail.google.com')],'mail.google.com');
  assert.equal(selectedWebTarget(choices).reason,'multiple_matching_tabs');
  assert.equal(selectedWebTarget(choices,'missing').reason,'target_id_not_found');
  assert.equal(selectedWebTarget(choices,'two').target.target_id,'two');
  assert.equal(selectedWebTarget(choices.slice(0,1)).reason,'unique');
  assert.equal(selectedWebTarget([]).reason,'no_matching_tabs');
});

test('native window inspection requires exact process and one real window; values are never returned',()=>{
  const row={id:'a',app:'gnome-calculator',pid:37,role:'frame',window:'Calculator',width:240,height:310,active:true};
  const button={id:'b',parent_id:'a',app:'gnome-calculator',pid:37,role:'button',name:'Mode',width:40,height:30,label:1};
  const hidden={id:'c',parent_id:'a',app:'gnome-calculator',pid:37,role:'entry',name:'Secret Token',value:'topsecret'};
  const pw={id:'d',parent_id:'a',app:'gnome-calculator',pid:37,role:'entry',name:'Password',password:true};
  const summary=summarizeAppWindow({nodes:[row,button,hidden,pw]},['gnome-calculator']);
  assert.equal(summary.matched,true);
  assert.equal(summary.window_title,'Calculator');
  assert.equal(summary.foreground_verified,true);
  assert.equal(summary.controls.length,1);
  assert.equal(summary.controls[0].name,'Mode');
  assert.ok(!JSON.stringify(summary).includes('topsecret'));
  const ambiguous=summarizeAppWindow({nodes:[row,{...row,id:'z',pid:38}]},['gnome-calculator']);
  assert.equal(ambiguous.reason,'ambiguous_app_windows');
  assert.equal(ambiguous.matching_windows.length,2);
  assert.equal(summarizeAppWindow({nodes:[row,{...row,id:'z',pid:38}]},['gnome-calculator'],{pid:38}).pid,38);
  assert.equal(summarizeAppWindow({nodes:[row,{...row,id:'z',pid:38}]},['gnome-calculator'],{window_id:'z'}).pid,38);
  assert.equal(summarizeAppWindow({nodes:[row,{...row,id:'z',pid:38}]},['gnome-calculator'],{pid:37,window_id:'z'}).reason,'requested_window_not_found');
  assert.equal(summarizeAppWindow({nodes:[{...row,app:'unrelated'}]},['gnome-calculator']).matched,false);
});

test('macOS Notes AX controls remain scoped to the selected window and omit note titles',()=>{
  const nodes=[
    {id:'mac:101:r',pid:101,app:'Notes',role:'Window',width:860,height:640,active:true,name:'Notes'},
    {id:'mac:101:r.1',parent_id:'mac:101:r',pid:101,app:'Notes',role:'Toolbar',name:'toolbar'},
    {id:'mac:101:r.1.2',parent_id:'mac:101:r.1',pid:101,app:'Notes',
      role:'TextField',name:'search text field',enabled:true},
    {id:'mac:101:r.0',parent_id:'mac:101:r',pid:101,app:'Notes',role:'Table',name:'Notes list'},
    {id:'mac:101:r.0.1',parent_id:'mac:101:r.0',pid:101,app:'Notes',
      role:'Row',name:'Private note title'},
    {id:'mac:101:w1',pid:101,app:'Notes',role:'Window',width:400,height:500,active:false,name:'Second window'},
    {id:'mac:101:w1.1',parent_id:'mac:101:w1',pid:101,app:'Notes',
      role:'Button',name:'Compose'},
    {id:'mac:101:unscoped',pid:101,app:'Notes',role:'Button',name:'Foreign control'},
  ];
  const s=summarizeAppWindow({nodes},['Notes']);
  assert.equal(s.matched,true);
  assert.equal(s.window_title,'Notes');
  assert.deepEqual(s.controls.map(x=>x.name),['search text field']);
  assert.ok(!JSON.stringify(s).includes('Private note title'));
  assert.ok(!JSON.stringify(s).includes('Second window'));
  assert.ok(!JSON.stringify(s).includes('Foreign control'));
  const chosen=summarizeAppWindow({nodes},['Notes'],{window_id:'mac:101:w1'});
  assert.deepEqual(chosen.controls.map(x=>x.name),['Compose']);
  assert.equal(chosen.foreground_verified,false);
  const truncated=summarizeAppWindow({nodes,truncated:true},['Notes']);
  assert.equal(truncated.truncated,true);
});

test('cyclic or unrelated accessibility ancestry never becomes an actionable control',()=>{
  const nodes=[
    {id:'main',pid:101,app:'Notes',role:'window',active:true,width:500,height:600},
    {id:'a',parent_id:'b',pid:101,app:'Notes',role:'button',name:'Search'},
    {id:'b',parent_id:'a',pid:101,app:'Notes',role:'toolbar',name:'toolbar'},
    {id:'c',parent_id:'missing',pid:101,app:'Notes',role:'button',name:'Search'},
    {id:'d',parent_id:'main',pid:102,app:'Notes',role:'button',name:'Search'},
  ];
  const summary=summarizeAppWindow({nodes},['Notes']);
  assert.equal(summary.matched,true);
  assert.equal(summary.controls.length,0);
});

test('web inspection without exact tab is read-only and does not snapshot another website',async()=>{
  let captures=0;
  const browserTabs=async()=>({structuredContent:[
    tab('a','https://mail.google.com/mail/u/0/'),
    tab('b','https://mail.google.com/mail/u/1/'),
  ]});
  const browserSnapshot=async()=>{captures++;throw Error('must not run');};
  const result=await inspectGuidedWorkflow(browserPlan,{}, {browserTabs,browserSnapshot});
  assert.equal(result.status,'inspection_unavailable');
  assert.equal(result.reason,'multiple_matching_tabs');
  assert.equal(captures,0);
  assert.equal(result.executed,false);
  assert.equal(result.side_effects,false);
});

test('web inspector stops when the tab leaves its expected trusted origin',async()=>{
  const browserTabs=async()=>({structuredContent:[tab('a','https://mail.google.com/mail/u/0/')]});
  const browserSnapshot=async()=>({structuredContent:{
    target_id:'a',url:'https://mail.google.com.evil.example/',nodes:[{role:'button',name:'Send'}],
  }});
  const result=await inspectGuidedWorkflow(browserPlan,{target_id:'a'},{browserTabs,browserSnapshot});
  assert.equal(result.status,'inspection_unavailable');
  assert.equal(result.reason,'tab_navigated_during_inspection');
  assert.equal(result.inspected,false);
});

test('web inspector does not expose controls if target navigates after DOM read',async()=>{
  let scanned=0;
  const tabs=async()=>{
    scanned++;
    return {structuredContent:[tab('a',scanned===1
      ?'https://mail.google.com/mail/u/0/'
      :'https://evil.example/phishing')]};
  };
  const snapshot=async()=>({structuredContent:{
    url:'https://mail.google.com/mail/u/0/',
    nodes:[{role:'textbox',name:'Message body',value:'private'}],
  }});
  const res=await inspectGuidedWorkflow(browserPlan,{},{
    browserTabs:tabs,browserSnapshot:snapshot,
  });
  assert.equal(res.reason,'tab_changed_after_dom');
  assert.equal(res.status,'inspection_unavailable');
  assert.equal(res.controls,undefined);
  assert.equal(scanned,2);
});

test('empty web accessibility result never claims successful inspection',async()=>{
  const r=await inspectGuidedWorkflow(browserPlan,{},{
    browserTabs:async()=>({structuredContent:[tab('a','https://mail.google.com')]}),
    browserSnapshot:async()=>({structuredContent:{url:'https://mail.google.com',nodes:[]}}),
  });
  assert.equal(r.status,'inspection_unavailable');
  assert.equal(r.reason,'browser_dom_empty');
});

test('web inspector exposes bounded control descriptions, never textbox values',async()=>{
  const browserTabs=async()=>({structuredContent:[tab('a','https://mail.google.com/mail/u/0/')]});
  const browserSnapshot=async()=>({structuredContent:{
    url:'https://mail.google.com/mail/u/0/#inbox',nodes:[
      {role:'button',name:'Compose',value:'private draft'},
      {role:'textbox',name:'Secret Token',value:'personal token'},
      {role:'textbox',name:'Search in mail',value:'confidential search'},
    ],
  }});
  const result=await inspectGuidedWorkflow(browserPlan,{}, {browserTabs,browserSnapshot});
  assert.equal(result.status,'inspected');
  assert.equal(result.controls.length,2);
  assert.equal(result.controls[0].name,'Compose');
  assert.ok(!JSON.stringify(result).includes('private draft'));
  assert.ok(!JSON.stringify(result).includes('confidential search'));
  assert.ok(!JSON.stringify(result).includes('#inbox'));
});

test('native guided inspection confirms an actual window before showing UI controls',async()=>{
  const result=await inspectGuidedWorkflow(nativePlan,{},{
    requireInteractiveGuiSession:async()=>({interactive:true}),
    uiSnapshot:async()=>({structuredContent:{nodes:[
      {id:'linux:73:r',app:'gnome-calculator',window:'Calculator',pid:73,role:'frame',width:230,height:400},
      {id:'linux:73:r.0',parent_id:'linux:73:r',app:'gnome-calculator',pid:73,role:'button',name:'Mode',label:2},
    ]}}),
  });
  assert.equal(result.status,'inspected');
  assert.equal(result.window.controls[0].name,'Mode');
  assert.equal(result.executed,false);
});

test('native guided inspection fails closed when accessibility is unavailable',async()=>{
  const result=await inspectGuidedWorkflow(nativePlan,{},{
    requireInteractiveGuiSession:async()=>({interactive:true}),
    uiSnapshot:async()=>{throw Error('permission denied');},
  });
  assert.equal(result.status,'inspection_unavailable');
  assert.equal(result.inspected,false);
  assert.equal(result.reason,'native_accessibility_unavailable');
});

test('ordinary guided route stays side-effect-free and inspect is opt-in',async()=>{
  const x=await appNavigate({app:'Gmail',destination:'compose_email'});
  assert.equal(x.structuredContent.status,'guidance_only');
  assert.equal(x.structuredContent.executed,false);
  assert.throws(()=>planAppNavigation({app:'Gmail',destination:'launch'}),/guides only/);
});
