import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {jsonResult} from '../src/extended/common.mjs';
import {parseDesktopEntry,linuxGuiInventory} from '../src/extended/app-gui-inventory.mjs';
import {detectedApps,detectedAppRows,inspectDetectedApp}
  from '../src/extended/app-dynamic-discovery.mjs';
import {resultValue} from '../src/extended/desktop-core.mjs';

const entry=(name,extras='')=>'[Desktop Entry]\nType=Application\nName='+name+
  '\nExec=not-executed --file %U\n'+extras+'\n';

test('XDG parser reads only the main Desktop Entry and never executes Exec',()=>{
  assert.deepEqual(parseDesktopEntry(entry('Future Widget','StartupWMClass=future-widget\n'),{desktop:'GNOME'}),
    {name:'Future Widget',startup_wm_class:'future-widget',process_hint:'not-executed'});
  assert.equal(parseDesktopEntry(entry('Test','Hidden=true')),null);
  assert.equal(parseDesktopEntry(entry('Test','NoDisplay=true')),null);
  assert.equal(parseDesktopEntry(entry('Test','Terminal=true')),null);
  assert.equal(parseDesktopEntry(entry('Test','OnlyShowIn=KDE;'),{desktop:'GNOME'}),null);
  assert.notEqual(parseDesktopEntry(entry('Test','OnlyShowIn=GNOME;'),{desktop:'ubuntu:GNOME'}),null);
  assert.equal(parseDesktopEntry(entry('Test','NotShowIn=GNOME;'),{desktop:'GNOME'}),null);
  assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Link\nName=Website\nURL=https://example.com'),null);
  assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=No runner'),null);
  assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Shell\nExec=sh -c "exit 1"'),{name:'Shell'});
  assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Editor\nExec=/usr/bin/gedit --new-window'),{name:'Editor',process_hint:'gedit'});
  assert.deepEqual(parseDesktopEntry(entry('Widget')+'[Desktop Action Evil]\nName=Password'),{name:'Widget',process_hint:'not-executed'});
});
test('XDG inventory follows home/system precedence, hidden tombstones and TryExec',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'remcp-xdg-gui-'));
  const local=path.join(root,'home'),global=path.join(root,'system');
  const dirL=path.join(local,'applications'),dirG=path.join(global,'applications');
  try{
    await mkdir(dirL,{recursive:true});await mkdir(dirG,{recursive:true});
    await writeFile(path.join(dirG,'org.example.Hidden.desktop'),entry('Should disappear'));
    await writeFile(path.join(dirL,'org.example.Hidden.desktop'),entry('Uninstalled','Hidden=true'));
    await writeFile(path.join(dirG,'org.example.Duplicate.desktop'),entry('System version'));
    await writeFile(path.join(dirL,'org.example.Duplicate.desktop'),entry('User version'));
    await writeFile(path.join(dirG,'org.example.Visible.desktop'),entry('Visible GUI','OnlyShowIn=GNOME;'));
    await writeFile(path.join(dirG,'org.example.KDE.desktop'),entry('KDE GUI','OnlyShowIn=KDE;'));
    await writeFile(path.join(dirG,'org.example.Missing.desktop'),entry('Not installed','TryExec=/not/a/real/binary'));
    await writeFile(path.join(dirG,'org.example.Enabled.desktop'),entry('Runnable','TryExec='+process.execPath));
    await writeFile(path.join(dirG,'org.example.NoDisplay.desktop'),entry('Hidden panel','NoDisplay=true'));
    await writeFile(path.join(dirG,'org.example.Shell.desktop'),
      entry('Do not run','Exec=sh -c touch '+path.join(root,'unsafe')));
    await symlink('/etc/passwd',path.join(dirG,'org.example.Symlink.desktop'));
    const r=resultValue(await linuxGuiInventory({
      xdgDataHome:local,xdgDataDirs:global,desktop:'GNOME',pathEnv:process.env.PATH,
    }));
    assert.equal(r.backend,'xdg_desktop_entries');
    const names=r.data.map(x=>x.name);
    assert.ok(names.includes('User version'));
    assert.ok(!names.includes('System version'));
    assert.ok(!names.includes('Should disappear'));
    assert.ok(!names.includes('Uninstalled'));
    assert.ok(!names.includes('KDE GUI'));
    assert.ok(!names.includes('Not installed'));
    assert.ok(!names.includes('Hidden panel'));
    assert.ok(names.includes('Visible GUI'));
    assert.ok(names.includes('Runnable'));
    assert.ok(names.includes('Do not run'));
    assert.equal(r.inspected_files,10);
    assert.equal(r.count,names.length);
    await assert.rejects(()=>import('node:fs/promises').then(fs=>fs.access(path.join(root,'unsafe'))));
  }finally{await rm(root,{recursive:true,force:true})}
});
test('Linux discovered app catalogue prioritizes GUI launchers not the dpkg fixture',async()=>{
  const gui=[{name:'Future Widget App',source:'xdg_desktop_entry',
    startup_wm_class:'future-widget'}];
  const inventory=async()=>jsonResult({backend:'xdg_desktop_entries',
    data:gui,count:1,returned:1});
  const r=await detectedApps({filter:'Widget'},{platform:'linux',guiApps:inventory});
  assert.equal(r.backend,'xdg_desktop_entries');
  assert.equal(r.total,1);
  assert.equal(r.apps[0].installation,'gui_launcher_entry');
  assert.equal(r.apps[0].source,'xdg_desktop_entry');
  assert.equal(r.apps[0].startup_wm_class,'future-widget');
  assert.deepEqual(r.apps[0].destinations,[]);
});
test('GUI WM_CLASS alias is exact and does not bypass a scoped AX root',async()=>{
  const gui=[{name:'Future Widget App',source:'xdg_desktop_entry',
    startup_wm_class:'future-widget'}];
  const get=async()=>jsonResult({backend:'xdg_desktop_entries',
    data:gui,count:1,returned:1});
  const app=detectedAppRows(gui).apps[0].id;
  const window={id:'win-8',pid:456,app:'future-widget',
    title:'Widget Dashboard',active:true};
  const adapters={platform:'linux',guiApps:get,
    listWindows:async()=>jsonResult([window]),
    uiSnapshot:async()=>jsonResult({nodes:[{
      id:'linux:456:r.0',pid:456,app:'future-widget',window:'Widget Dashboard',
      role:'Window',name:'Widget Dashboard',enabled:true,
    }]})};
  const r=await inspectDetectedApp({app,intent:'inspect'},adapters);
  assert.equal(r.status,'inspected');
  assert.equal(r.verified,true);
  const rejected=await inspectDetectedApp({app,intent:'inspect'},{
    ...adapters,listWindows:async()=>jsonResult([{...window,app:'future-widget-evil'}]),
    uiSnapshot:async()=>{throw Error('must not inspect similar process names')},
  });
  assert.equal(rejected.status,'blocked');
});

