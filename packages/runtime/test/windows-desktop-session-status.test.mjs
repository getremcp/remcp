import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  WINDOWS_DESKTOP_PROBE,
  classifyWindowsDesktopSession,
  assertWindowsInteractiveDesktop,
  guardWindowsDesktopTool,
  windowsDesktopSessionStatus,
  createWindowsDesktopSessionCache,
} from '../src/extended/desktop-windows-session.mjs';
import { computerSnapshot, resolveComputerDesktopSession } from '../src/extended/desktop-computer-snapshot.mjs';
import { computerAction, computerActionRequiresDesktop, desktopHandlers } from '../src/extended/desktop-computer-actions.mjs';
import { takeScreenshotTool } from '../src/tools/files-screenshots.mjs';
import { recordScreen } from '../src/extended/diagnostics-recording.mjs';
import { readFile } from 'node:fs/promises';
import { filterCoreToolsForLiveDesktop, supportedRuntimeToolDefinitions } from '../src/tool-availability.mjs';
import { supportedRuntimeOperationNames } from '../src/compact-catalog.mjs';
import { supportedCoreTools } from '../src/catalog.mjs';
import {
  WINDOWS_SESSION_SCOPED_CAPABILITIES,
  limitWindowsSessionCapabilities,
  capabilitySnapshot,
  advertisedExtendedTools,
} from '../src/extended/catalog.mjs';

test('Session 0 is unavailable even when PowerShell claims interactive', () => {
  assert.deepEqual(classifyWindowsDesktopSession({ sessionId:0, userInteractive:true }), {
    status:'unavailable', available:false,
    reason:'windows_session_0',
    next_step:'sign_in_to_interactive_desktop',
  });
});

test('noninteractive process in a numbered session is unavailable', () => {
  assert.equal(classifyWindowsDesktopSession({ sessionId:1, userInteractive:false }).reason, 'noninteractive_process');
  assert.equal(classifyWindowsDesktopSession({ sessionId:1, userInteractive:false }).available, false);
});

test('interactive Windows user session is available', () => {
  assert.deepEqual(classifyWindowsDesktopSession({ sessionId:2, userInteractive:true }), {
    status:'available', available:true,
  });
});

test('untrusted or incomplete session metadata never falsely blocks the desktop', () => {
  for (const value of [
    null, {}, { sessionId:'0', userInteractive:false },
    { sessionId:-1, userInteractive:false },
    { sessionId:1, userInteractive:'true' },
  ]) {
    assert.deepEqual(classifyWindowsDesktopSession(value), {
      status:'unknown', available:null, reason:'invalid_session_probe',
    });
  }
});

test('bounded native probe only reports session metadata, no user identities', async () => {
  let options;
  const status = await windowsDesktopSessionStatus({
    runPowerShellFn:async (script, settings) => {
      assert.equal(script, WINDOWS_DESKTOP_PROBE);
      assert.match(script, /GetCurrentProcess\(\)/);
      assert.doesNotMatch(script, /Win32_ComputerSystem|UserName|EnvironmentVariable|Credential|Get-Process\s+explorer/);
      options=settings;
      return { stdout:'{"sessionId":0,"userInteractive":false}' };
    },
  });
  assert.equal(status.available, false);
  assert.equal(status.reason, 'windows_session_0');
  assert.ok(options.timeout <= 6000);
});

test('PowerShell probe failure is unknown and does not block a user desktop', async () => {
  const status = await windowsDesktopSessionStatus({
    runPowerShellFn:async () => { throw new Error('transient Windows PowerShell error'); },
  });
  assert.deepEqual(status, { status:'unknown', available:null, reason:'session_probe_failed' });
});

test('tool discovery caches Windows session status only for a bounded interval', async () => {
  let calls=0;
  let now=100;
  const status=async () => {
    calls++;
    return {status:calls === 1 ? 'unavailable' : 'available',available:calls > 1};
  };
  const cached=createWindowsDesktopSessionCache({probe:status,ttlMs:2000,nowFn:() => now});
  assert.equal((await cached()).available,false);
  now=2099;
  assert.equal((await cached()).available,false);
  assert.equal(calls,1,'repeated discovery should not launch a new PowerShell process');
  now=2100;
  assert.equal((await cached()).available,true);
  assert.equal(calls,2,'expired discovery must observe a new signed-in session');
});

