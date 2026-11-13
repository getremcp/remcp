import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonResult} from '../src/extended/common.mjs';
import {detectedAppRows,inspectDetectedApp} from '../src/extended/app-dynamic-discovery.mjs';
import {macBundleMatchesExecutable,macBundlePidVerified}
  from '../src/extended/app-macos-bundle-process.mjs';

const copies=[
  {name:'ReMCP Care QA Test',path:'/Users/me/Applications/ReMCP Care QA Test.app',version:'1'},
  {name:'ReMCP Care QA Test',path:'/Users/me/backup/ReMCP Care QA Test.app',version:'2'},
];
const getCopies=async()=>jsonResult({backend:'system_profiler',data:copies,
  count:copies.length,returned:copies.length});
const window={id:'mac:123:w0',pid:123,app:'ReMCP Care QA Test',
  title:'Dashboard',active:true};
const root={pid:123,app:'ReMCP Care QA Test',window:'Dashboard',
  role:'Window',name:'Dashboard'};

test('macOS same-name .app copies have unique opaque stable IDs and no path disclosure',()=>{
  const r=detectedAppRows(copies,{backend:'system_profiler'});
  assert.equal(r.apps.length,2);
  assert.notEqual(r.apps[0].id,r.apps[1].id);
  for(const app of r.apps){
    assert.equal(app.installation,'application_bundle');
    assert.equal(app.source,'macos_app_bundle');
    assert.deepEqual(app.destinations,[]);
    assert.match(app.id,/^local-[a-f0-9]{20}$/);
    assert.ok(!JSON.stringify(app).includes('/Users/me/'));
  }
});
test('macOS same-name app never inspects before exact PID bundle check',async()=>{
  const items=detectedAppRows(copies,{backend:'system_profiler'}).apps;
  let scanned=0,checked=0;
  const result=await inspectDetectedApp({app:items[0].id,intent:'inspect'},{
    platform:'darwin',installedApps:getCopies,
    listWindows:async()=>jsonResult([window]),
    macBundlePidVerified:async(path,pid)=>{
      checked++;assert.equal(path,copies[0].path);assert.equal(pid,123);return false;
    },
    uiSnapshot:async()=>{scanned++;throw Error('must not scan wrong app')},
  });
  assert.equal(result.status,'blocked');
  assert.equal(result.reason,'macos_bundle_process_identity_unverified');
  assert.equal(checked,1);
  assert.equal(scanned,0);
});
test('correct macOS bundle/PID association then still requires exact AX root',async()=>{
  const app=detectedAppRows(copies,{backend:'system_profiler'}).apps[1].id;
  const response=await inspectDetectedApp({app,intent:'inspect'},{
    platform:'darwin',installedApps:getCopies,
    listWindows:async()=>jsonResult([window]),
    macBundlePidVerified:async(path,pid)=>path===copies[1].path&&pid===123,
    uiSnapshot:async()=>jsonResult({nodes:[root]}),
  });
  assert.equal(response.status,'inspected');
  assert.equal(response.verified,true);
});
test('macOS bundle executable verification matches exact Contents boundary',async()=>{
  const bundle='/Applications/Example.app';
  assert.equal(macBundleMatchesExecutable(bundle,bundle+'/Contents/MacOS/Example'),true);
  for(const fake of [
    '/Applications/Example.app2/Contents/MacOS/Example',
    '/Applications/Elsewhere/Example.app/Contents/MacOS/Example',
    '/Applications/Example.app',
    '/Applications/Example.app/Contents',
  ])assert.equal(macBundleMatchesExecutable(bundle,fake),false,fake);
  assert.equal(await macBundlePidVerified(bundle,876,{
    runFileFn:async(path,args)=>{assert.equal(path,'/bin/ps');
      assert.deepEqual(args,['-p','876','-o','comm=']);
      return {code:0,stdout:bundle+'/Contents/MacOS/Example\n'};
    },
  }),true);
  assert.equal(await macBundlePidVerified(bundle,876,{
    runFileFn:async()=>({code:1,stdout:bundle+'/Contents/MacOS/Example'}),
  }),false);
  assert.equal(await macBundlePidVerified('/Applications/../Other.app',876),false);
});
test('Linux separate desktop IDs do not collapse into the same local ID',async()=>{
  const gui=[
    {name:'Identical Editor',source:'xdg_desktop_entry',
      desktop_id:'org.example.EditorOne.desktop'},
    {name:'Identical Editor',source:'xdg_desktop_entry',
      desktop_id:'org.example.EditorTwo.desktop'},
  ];
  const detected=detectedAppRows(gui,{backend:'xdg_desktop_entries'});
  assert.equal(detected.apps.length,2);
  assert.notEqual(detected.apps[0].id,detected.apps[1].id);
  let scanned=0;
  const res=await inspectDetectedApp({app:detected.apps[0].id,intent:'inspect'},{
    platform:'linux',guiApps:async()=>jsonResult({backend:'xdg_desktop_entries',
      data:gui,returned:2,count:2}),
    listWindows:async()=>{scanned++;throw Error('must not scan ambiguous app')},
  });
  assert.equal(res.status,'blocked');
  assert.equal(res.reason,'ambiguous_gui_launcher_display_name');
  assert.equal(scanned,0);
});

test('Windows duplicate display names are blocked before any UI access',async()=>{
  const records=[
    {name:'Legacy Client',path:'C:\\\\Program Files\\\\Legacy Client 1'},
    {name:'Legacy Client',path:'C:\\\\Program Files\\\\Legacy Client 2'},
  ];
  const id=detectedAppRows(records,{backend:'windows-registry'}).apps[0].id;
  let scanned=0;
  const result=await inspectDetectedApp({app:id,intent:'inspect'},{
    platform:'win32',
    installedApps:async()=>jsonResult({backend:'windows-registry',
      data:records,count:2,returned:2}),
    listWindows:async()=>{scanned++;throw Error('No identity, no UI')},
  });
  assert.equal(result.status,'blocked');
  assert.equal(result.reason,'ambiguous_windows_installations');
  assert.equal(scanned,0);
});

test('case-distinct bundle paths do not alias on case-sensitive macOS volumes',()=>{
  const rows=[
    {name:'Case Test App',path:'/Volumes/CaseSensitive/App.app'},
    {name:'Case Test App',path:'/Volumes/CaseSensitive/app.app'},
  ];
  const r=detectedAppRows(rows,{backend:'system_profiler'});
  assert.equal(r.apps.length,2);
  assert.notEqual(r.apps[0].id,r.apps[1].id);
});
test('XDG launcher identity persists when only displayed name changes',()=>{
  const first=detectedAppRows([
    {name:'First Title',source:'xdg_desktop_entry',desktop_id:'org.example.Unique.desktop'},
  ],{backend:'xdg_desktop_entries'}).apps[0];
  const renamed=detectedAppRows([
    {name:'Second Title',source:'xdg_desktop_entry',desktop_id:'org.example.Unique.desktop'},
  ],{backend:'xdg_desktop_entries'}).apps[0];
  assert.equal(first.id,renamed.id);
});