test('deleted GUI launcher invalidates a previously listed local app ID',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'remcp-xdg-revoked-'));
  const local=path.join(root,'user');
  const appsDir=path.join(local,'applications');
  const file=path.join(appsDir,'org.example.FutureWidget.desktop');
  try{
    await mkdir(appsDir,{recursive:true});
    await writeFile(file,entry('Future Widget App','StartupWMClass=future-widget'));
    const guiApps=()=>linuxGuiInventory({
      xdgDataHome:local,xdgDataDirs:path.join(root,'empty'),desktop:'GNOME',
    });
    const listed=await detectedApps({filter:'Future'},{platform:'linux',guiApps});
    assert.equal(listed.total,1);
    const app=listed.apps[0].id;
    await rm(file);
    const inspected=await inspectDetectedApp({app,intent:'inspect'},{
      platform:'linux',guiApps,
      listWindows:async()=>{throw Error('must not probe uninstalled app')},
    });
    assert.equal(inspected.status,'blocked');
    assert.equal(inspected.reason,'installed_app_identity_not_unique_or_missing');
  }finally{await rm(root,{recursive:true,force:true})}
});
test('GUI executable hint must be exact and is not a command permission',async()=>{
  const gui=[{name:'New GUI Product',source:'xdg_desktop_entry',
    process_hint:'widget-process'}];
  const get=async()=>jsonResult({backend:'xdg_desktop_entries',
    data:gui,count:1,returned:1});
  const app=detectedAppRows(gui).apps[0];
  assert.deepEqual(app.destinations,[]);
  assert.equal(app.process_hint,undefined);
  const window={id:'w1',pid:533,app:'widget-process',title:'Product',active:true};
  const adapters={
    platform:'linux',guiApps:get,
    listWindows:async()=>jsonResult([window]),
    uiSnapshot:async()=>jsonResult({nodes:[{
      id:'linux:533:r.0',pid:533,app:'widget-process',
      window:'Product',role:'Window',name:'Product',
    }]}),
  };
  // Even an exact Exec basename is not evidence of the selected GUI: a
  // launcher can use chromium, sh, or any other shared process.
  const good=await inspectDetectedApp({app:app.id,intent:'inspect'},adapters);
  assert.equal(good.status,'blocked');
  assert.equal(good.reason,'verified_app_window_not_found');
  const bad=await inspectDetectedApp({app:app.id,intent:'inspect'},{
    ...adapters,listWindows:async()=>jsonResult([{...window,app:'widget-process-other'}]),
    uiSnapshot:async()=>{throw Error('must not scan lookalike app')},
  });
  assert.equal(bad.status,'blocked');
});
