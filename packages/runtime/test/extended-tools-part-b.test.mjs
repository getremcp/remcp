import { readBrowserSource } from './helpers/browser-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  allExtendedTools,
  advertisedExtendedTools,
  capabilitySnapshot,
  desktopShellCapabilitySnapshot,
  documentCapabilitySnapshot,
  powerCapabilitySnapshot,
  extendedToolDefinitions,
  extendedToolHandlers,
} from '../src/extended/catalog.mjs';
import { browserActionInputValue, browserActionLocatorText, browserAutoLaunchAvailable, browserEvaluate, browserNavigate, browserRemoteEnabled, browserScrollDeltas, browserSnapshot, browserTabs, browserWait } from '../src/extended/browser.mjs';
import { displayInventoryAvailable, parseWlrRandrOutput, resolveLinuxDisplayInventory } from '../src/extended/desktop-linux.mjs';
import { compactNetworkSummary, gnomeScreencastSupported, linuxListenerBackend, parseAvfoundationScreenInput, recordScreen, recordScreenAvailable, recordScreenBackend, resolveRecordScreenFfmpeg, validateRecordingDestinationFormat } from '../src/extended/diagnostics.mjs';
import { hasTool, invokeTool } from '../src/invoke.mjs';

const EXPECTED = [
  'computer_snapshot','computer_action','list_windows','window_action','launch_app',
  'ui_snapshot','ui_find','ui_action','type_text','keyboard','pointer','drag_drop',
  'scroll','wait_for_ui','clipboard','display_inventory','screenshot_region',
  'open_path','reveal_path','notification',
  'browser_tabs','browser_navigate','browser_snapshot','browser_find','browser_action',
  'browser_wait','browser_evaluate',
  'service','event_log','network','installed_apps','environment','audio','power_action','record_screen',
  'read_document','edit_spreadsheet','edit_document','pdf_action',
];


test('installed Chromium keeps the browser tool group discoverable before CDP starts', async () => {
  const previousBinary = process.env.REMCP_BROWSER_BINARY;
  const previousEndpoint = process.env.REMCP_CDP_URL;
  process.env.REMCP_BROWSER_BINARY = process.execPath;
  delete process.env.REMCP_CDP_URL;
  try {
    assert.equal(browserAutoLaunchAvailable(), true);
    const capabilities = await capabilitySnapshot();
    assert.equal(capabilities.browser_cdp, true, 'a launchable local Chromium capability should not disappear just because CDP is not started yet');
  } finally {
    if (previousBinary == null) delete process.env.REMCP_BROWSER_BINARY; else process.env.REMCP_BROWSER_BINARY = previousBinary;
    if (previousEndpoint == null) delete process.env.REMCP_CDP_URL; else process.env.REMCP_CDP_URL = previousEndpoint;
  }
});

test('macOS record_screen resolves Homebrew ffmpeg even when launchd PATH cannot see it', () => {
  const none = () => false;
  const homebrewOnly = file => file === '/opt/homebrew/bin/ffmpeg';
  assert.equal(resolveRecordScreenFfmpeg({
    platform:'darwin',
    commandExistsFn:none,
    existsSyncFn:homebrewOnly,
  }), '/opt/homebrew/bin/ffmpeg');
  assert.equal(recordScreenAvailable({
    platform:'darwin',
    commandExistsFn:none,
    existsSyncFn:homebrewOnly,
  }), true);
});

test('macOS record_screen selects the actual AVFoundation screen input instead of a fixed camera index', () => {
  const inventory = `
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] OBS Virtual Camera
[AVFoundation indev @ 0x1] [2] Elgato Virtual Camera
[AVFoundation indev @ 0x1] [3] Capture screen 0
`;
  assert.equal(parseAvfoundationScreenInput(inventory), '3');
  assert.equal(parseAvfoundationScreenInput('[AVFoundation indev @ 0x1] [1] OBS Virtual Camera'), null);
});

