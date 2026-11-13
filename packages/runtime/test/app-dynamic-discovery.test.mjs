import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonResult} from '../src/extended/common.mjs';
import {detectedAppRows,detectedApps,inspectDetectedApp,visibleControlMatches}
  from '../src/extended/app-dynamic-discovery.mjs';
import {appTask} from '../src/extended/app-task.mjs';

const inventory=[{name:'Future Widget App',version:'1.0'},
  {name:'Future Widget App',version:'1.1'},
  {name:'Редактор Пример',version:'2'},
  {name:'Telegram',version:'1'},
  {name:'Other Unprofiled',version:'3'}];
const local=detectedAppRows(inventory).apps.find(x=>x.name==='Future Widget App');
const fakeInventory=async()=>jsonResult({
  data:inventory,backend:'fixture',returned:inventory.length,count:inventory.length,
});
const node={pid:321,app:'Future Widget App',window:'Future Widget App',role:'Window',
  name:'Future Widget App',enabled:true};
const windows=[{id:'win-1',pid:321,app:'Future Widget App',
  title:'Future Widget App',active:true}];

test('detected inventory picks up future installs without accepting them as preapproved executables',()=>{
  const result=detectedAppRows(inventory);
  assert.equal(result.apps.filter(x=>x.name==='Future Widget App').length,1);
  assert.ok(result.apps.some(x=>x.name==='Редактор Пример'));
  assert.ok(!result.apps.some(x=>x.name==='Telegram'));
  assert.match(local.id,/^local-[a-f0-9]{20}$/);
  assert.deepEqual(local.destinations,[]);
  assert.equal(local.installation,'inventory_record');
});
test('native discovered-app catalog can be filtered without loading an app or taking screenshots',async()=>{
  const result=await detectedApps({filter:'Future'}, {installedApps:fakeInventory});
  assert.equal(result.total,1);
  assert.equal(result.apps[0].id,local.id);
  assert.equal(result.backend,'fixture');
});
test('one-call unknown-app inspection requires unique OS window and matching AX identity',async()=>{
  const result=(await appTask({app:local.id,intent:'inspect'},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>jsonResult(windows),
    uiSnapshot:async()=>jsonResult({nodes:[node]}),
  })).structuredContent;
  assert.equal(result.status,'inspected');
  assert.equal(result.verified,true);
  assert.equal(result.pid,321);
  assert.equal(result.screenshot_used,false);
});
test('unknown installed app cannot launch or enter text, and cannot inspect a guessed window',async()=>{
  await assert.rejects(()=>appTask({app:local.id,intent:'open'}));
  await assert.rejects(()=>appTask({app:local.id,intent:'focus_draft'}));
  const unknown=(await appTask({app:local.id,intent:'inspect'},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>jsonResult([{id:'bad',pid:321,app:'Wrong App'}]),
  })).structuredContent;
  assert.equal(unknown.status,'blocked');
  assert.equal(unknown.verified,false);
});
test('multiple matching windows must be disambiguated before reading content',async()=>{
  const result=await inspectDetectedApp({app:local.id},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>jsonResult([...windows,{...windows[0],id:'win-2'}]),
    uiSnapshot:async()=>{throw Error('Must not inspect an ambiguous target')},
  });
  assert.equal(result.reason,'ambiguous_app_windows');
  assert.equal(result.verified,false);
});
test('malformed and stale IDs do not access desktop UI',async()=>{
  const result=await inspectDetectedApp({app:'local-00000000000000000000'},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>{throw Error('Must not probe desktop')},
  });
  assert.equal(result.reason,'installed_app_identity_not_unique_or_missing');
});

test('large native inventory truncation is recovered from trusted bounded local JSON only',async()=>{
  const raw={data:inventory,backend:'fixture-large',
    returned:inventory.length,count:inventory.length};
  const result=await detectedApps({filter:'Future'},{
    installedApps:async()=>({
      structuredContent:{truncated:true,bytes:200000,preview:'bounded'},
      content:[{type:'text',text:JSON.stringify(raw)}],
    }),
  });
  assert.equal(result.total,1);
  assert.equal(result.backend,'fixture-large');
});
test('a similarly named punctuation variant cannot impersonate an app window',async()=>{
  const outcome=await inspectDetectedApp({app:local.id},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>jsonResult([{id:'window',pid:321,app:'Future-Widget App'}]),
    uiSnapshot:async()=>{throw Error('Must not inspect mismatched window')},
  });
  assert.equal(outcome.status,'blocked');
});
test('noninteractive Windows must be rejected before the desktop is enumerated',async()=>{
  const result=await inspectDetectedApp({app:local.id},{
    platform:'win32',installedApps:fakeInventory,
    assertWindowsInteractiveDesktop:async()=>{throw Error('windows_session_0')},
    listWindows:async()=>{throw Error('Must not enumerate inaccessible Windows desktop')},
  });
  assert.equal(result.status,'blocked');
  assert.equal(result.reason,'interactive_windows_desktop_unavailable');
});