test('concurrent discovery calls coalesce into one Windows session probe', async () => {
  let calls=0;
  let finish;
  const pending=new Promise(resolve => { finish=resolve; });
  const cached=createWindowsDesktopSessionCache({
    probe:async () => { calls++; return pending; },
    ttlMs:2000,
    nowFn:() => 10,
  });
  const responses=[cached(),cached(),cached()];
  await Promise.resolve();
  finish({status:'available',available:true});
  const results=await Promise.all(responses);
  assert.equal(calls,1);
  assert.ok(results.every(result => result.available === true));
});

test('capability cache fails closed on probe failure, then retries after TTL', async () => {
  let now=0;
  let calls=0;
  const cached=createWindowsDesktopSessionCache({
    probe:async () => {
      calls++;
      if (calls===1) throw new Error('Windows PowerShell failed');
      return {status:'available',available:true};
    },
    ttlMs:500,
    nowFn:() => now,
  });
  assert.deepEqual(await cached(),{
    status:'unknown',available:null,reason:'session_probe_failed',
  });
  now=499;
  assert.equal((await cached()).available,null);
  assert.equal(calls,1);
  now=500;
  assert.equal((await cached()).available,true);
  assert.equal(calls,2);
});

test('computer snapshot skips native Windows probes when session is unavailable', async () => {
  const session = await resolveComputerDesktopSession({
    platform:'win32',
    available:true,
    windowsProbe:async () => classifyWindowsDesktopSession({sessionId:0, userInteractive:false}),
  });
  assert.equal(session.available, false);
  assert.equal(session.reason, 'windows_session_0');
});

test('computer snapshot does not run Windows session probe on Linux/macOS or headless Linux', async () => {
  let calls=0;
  const probe=async () => { calls++; throw new Error('must never call'); };
  for (const platform of ['linux','darwin']) {
    assert.deepEqual(await resolveComputerDesktopSession({platform,available:true,windowsProbe:probe}),
      {status:'available',available:true});
  }
  assert.deepEqual(await resolveComputerDesktopSession({platform:'linux',available:false,windowsProbe:probe}),
    {status:'unavailable',available:false,reason:'no_graphical_session'});
  assert.equal(calls,0);
});

test('computer_snapshot skips Windows Session 0 UI and pixel capture without noisy errors', async () => {
  const response = await computerSnapshot({
    include_ui:true,
    include_screenshot:true,
    include_ocr:true,
    include_browser:false,
    browser_readiness:false,
  }, {
    desktopSessionProbe:async () => classifyWindowsDesktopSession({
      sessionId:0, userInteractive:false,
    }),
  });
  const snapshot = response.structuredContent;
  assert.equal(snapshot.desktop_session?.status, 'unavailable');
  assert.equal(snapshot.desktop_session?.reason, 'windows_session_0');
  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(snapshot.displays, []);
  assert.deepEqual(snapshot.cursor, {x:null,y:null});
  assert.equal(snapshot.ui?.unavailable, true);
  assert.equal(snapshot.ui?.reason, 'windows_session_0');
  assert.equal(snapshot.clipboard?.available, false);
  assert.equal(snapshot.fallback_chain?.desktop_session?.available, false);
  assert.equal(snapshot.fallback_chain?.vision_screenshot?.available, false);
  assert.equal(snapshot.fallback_chain?.accessibility?.available, false);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(response.content.some(part => part.type === 'image'), false);
});

test('Windows native session probe succeeds in a real Windows process', {
  skip:process.platform !== 'win32',
}, async () => {
  const status=await windowsDesktopSessionStatus();
  assert.equal(status.status === 'available' || status.status === 'unavailable',true);
  assert.equal(typeof status.available,'boolean');
});