test('record_screen capability is advertised only when a real recorder backend exists', () => {
  const none = () => false;
  const ffmpegOnly = name => name === 'ffmpeg';
  const waylandOnly = name => name === 'wf-recorder' || name === 'timeout';
  const gnomeOnly = name => name === 'gjs';

  assert.equal(recordScreenAvailable({ platform:'darwin', commandExistsFn:none }), false);
  assert.equal(recordScreenAvailable({ platform:'darwin', commandExistsFn:ffmpegOnly }), true);
  assert.equal(recordScreenAvailable({ platform:'win32', commandExistsFn:none }), false);
  assert.equal(recordScreenAvailable({ platform:'win32', commandExistsFn:ffmpegOnly }), true);
  assert.equal(recordScreenAvailable({ platform:'linux', wayland:true, commandExistsFn:none }), false);
  assert.equal(recordScreenAvailable({ platform:'linux', wayland:true, commandExistsFn:waylandOnly }), true);
  assert.equal(recordScreenAvailable({
    platform:'linux',
    wayland:true,
    desktop:'ubuntu:GNOME',
    sessionBus:'unix:path=/run/user/1000/bus',
    gnomeSupported:true,
    commandExistsFn:gnomeOnly,
  }), true, 'GNOME Wayland should advertise its native screencast backend without wf-recorder');
  assert.equal(recordScreenBackend({
    platform:'linux',
    wayland:true,
    desktop:'ubuntu:GNOME',
    sessionBus:'unix:path=/run/user/1000/bus',
    gnomeSupported:false,
    commandExistsFn:gnomeOnly,
  }), null, 'GNOME candidate detection alone must not advertise a recorder before ScreencastSupported is confirmed');
  assert.equal(recordScreenBackend({
    platform:'linux',
    wayland:true,
    desktop:'ubuntu:GNOME',
    sessionBus:'unix:path=/run/user/1000/bus',
    gnomeSupported:true,
    commandExistsFn:gnomeOnly,
  }), 'gnome-shell');
  assert.equal(recordScreenBackend({
    platform:'linux',
    wayland:true,
    desktop:'ubuntu:GNOME',
    sessionBus:'',
    gnomeSupported:true,
    commandExistsFn:gnomeOnly,
  }), null, 'GNOME detection without the user session bus must fail closed');
  assert.equal(recordScreenBackend({
    platform:'linux',
    wayland:true,
    desktop:'KDE',
    gnomeSessionMode:'',
    sessionBus:'unix:path=/run/user/1000/bus',
    commandExistsFn:gnomeOnly,
  }), null, 'gjs alone must not make non-GNOME Wayland sessions advertise the GNOME backend');
  assert.equal(recordScreenBackend({
    platform:'linux',
    wayland:true,
    desktop:'KDE',
    gnomeSessionMode:'',
    sessionBus:'unix:path=/run/user/1000/bus',
    commandExistsFn:waylandOnly,
  }), 'wf-recorder', 'non-GNOME Wayland keeps the existing wf-recorder fallback');
  assert.equal(recordScreenAvailable({ platform:'linux', wayland:true, commandExistsFn:ffmpegOnly }), false);
  assert.equal(recordScreenAvailable({ platform:'linux', wayland:false, display:'', commandExistsFn:none }), false);
  assert.equal(recordScreenAvailable({ platform:'linux', wayland:false, display:'', commandExistsFn:ffmpegOnly }), false);
  assert.equal(recordScreenAvailable({ platform:'linux', wayland:false, display:':0', commandExistsFn:ffmpegOnly }), true);
});