test('missing GNOME/AT-SPI windows returns a typed unavailable result, not a tool exception',async()=>{
  const result=await inspectDetectedApp({app:local.id},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>{throw Error('No top-level windows exposed')},
  });
  assert.equal(result.status,'unavailable');
  assert.equal(result.reason,'window_inventory_unavailable');
});
test('an inaccessible native AX tree cannot be mistaken for a verified inspection',async()=>{
  const result=await inspectDetectedApp({app:local.id},{
    platform:'darwin',installedApps:fakeInventory,
    listWindows:async()=>jsonResult(windows),
    uiSnapshot:async()=>{throw Error('Accessibility denied')},
  });
  assert.equal(result.status,'unavailable');
  assert.equal(result.verified,false);
});

test('newly installed app can find an already visible control without submitting search',async()=>{
  const controls=[node,
    {pid:321,app:'Future Widget App',window:'Future Widget App',role:'Button',name:'Preferences',enabled:true},
    {pid:321,app:'Future Widget App',window:'Future Widget App',role:'Button',name:'Open preferences',enabled:true},
    {pid:99,app:'Other Unprofiled',role:'Button',name:'Preferences',enabled:true}];
  const result=(await appTask({app:local.id,intent:'find',query:'preferences'},{
    platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>jsonResult(windows),
    uiSnapshot:async()=>jsonResult({nodes:controls}),
  })).structuredContent;
  assert.equal(result.status,'completed');
  assert.equal(result.verified,true);
  assert.equal(result.search_results_verified,false);
  assert.equal(result.matches,2);
  assert.equal(result.results[0].name,'Preferences');
  assert.equal(result.screenshot_used,false);
});
test('dynamic visible lookup never exposes passwords, tokens, OTPs or foreign process controls',()=>{
  const nodes=[
    {pid:321,app:'Future Widget App',role:'AXSecureTextField',name:'Open Settings',enabled:true},
    {pid:321,app:'Future Widget App',role:'Button',name:'Token settings',enabled:true},
    {pid:321,app:'Future Widget App',role:'Button',name:'Open Settings',enabled:true},
    {pid:321,app:'Future Widget App',role:'Button',name:'Open Settings',protected:true},
    {pid:322,app:'Future Widget App',role:'Button',name:'Open Settings',enabled:true},
  ];
  const matched=visibleControlMatches(nodes,'settings',{pid:321,app:'Future Widget App'});
  assert.equal(matched.matches,1);
  assert.equal(matched.results[0].name,'Open Settings');
});
test('visible lookup refuses unbounded, multiline and bidi-injected query',()=>{
  for(const query of ['','a'.repeat(257),'find\nall','text\u202e']){
    assert.throws(()=>visibleControlMatches([],query,{pid:321,app:'Future Widget App'}));
  }
});
test('Linux preflight avoids slow desktop enumeration when package is installed but process absent',async()=>{
  const result=await inspectDetectedApp({app:local.id},{
    platform:'linux',installedApps:fakeInventory,
    linuxRegisteredProcessState:()=>({state:'not_found'}),
    listWindows:undefined,
    uiSnapshot:undefined,
  });
  assert.equal(result.reason,'application_process_not_running');
  assert.equal(result.verified,false);
});

test('AX snapshot must belong to the exact selected window title, not another same-PID window',async()=>{
  const result=await inspectDetectedApp({app:local.id,intent:'inspect'},{
    platform:'darwin',installedApps:fakeInventory,
    listWindows:async()=>jsonResult(windows),
    uiSnapshot:async()=>jsonResult({nodes:[
      {...node,name:'Other Window',window:'Other Window'},
      {pid:321,app:'Future Widget App',role:'Button',
        window:'Other Window',name:'Secret unrelated content'},
    ]}),
  });
  assert.equal(result.reason,'accessible_window_identity_unverified');
  assert.equal(result.verified,false);
});
test('same-title multiple app windows cannot be disambiguated by OS id alone',async()=>{
  const result=await inspectDetectedApp({
    app:local.id,intent:'inspect',window_id:'win-1',
  },{
    platform:'darwin',installedApps:fakeInventory,
    listWindows:async()=>jsonResult([
      windows[0],{...windows[0],id:'win-2'},
    ]),
    uiSnapshot:async()=>{throw Error('Must not capture ambiguous AX window')},
  });
  assert.equal(result.reason,'indistinguishable_windows_same_title');
});
test('window-specific AX query is sent to the native backend',async()=>{
  let query;
  const result=await inspectDetectedApp({app:local.id,intent:'inspect'},{
    platform:'darwin',installedApps:fakeInventory,
    listWindows:async()=>jsonResult(windows),
    uiSnapshot:async args=>{query=args;return jsonResult({nodes:[node]})},
  });
  assert.equal(result.verified,true);
  assert.equal(query.pid,321);
  assert.equal(query.window_title,'Future Widget App');
});

const focusArgs={app:local.id,intent:'focus_control',
  window_id:'win-1',pid:321,control_id:'control:3',
  expected_name:'Preferences',expected_role:'Button'};