test('native input guard blocks a Session 0 operation before any side effect', async () => {
  let called=0;
  const guarded=guardWindowsDesktopTool(async () => { called++; }, {
    platform:'win32',
    probe:async () => classifyWindowsDesktopSession({sessionId:0,userInteractive:false}),
  });
  await assert.rejects(() => guarded({action:'move',x:4,y:5}), /Windows desktop unavailable \(windows_session_0\)/);
  assert.equal(called,0);
});

test('native input guard fails closed when Windows session cannot be verified', async () => {
  let called=0;
  const guarded=guardWindowsDesktopTool(async () => { called++; }, {
    platform:'win32',
    probe:async () => ({status:'unknown',available:null,reason:'session_probe_failed'}),
  });
  await assert.rejects(() => guarded(), /session_probe_failed/);
  assert.equal(called,0);
});

test('native input guard preserves successful interactive operations and arguments', async () => {
  let seen;
  const guarded=guardWindowsDesktopTool(async (...args) => { seen=args; return {ok:true}; }, {
    platform:'win32',
    probe:async () => classifyWindowsDesktopSession({sessionId:1,userInteractive:true}),
  });
  assert.deepEqual(await guarded({action:'move',x:9},'other'),{ok:true});
  assert.deepEqual(seen,[{action:'move',x:9},'other']);
});

test('native desktop guard does not probe on Linux or macOS', async () => {
  for (const platform of ['linux','darwin']) {
    const result=await guardWindowsDesktopTool(async () => 'allowed', {
      platform,
      probe:async () => { throw new Error('unexpected Windows-only probe'); },
    })();
    assert.equal(result,'allowed');
  }
});

test('all standalone native desktop tools have the Windows session gate', async () => {
  const names=['list_windows','window_action','launch_app','ui_snapshot','ui_find',
    'ui_action','type_text','keyboard','pointer','drag_drop','scroll',
    'wait_for_ui','clipboard','display_inventory','screenshot_region',
    'open_path','reveal_path','notification'];
  const source=await readFile(new URL('../src/extended/desktop-computer-actions.mjs',import.meta.url),'utf8');
  for (const name of names) {
    assert.equal(typeof desktopHandlers[name],'function',name);
    assert.ok(source.includes("'"+name+"'"),name);
  }
  assert.match(source,/desktopHandlers\[name\] = guardWindowsDesktopTool\(desktopHandlers\[name\]\)/);
  assert.equal(desktopHandlers.computer_snapshot,computerSnapshot);
  assert.equal(typeof desktopHandlers.computer_action,'function');
  assert.notEqual(desktopHandlers.computer_action,computerAction);
});