test('GNOME record_screen support probe checks ScreencastSupported and fails closed', async () => {
  const gjsOnly = name => name === 'gjs';
  let calls = 0;
  const base = {
    platform:'linux',
    wayland:true,
    desktop:'GNOME',
    gnomeSessionMode:'',
    sessionBus:'unix:path=/run/user/1000/bus',
    commandExistsFn:gjsOnly,
    cacheMs:0,
  };
  assert.equal(await gnomeScreencastSupported({
    ...base,
    runFileFn:async () => {
      calls += 1;
      return { code:0, stdout:'true\n', stderr:'' };
    },
  }), true);
  assert.equal(await gnomeScreencastSupported({
    ...base,
    runFileFn:async () => {
      calls += 1;
      return { code:0, stdout:'false\n', stderr:'' };
    },
  }), false);
  assert.equal(await gnomeScreencastSupported({
    ...base,
    runFileFn:async () => {
      calls += 1;
      return { code:1, stdout:'', stderr:'no service' };
    },
  }), false);
  const before = calls;
  assert.equal(await gnomeScreencastSupported({
    ...base,
    sessionBus:'',
    runFileFn:async () => {
      calls += 1;
      return { code:0, stdout:'true\n', stderr:'' };
    },
  }), false);
  assert.equal(calls, before, 'no D-Bus probe should run when the GNOME session candidate is absent');

  let releaseProbe;
  let concurrentCalls = 0;
  const pendingProbe = new Promise(resolve => { releaseProbe = resolve; });
  const concurrentOptions = {
    ...base,
    desktop:'GNOME-Concurrent-Probe',
    cacheMs:15_000,
    nowFn:() => 123_456,
    runFileFn:async () => {
      concurrentCalls += 1;
      await pendingProbe;
      return { code:0, stdout:'true\n', stderr:'' };
    },
  };
  const first = gnomeScreencastSupported(concurrentOptions);
  const second = gnomeScreencastSupported(concurrentOptions);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(concurrentCalls, 1, 'concurrent capability polls must share one GNOME D-Bus probe');
  releaseProbe();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('record_screen destination extension must match the actual container', () => {
  assert.doesNotThrow(() => validateRecordingDestinationFormat('', 'webm'));
  assert.doesNotThrow(() => validateRecordingDestinationFormat('/tmp/capture', 'webm'));
  assert.doesNotThrow(() => validateRecordingDestinationFormat('/tmp/capture.WEBM', 'webm'));
  assert.doesNotThrow(() => validateRecordingDestinationFormat('/tmp/capture.mp4', 'mp4'));
  assert.throws(
    () => validateRecordingDestinationFormat('/tmp/capture.mp4', 'webm'),
    /produces \.webm; destination must use \.webm/
  );
});

test('record_screen never invents an X11 display for a headless Linux host', async () => {
  const source = await readFile(new URL('../src/extended/diagnostics.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env\.DISPLAY\s*\|\|\s*['"]:\d/);
});

test('record_screen fails closed on a headless Linux X11 host before invoking ffmpeg', async t => {
  if (process.platform !== 'linux') return t.skip('Linux-specific regression');
  const previousSession = process.env.XDG_SESSION_TYPE;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousDisplay = process.env.DISPLAY;
  try {
    process.env.XDG_SESSION_TYPE = 'x11';
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    await assert.rejects(
      recordScreen({ duration_seconds:1, fps:1 }),
      /active X11 DISPLAY is required/
    );
  } finally {
    if (previousSession == null) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = previousSession;
    if (previousWayland == null) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousDisplay == null) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
  }
});

test('browser_snapshot restores page scroll after selector screenshot capture', async () => {
  const source = await readBrowserSource();
  assert.match(source, /originalScrollX=scrollX, originalScrollY=scrollY/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /window\.scrollTo\(\{left:\$\{restoreScroll\.x\},top:\$\{restoreScroll\.y\}/);
});

test('browser_action separates type payload from browser text locators and preserves legacy calls', () => {
  assert.equal(
    browserActionInputValue({ selector:'#message', text:'Антон ✓ ReMCP' }, 'type'),
    'Антон ✓ ReMCP',
    'the public browser_action text field must reach Input.insertText',
  );
  assert.equal(browserActionLocatorText({ selector:'#message', text:'typed' }, 'type'), null);
  assert.equal(browserActionLocatorText({ browser_text:'Search', text:'typed' }, 'type'), 'Search');
  assert.equal(browserActionInputValue({ browser_text:'Search', text:'typed' }, 'type'), 'typed');

  assert.equal(browserActionLocatorText({ text:'Search', value:'legacy payload' }, 'type'), 'Search');
  assert.equal(browserActionInputValue({ text:'Search', value:'legacy payload' }, 'type'), 'legacy payload');
  assert.equal(browserActionInputValue({ text:'typed', value:'explicit' }, 'set_value'), 'explicit');
});

test('browser_action scroll normalizes native-style direction and deltas', () => {
  assert.deepEqual(browserScrollDeltas({ direction:'down', wheel_times:3 }), { delta_x:0, delta_y:360 });
  assert.deepEqual(browserScrollDeltas({ direction:'left', wheel_times:2 }), { delta_x:-240, delta_y:0 });
  assert.deepEqual(browserScrollDeltas({ delta_x:25, delta_y:-80 }), { delta_x:25, delta_y:-80 });
  assert.deepEqual(browserScrollDeltas({ delta:90 }), { delta_x:0, delta_y:90 });
  assert.equal(browserScrollDeltas({}), null);
});

test('browser remote control defaults off unless a runtime mode or explicit opt-in is present', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.REMCP_BROWSER_REMOTE_ENABLED;
  try {
    delete process.env.NODE_ENV;
    delete process.env.REMCP_BROWSER_REMOTE_ENABLED;
    assert.equal(browserRemoteEnabled(), false);
    process.env.NODE_ENV = 'development';
    assert.equal(browserRemoteEnabled(), true);
    delete process.env.NODE_ENV;
    process.env.REMCP_BROWSER_REMOTE_ENABLED = '1';
    assert.equal(browserRemoteEnabled(), true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.REMCP_BROWSER_REMOTE_ENABLED; else process.env.REMCP_BROWSER_REMOTE_ENABLED = previousFlag;
  }
});

test('browser_navigate new_tab bootstraps CDP when no page target exists', async () => {
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, options = {}) => {
    seen = { url:String(url), method:options.method || 'GET' };
    return new Response(JSON.stringify({
      id:'created-page',
      type:'page',
      title:'',
      url:'https://example.test/',
      webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/created-page',
    }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  try {
    const result = await browserNavigate({ endpoint:'http://127.0.0.1:9222', action:'new_tab', url:'https://example.test/' });
    assert.equal(seen.method, 'PUT');
    assert.match(seen.url, /\/json\/new\?/);
    assert.equal(result.structuredContent.action, 'new_tab');
    assert.equal(result.structuredContent.target_id, 'created-page');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser CDP rejects non-loopback endpoints before network access', async () => {
  await assert.rejects(() => browserTabs({ endpoint: 'https://example.com:9222' }), /loopback-only/i);
  await assert.rejects(() => browserTabs({ endpoint: 'file:///tmp/socket' }), /http or https/i);
});

test('browser navigation blocks local network destinations by default', async () => {
  const flags = ['REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION', 'REMCP_BROWSER_ALLOW_LOCAL', 'REMCP_ALLOW_LOCAL_BROWSER_NAVIGATION'];
  const previous = flags.map(name => [name, process.env[name]]);
  for (const name of flags) delete process.env[name];
  try {
    for (const url of [
      'http://127.0.0.2:3000/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://localhost/',
    ]) {
      await assert.rejects(() => browserNavigate({ action: 'url', url }), /loopback, private, or link-local/i, url);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('local browser navigation requires an explicit environment opt-in and discovery redirects fail closed', async () => {
  const flags = ['REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION', 'REMCP_BROWSER_ALLOW_LOCAL', 'REMCP_ALLOW_LOCAL_BROWSER_NAVIGATION'];
  const previous = flags.map(name => [name, process.env[name]]);
  const originalFetch = globalThis.fetch;
  let seen;
  process.env.REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION = 'true';
  globalThis.fetch = async (url, options = {}) => {
    seen = { url: String(url), options };
    return new Response(JSON.stringify({
      id: 'local-page',
      type: 'page',
      title: '',
      url: 'http://127.0.0.1:3000/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/local-page',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await browserNavigate({ endpoint: 'http://127.0.0.1:9222', action: 'new_tab', url: 'http://127.0.0.1:3000/' });
    assert.equal(result.structuredContent.target_id, 'local-page');
    assert.equal(seen.options.redirect, 'error');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('production browser navigation requires an explicit public host allowlist', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRemote = process.env.REMCP_BROWSER_REMOTE_ENABLED;
  const previousAllowlist = process.env.REMCP_BROWSER_ALLOWED_HOSTS;
  const localFlags = ['REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION', 'REMCP_BROWSER_ALLOW_LOCAL', 'REMCP_ALLOW_LOCAL_BROWSER_NAVIGATION'];
  const previousLocal = localFlags.map(name => [name, process.env[name]]);
  try {
    process.env.NODE_ENV = 'production';
    process.env.REMCP_BROWSER_REMOTE_ENABLED = '1';
    delete process.env.REMCP_BROWSER_ALLOWED_HOSTS;
    for (const name of localFlags) delete process.env[name];
    await assert.rejects(
      () => browserNavigate({ action: 'url', url: 'https://example.com/' }),
      /REMCP_BROWSER_ALLOWED_HOSTS/,
    );
    process.env.REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION = '1';
    await assert.rejects(
      () => browserNavigate({ action: 'url', url: 'https://example.com/' }),
      /REMCP_BROWSER_ALLOWED_HOSTS/,
    );
    delete process.env.REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION;
    process.env.REMCP_BROWSER_ALLOWED_HOSTS = 'example.com';
    await assert.rejects(
      () => browserNavigate({ action: 'url', url: 'https://example.com/' }),
      /IP-literal allowlist/,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousRemote === undefined) delete process.env.REMCP_BROWSER_REMOTE_ENABLED; else process.env.REMCP_BROWSER_REMOTE_ENABLED = previousRemote;
    if (previousAllowlist === undefined) delete process.env.REMCP_BROWSER_ALLOWED_HOSTS; else process.env.REMCP_BROWSER_ALLOWED_HOSTS = previousAllowlist;
    for (const [name, value] of previousLocal) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('browser navigation and evaluation refuse local-file schemes', async () => {
  await assert.rejects(() => browserNavigate({ action: 'url', url: 'file:///etc/passwd' }), /must use http or https/i);
  await assert.rejects(() => browserEvaluate({ expression: 'location.href = "file:///etc/passwd"' }), /blocked local browser scheme/i);
  await assert.rejects(() => browserEvaluate({ expression: 'location.href = "http://127.0.0.1:3000/"' }), /blocked private browser destination/i);
});

test('browser CDP rejects file pages and expression waits that target local schemes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'file-page', type: 'page', title: 'Local', url: 'file:///etc/passwd',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/file-page',
  }]), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => browserSnapshot({ endpoint: 'http://127.0.0.1:9222' }), /no debuggable|unsafe|must use/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await assert.rejects(() => browserWait({ condition: 'expression', expression: 'location.href = "file:///etc/passwd"' }), /blocked local browser scheme/i);
});

test('browser CDP rejects a non-loopback WebSocket target returned by a local endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'page-1', type: 'page', title: 'Fixture', url: 'https://example.test/',
    webSocketDebuggerUrl: 'ws://example.com/devtools/page/1',
  }]), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    // Invalid socket metadata is filtered before target selection or connection.
    await assert.rejects(() => browserSnapshot({ endpoint: 'http://127.0.0.1:9222' }), /no debuggable page target/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JSON-oriented extended tools expose object-root structuredContent alongside text fallback', async () => {
  const result = await invokeTool('environment', {});
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.platform, process.platform);
  assert.equal(typeof result.content?.[0]?.text, 'string');
  assert.equal(JSON.parse(result.content[0].text).platform, process.platform);

  const { jsonResult } = await import('../src/extended/common.mjs');
  const arrayResult = jsonResult([{ id: 1 }]);
  assert.deepEqual(arrayResult.structuredContent, { data: [{ id: 1 }] });
  assert.deepEqual(JSON.parse(arrayResult.content[0].text), [{ id: 1 }]);
});

test('the release contract contains 83 unique tools: 44 existing plus 39 computer-use tools', async () => {
  const { advertisedTools } = await import('../src/catalog.mjs');
  const names = [...advertisedTools(), ...allExtendedTools()].map(tool => tool.name);
  assert.equal(names.length, 83);
  assert.equal(new Set(names).size, 83);
});