function focusAdapters(overrides={}){
  let reads=0;
  return {platform:'linux',installedApps:fakeInventory,
    listWindows:async()=>jsonResult(windows),
    uiSnapshot:async()=>{
      reads++;
      return jsonResult({nodes:[node,{
        id:'control:3',pid:321,app:'Future Widget App',
        window:'Future Widget App',role:'Button',name:'Preferences',
        enabled:true,focused:reads>1,
      }]});
    },
    uiAction:async()=>jsonResult({ok:true}),
    ...overrides,
  };
}
test('generic native focus is exact, one-shot, non-destructive, and verified by fresh AX',async()=>{
  const sent=[];
  const result=(await appTask(focusArgs,focusAdapters({
    uiAction:async args=>{sent.push(args);return jsonResult({ok:true})},
  }))).structuredContent;
  assert.equal(result.status,'completed');
  assert.equal(result.verified,true);
  assert.equal(result.verification,'native_accessibility_focus_readback');
  assert.equal(result.executed,true);
  assert.equal(sent.length,1);
  assert.equal(sent[0].action,'focus');
  assert.equal(sent[0].id,'control:3');
  assert.equal(sent[0].pid,321);
  assert.equal(sent[0].window_title,'Future Widget App');
});
test('generic focus rejects missing identity, unregistered app and unrelated intents before GUI',async()=>{
  for(const args of [
    {...focusArgs,control_id:null},{...focusArgs,expected_name:null},
    {...focusArgs,window_id:null},{...focusArgs,pid:null},
    {...focusArgs,app:'telegram'},{...focusArgs,query:'submit'},
    {...focusArgs,commit:true},
  ])await assert.rejects(()=>appTask(args,focusAdapters()));
});
test('stale or protected native controls never reach an action backend',async()=>{
  for(const change of [
    {name:'Different target'},{enabled:false},{protected:true},
    {role:'Window'},{focusable:false},{id:'control:4'},
    {role:'SecureTextField'},
  ]){
    const adapter=focusAdapters({
      uiSnapshot:async()=>jsonResult({nodes:[node,{
        id:'control:3',pid:321,app:'Future Widget App',
        window:'Future Widget App',role:'Button',name:'Preferences',
        enabled:true,...change,
      }]}),
      uiAction:async()=>{throw Error('UNEXPECTED DISPATCH')},
    });
    const result=(await appTask(focusArgs,adapter)).structuredContent;
    // A fabricated Window role also creates a second root: unavailable is
    // the correct earlier refusal before per-control checks can run.
    assert.ok(['blocked','unavailable'].includes(result.status));
    assert.equal(result.executed,false);
    assert.equal(result.verified,false);
  }
});
test('duplicate native control IDs are blocked before focus',async()=>{
  const control={id:'control:3',pid:321,app:'Future Widget App',
    window:'Future Widget App',role:'Button',name:'Preferences',enabled:true};
  const result=(await appTask(focusArgs,focusAdapters({
    uiSnapshot:async()=>jsonResult({nodes:[node,control,control]}),
    uiAction:async()=>{throw Error('MUST NOT TOUCH')},
  }))).structuredContent;
  assert.equal(result.status,'blocked');
});
test('focus request cannot assume success after missing native readback',async()=>{
  let times=0,calls=0;
  const result=(await appTask(focusArgs,focusAdapters({
    uiSnapshot:async()=>{
      if(++times>1)throw Error('AX unavailable after focus');
      return jsonResult({nodes:[node,{
        id:'control:3',pid:321,app:'Future Widget App',window:'Future Widget App',
        name:'Preferences',role:'Button',enabled:true,
      }]});
    },
    uiAction:async()=>{calls++;return jsonResult({ok:true})},
  }))).structuredContent;
  assert.equal(calls,1);
  assert.equal(result.status,'dispatched_unverified');
  assert.equal(result.verified,false);
});
test('focus errors are uncertain, never blindly retried',async()=>{
  let calls=0;
  const result=(await appTask(focusArgs,focusAdapters({
    uiAction:async()=>{calls++;throw Error('Native bridge interrupted')},
  }))).structuredContent;
  assert.equal(calls,1);
  assert.equal(result.status,'outcome_unknown');
  assert.equal(result.executed,null);
});

test('multiple matching accessibility roots fail closed even if process/window ID is unique',async()=>{
  let calls=0;
  const result=(await appTask(focusArgs,focusAdapters({
    uiSnapshot:async()=>jsonResult({nodes:[node,{...node,id:'another-root'},{
      id:'control:3',pid:321,app:'Future Widget App',
      window:'Future Widget App',role:'Button',name:'Preferences',enabled:true,
    }]}),
    uiAction:async()=>{calls++;throw Error('unexpected')},
  }))).structuredContent;
  assert.equal(result.status,'unavailable');
  assert.equal(result.verified,false);
  assert.equal(calls,0);
});
test('native focus explicit negative acknowledgement is never promoted to verified completion',async()=>{
  let calls=0;
  const result=(await appTask(focusArgs,focusAdapters({
    uiAction:async()=>{calls++;return jsonResult({ok:false})},
  }))).structuredContent;
  assert.equal(calls,1);
  assert.equal(result.status,'dispatched_unverified');
  assert.equal(result.reason,'native_focus_rejected');
  assert.equal(result.verified,false);
});