test('standalone screenshot checks the Windows session before allocating capture files', async () => {
  const source=await readFile(new URL('../src/tools/files-screenshots.mjs',import.meta.url),'utf8');
  assert.match(source,/export async function takeScreenshotTool\(args\)\s*\{[\s\S]{0,160}await assertWindowsInteractiveDesktop\(\)/);
  assert.equal(typeof takeScreenshotTool,'function');
});

test('screen recording checks Windows session before staging temporary files or invoking ffmpeg', async () => {
  const source=await readFile(new URL('../src/extended/diagnostics-recording.mjs',import.meta.url),'utf8');
  assert.match(source,/export async function recordScreen\(args\)\s*\{[\s\S]{0,180}await assertWindowsInteractiveDesktop\(\)/);
  assert.equal(typeof recordScreen,'function');
});

test('computer_action preserves explicit CDP browser actions and non-UI waits', () => {
  for (const action of ['click','type','scroll','focus','invoke','set_value','select','toggle']) {
    assert.equal(computerActionRequiresDesktop({action,target:'browser'}),false,action);
  }
  assert.equal(computerActionRequiresDesktop({action:'keyboard',target:'browser',key:'Enter'}),false);
  assert.equal(computerActionRequiresDesktop({action:'wait',wait_ms:10}),false);
  assert.equal(computerActionRequiresDesktop({
    action:'batch',
    steps:[{action:'click',target:'browser'},{action:'scroll',target:'browser'}],
  }),false);
});

test('computer_action requires a real desktop for native actions, including misleading browser targets', () => {
  for (const action of ['pointer','window','ui','clipboard','drag','notification',
    'minimize','maximize','restore','move','close','multi_edit','multi_select']) {
    assert.equal(computerActionRequiresDesktop({action,target:'browser'}),true,action);
  }
  for (const action of ['click','type','keyboard','scroll','focus']) {
    assert.equal(computerActionRequiresDesktop({action,target:'auto'}),true,action);
  }
  assert.equal(computerActionRequiresDesktop({action:'keyboard',target:'browser',shortcut:'CTRL+C'}),true);
  assert.equal(computerActionRequiresDesktop({
    action:'batch',
    steps:[{action:'click',target:'browser'},{action:'pointer',x:1,y:1}],
  }),true);
  assert.equal(computerActionRequiresDesktop({action:'batch'}),true);
});

test('Windows Session 0 capability filter hides native GUI but keeps browser and system tools', () => {
  const base = Object.fromEntries(WINDOWS_SESSION_SCOPED_CAPABILITIES.map(name => [name,true]));
  Object.assign(base, {
    browser_cdp:true, browser_evaluate:true, services:true,
    documents:true, logs:true, apps:true, power:true,
  });
  const blocked = limitWindowsSessionCapabilities(base, {
    platform:'win32',
    sessionStatus:{status:'unavailable',available:false,reason:'windows_session_0'},
  });
  for (const name of WINDOWS_SESSION_SCOPED_CAPABILITIES) {
    assert.equal(blocked[name],false,name);
    assert.equal(base[name],true,'source object must not be mutated: '+name);
  }
  for (const name of ['browser_cdp','browser_evaluate','services','documents','logs','apps','power']) {
    assert.equal(blocked[name],true,name);
  }
});

test('Windows capability filter fails closed on unreadable status and preserves valid interactive sessions', () => {
  const base={desktop_session:true,ui:true,pointer:true,browser_cdp:true};
  assert.equal(limitWindowsSessionCapabilities(base, {
    platform:'win32',sessionStatus:{status:'available',available:true},
  }),base);
  assert.equal(limitWindowsSessionCapabilities(base, {
    platform:'linux',sessionStatus:{status:'unavailable',available:false},
  }),base);
  assert.equal(limitWindowsSessionCapabilities(base, {
    platform:'darwin',sessionStatus:null,
  }),base);
  assert.equal(limitWindowsSessionCapabilities(base, {
    platform:'win32',sessionStatus:null,
  }).pointer,false);
  assert.equal(limitWindowsSessionCapabilities(base, {
    platform:'win32',sessionStatus:{status:'unknown',available:null},
  }).desktop_session,false);
});

test('native Windows advertised tools reflect actual interactive session readiness', {
  skip:process.platform !== 'win32',
}, async () => {
  const session=await windowsDesktopSessionStatus();
  const capabilities=await capabilitySnapshot();
  const advertised=new Set((await advertisedExtendedTools()).map(item => item.name));
  if (session.available === true) {
    assert.equal(capabilities.ui,true);
    assert.ok(advertised.has('list_windows'));
    assert.ok(advertised.has('pointer'));
  } else {
    assert.equal(capabilities.ui,false);
    assert.equal(capabilities.pointer,false);
    assert.equal(capabilities.desktop_session,false);
    for (const name of ['list_windows','pointer','ui_snapshot','screenshot_region','launch_app','record_screen']) {
      assert.equal(advertised.has(name),false,name);
    }
    assert.ok(advertised.has('computer_snapshot'));
    assert.ok(advertised.has('computer_action'));
  }
});

test('core screenshot discovery is filtered only for noninteractive Windows', () => {
  const sample = ['read_file','take_screenshot','read_image','get_system_info']
    .map(name => ({ name }));
  const unavailable = filterCoreToolsForLiveDesktop(sample, {
    platform:'win32',
    capabilities:{desktop_session:false},
  });
  assert.deepEqual(unavailable.map(tool => tool.name),
    ['read_file','read_image','get_system_info']);
  assert.equal(filterCoreToolsForLiveDesktop(sample, {
    platform:'win32',capabilities:{desktop_session:true},
  }),sample);
  assert.equal(filterCoreToolsForLiveDesktop(sample, {
    platform:'linux',capabilities:{desktop_session:false},
  }),sample);
  assert.equal(filterCoreToolsForLiveDesktop(sample, {
    platform:'darwin',capabilities:{desktop_session:false},
  }),sample);
  assert.equal(sample.length,4,'core tool catalog must remain immutable');
});

test('Windows login/logout changes native tool discovery without removing browser or files', async () => {
  const initial = Object.fromEntries(WINDOWS_SESSION_SCOPED_CAPABILITIES.map(name => [name,true]));
  Object.assign(initial, {
    browser_cdp:true, browser_evaluate:true, services:true,
    documents:true, logs:true, apps:true, power:true,
  });
  const toolNames = async status => {
    const capabilities = limitWindowsSessionCapabilities(initial, {
      platform:'win32', sessionStatus:status,
    });
    const core = filterCoreToolsForLiveDesktop(supportedCoreTools(), {
      platform:'win32', capabilities,
    });
    const extended = await advertisedExtendedTools(capabilities);
    return new Set([...core,...extended].map(tool => tool.name));
  };
  const signedIn = {status:'available',available:true};
  const signedOut = {status:'unavailable',available:false,reason:'windows_session_0'};
  const before = await toolNames(signedOut);
  const afterLogin = await toolNames(signedIn);
  const afterLogout = await toolNames(signedOut);
  for (const name of ['take_screenshot','screenshot_region','list_windows',
    'ui_snapshot','pointer','keyboard','clipboard','notification']) {
    assert.equal(before.has(name),false,'hidden before login: '+name);
    assert.equal(afterLogin.has(name),true,'restored after login: '+name);
    assert.equal(afterLogout.has(name),false,'hidden again after logout: '+name);
  }
  for (const name of ['read_file','read_image','get_system_info','computer_snapshot',
    'computer_action','browser_tabs','browser_navigate','browser_action',
    'service','network','read_document']) {
    assert.equal(before.has(name),true,'available in Session 0: '+name);
    assert.equal(afterLogin.has(name),true,'available after login: '+name);
    assert.equal(afterLogout.has(name),true,'available after logout: '+name);
  }
  assert.deepEqual([...afterLogout].sort(),[...before].sort());
  assert.equal(new Set([...afterLogin].filter(name => !before.has(name))).size > 0,true);
  assert.equal(initial.desktop_session,true,'dynamic capability transition must not mutate input');
});

test('native Windows compact and ordinary tool lists agree about screenshot availability', {
  skip:process.platform !== 'win32',
}, async () => {
  const status = await windowsDesktopSessionStatus();
  const {core, extended} = await supportedRuntimeToolDefinitions();
  const full = new Set([...core,...extended].map(item => item.name));
  const compact = await supportedRuntimeOperationNames();
  assert.ok(full.has('read_image'));
  assert.ok(full.has('read_file'));
  assert.ok(compact.has('read_image'));
  assert.ok(compact.has('read_file'));
  assert.ok(full.has('computer_snapshot'));
  assert.ok(compact.has('computer_snapshot'));
  const available=status.available===true;
  assert.equal(full.has('take_screenshot'),available);
  assert.equal(compact.has('take_screenshot'),available);
  assert.equal(full.has('list_windows'),available);
  assert.equal(compact.has('list_windows'),available);
});

test('native Windows Session 0 guard rejects pointer and standalone screenshot', {
  skip:process.platform !== 'win32',
}, async () => {
  const status=await windowsDesktopSessionStatus();
  if (status.available === true) return; // An interactive Windows guest stays untouched.
  assert.equal(status.reason,'windows_session_0');
  await assert.rejects(() => desktopHandlers.pointer({action:'move',x:1,y:1}), /windows_session_0/);
  await assert.rejects(() => desktopHandlers.computer_action({action:'pointer',x:1,y:1}), /windows_session_0/);
  await assert.rejects(() => takeScreenshotTool({}), /windows_session_0/);
  await assert.rejects(() => recordScreen({duration_seconds:1}), /windows_session_0/);
});
