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
  'browser_wait','browser_devtools','browser_evaluate',
  'service','event_log','network','installed_apps','environment','audio','power_action','record_screen',
  'read_document','edit_spreadsheet','edit_document','pdf_action',
];

test('desktop shell capabilities disappear on headless Linux and stay native on Windows/macOS', () => {
  const allCommands = () => true;
  const noCommands = () => false;

  assert.deepEqual(
    desktopShellCapabilitySnapshot({ platform:'linux', env:{}, commandExistsFn:allCommands }),
    { desktop_session:false, desktop_open:false },
    'installed desktop utilities must not expose desktop actions without an active graphical session',
  );
  assert.deepEqual(
    desktopShellCapabilitySnapshot({ platform:'linux', env:{ DISPLAY:':0' }, commandExistsFn:noCommands }),
    { desktop_session:true, desktop_open:false },
    'a Linux graphical session supports direct application launch but system-associated open/reveal still requires xdg-open',
  );
  assert.deepEqual(
    desktopShellCapabilitySnapshot({ platform:'linux', env:{ WAYLAND_DISPLAY:'wayland-0' }, commandExistsFn:command => command === 'xdg-open' }),
    { desktop_session:true, desktop_open:true },
  );
  for (const platform of ['win32','darwin']) {
    assert.deepEqual(
      desktopShellCapabilitySnapshot({ platform, env:{}, commandExistsFn:noCommands }),
      { desktop_session:true, desktop_open:true },
      `${platform} uses native desktop shell facilities`,
    );
  }
  assert.deepEqual(
    desktopShellCapabilitySnapshot({ platform:'freebsd', env:{ DISPLAY:':0' }, commandExistsFn:allCommands }),
    { desktop_session:false, desktop_open:false },
    'unvalidated platforms stay fail-closed',
  );

  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  assert.deepEqual(byName.get('launch_app').requires, ['desktop_session']);
  assert.deepEqual(byName.get('open_path').requires, ['desktop_open']);
  assert.deepEqual(byName.get('reveal_path').requires, ['desktop_open']);
});

test('Linux display capability follows the same real backend chain as display_inventory', async () => {
  const wlrOutput = `eDP-1 "BOE 0x0A1D (eDP-1)"
  Make: BOE
  Model: 0x0A1D
  Serial:
  Enabled: yes
  Modes:
    1920x1080 px, 60.001000 Hz (preferred, current)
    1920x1080 px, 59.930000 Hz
  Position: 0,0
  Transform: normal
  Scale: 1.250000
HDMI-A-1 "Dell Inc. DELL U2720Q ABC123 (HDMI-A-1)"
  Make: Dell Inc.
  Model: DELL U2720Q
  Serial: ABC123
  Enabled: yes
  Modes:
    3840x2160 px, 60.000000 Hz (preferred, current)
  Position: 1536,0
  Transform: 90
  Scale: 2.000000
DP-9 "Disconnected"
  Enabled: no
`;
  assert.deepEqual(parseWlrRandrOutput(wlrOutput), [
    {
      name:'eDP-1',
      display_name:'BOE 0x0A1D (eDP-1)',
      primary:false,
      x:0,
      y:0,
      width:1536,
      height:864,
      pixel_width:1920,
      pixel_height:1080,
      scale:1.25,
      refresh_hz:60.001,
      transform:'normal',
      builtin:true,
      vendor:'BOE',
      product:'0x0A1D',
      serial:null,
      backend:'wlr-randr',
    },
    {
      name:'HDMI-A-1',
      display_name:'Dell Inc. DELL U2720Q ABC123 (HDMI-A-1)',
      primary:false,
      x:1536,
      y:0,
      width:1080,
      height:1920,
      pixel_width:3840,
      pixel_height:2160,
      scale:2,
      refresh_hz:60,
      transform:'90',
      builtin:false,
      vendor:'Dell Inc.',
      product:'DELL U2720Q',
      serial:'ABC123',
      backend:'wlr-randr',
    },
  ]);

  const runWlr = async (command, args) => ({
    code: command === 'wlr-randr' && args.length === 0 ? 0 : 1,
    stdout: command === 'wlr-randr' ? wlrOutput : '',
    stderr:'',
  });
  const rows = await resolveLinuxDisplayInventory({
    wayland:true,
    mutterProbe:async () => null,
    commandExistsFn:command => command === 'wlr-randr',
    runFileFn:runWlr,
    env:{},
  });
  assert.equal(rows?.[0]?.backend, 'wlr-randr');
  assert.equal(rows?.length, 2);
  assert.equal(
    await displayInventoryAvailable({
      wayland:true,
      mutterProbe:async () => null,
      commandExistsFn:() => false,
      runFileFn:async () => ({ code:1, stdout:'', stderr:'' }),
      env:{},
    }),
    false,
    'an unsupported Wayland compositor must not advertise display_inventory merely because Wayland is active',
  );
});

test('Linux power capability requires both lock and system power backends', () => {
  const only = name => command => command === name;
  const both = command => command === 'loginctl' || command === 'systemctl';
  const none = () => false;

  assert.equal(powerCapabilitySnapshot({ platform:'win32', commandExistsFn:none }), true);
  assert.equal(powerCapabilitySnapshot({ platform:'darwin', commandExistsFn:none }), true);
  assert.equal(powerCapabilitySnapshot({ platform:'linux', commandExistsFn:both }), true);
  assert.equal(powerCapabilitySnapshot({ platform:'linux', commandExistsFn:only('loginctl') }), false);
  assert.equal(powerCapabilitySnapshot({ platform:'linux', commandExistsFn:only('systemctl') }), false);
  assert.equal(powerCapabilitySnapshot({ platform:'linux', commandExistsFn:none }), false);
  assert.equal(powerCapabilitySnapshot({ platform:'freebsd', commandExistsFn:both }), false);
});

test('network summary stays compact on Docker-heavy hosts while preserving physical interfaces first', () => {
  const row = (address, internal = false) => ({
    address,
    netmask:'255.255.255.0',
    family:'IPv4',
    mac:'00:11:22:33:44:55',
    internal,
    cidr:`${address}/24`,
  });
  const interfaces = {
    lo:[row('127.0.0.1', true)],
    eth0:[row('203.0.113.10')],
    enp7s0:[row('10.0.0.2')],
    'br-aaaaaaaaaaaa':[row('172.18.0.1')],
    'br-bbbbbbbbbbbb':[row('172.19.0.1')],
    docker0:[row('172.17.0.1')],
    veth001:[row('169.254.1.1')],
    veth002:[row('169.254.1.2')],
    veth003:[row('169.254.1.3')],
    veth004:[row('169.254.1.4')],
    veth005:[row('169.254.1.5')],
  };
  const summary = compactNetworkSummary({
    hostname:'fixture',
    interfaces,
    dnsServers:['1.1.1.1'],
    maxInterfaces:4,
    maxAddressesPerInterface:2,
  });
  assert.equal(summary.hostname, 'fixture');
  assert.deepEqual(summary.dns, ['1.1.1.1']);
  assert.equal(summary.interface_count, 11);
  assert.equal(summary.interface_count_returned, 4);
  assert.equal(summary.interfaces_truncated, true);
  assert.equal(summary.addresses_truncated, false);
  assert.deepEqual(Object.keys(summary.interfaces).slice(0, 2), ['eth0','enp7s0']);
  assert.equal('lo' in summary.interfaces, false);
  assert.equal(Object.keys(summary.interfaces).length, 4);
  assert.equal(summary.address_count, 11);
  assert.equal(summary.address_count_returned, 4);
});

test('Linux listener fallback always requests listening sockets only', () => {
  assert.deepEqual(
    linuxListenerBackend({ commandExistsFn:command => command === 'ss' || command === 'netstat' }),
    { command:'ss', args:['-lntup'] },
  );
  assert.deepEqual(
    linuxListenerBackend({ commandExistsFn:command => command === 'netstat' }),
    { command:'netstat', args:['-lntu'] },
  );
  assert.equal(linuxListenerBackend({ commandExistsFn:() => false }), null);
});

test('document capabilities are cross-platform and OOXML-gated by the real archive backend', () => {
  const none = () => false;
  const zipAndUnzip = command => command === 'zip' || command === 'unzip';
  const zipOnly = command => command === 'zip';

  assert.deepEqual(
    documentCapabilitySnapshot({ platform:'win32', commandExistsFn:none }),
    { documents:true, ooxml:true },
    'Windows uses the built-in .NET ZIP backend and must not require external zip/unzip binaries',
  );
  for (const platform of ['darwin','linux']) {
    assert.deepEqual(
      documentCapabilitySnapshot({ platform, commandExistsFn:zipAndUnzip }),
      { documents:true, ooxml:true },
      `${platform} exposes the full document surface when zip+unzip are available`,
    );
    assert.deepEqual(
      documentCapabilitySnapshot({ platform, commandExistsFn:zipOnly }),
      { documents:true, ooxml:false },
      `${platform} keeps non-OOXML document capabilities while hiding OOXML tools without unzip`,
    );
  }
  assert.deepEqual(
    documentCapabilitySnapshot({ platform:'freebsd', commandExistsFn:zipAndUnzip }),
    { documents:false, ooxml:false },
    'unvalidated platforms stay fail-closed',
  );

  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  assert.deepEqual(
    byName.get('read_document').requires,
    ['documents'],
    'read_document stays discoverable for PDF/plain-text formats even when DOCX/XLSX archive support is unavailable',
  );
  for (const name of ['edit_spreadsheet','edit_document']) {
    assert.deepEqual(byName.get(name).requires, ['documents','ooxml'], `${name} requires the full OOXML backend`);
  }
  assert.deepEqual(byName.get('pdf_action').requires, ['documents'], 'PDF inspection/actions do not depend on ZIP support');
});

test('extended computer-use catalog is complete, unique, annotated and invokable', () => {
  assert.equal(extendedToolDefinitions.length, EXPECTED.length);
  assert.deepEqual(extendedToolDefinitions.map(tool => tool.name), EXPECTED);
  assert.equal(new Set(EXPECTED).size, EXPECTED.length);
  assert.equal(extendedToolHandlers.size, EXPECTED.length);
  for (const tool of extendedToolDefinitions) {
    assert.equal(extendedToolHandlers.get(tool.name)?.handler, tool.handler, `${tool.name} handler registration`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} input schema`);
    assert.equal(typeof tool.outputSchema, 'object', `${tool.name} output schema`);
    assert.ok(tool.outputSchema && (tool.outputSchema.type || tool.outputSchema.oneOf), `${tool.name} output schema must constrain structuredContent`);
    assert.ok(tool.description.length > 40, `${tool.name} should have a useful description`);
    for (const key of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint']) {
      assert.equal(typeof tool.annotations?.[key], 'boolean', `${tool.name}.${key}`);
    }
    assert.equal(hasTool(tool.name), true, `${tool.name} must be reachable through invokeTool`);
  }
});

test('extended tool schemas are written for agent selection rather than name guessing', () => {
  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  const walk = (node, path, missing) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      for (const [name, property] of Object.entries(node.properties)) {
        const current = `${path}.${name}`;
        if (!String(property?.description || '').trim() || String(property.description).startsWith('Parameter ')) missing.push(current);
        walk(property, current, missing);
      }
    }
    if (node.items) walk(node.items, `${path}[]`, missing);
  };
  for (const tool of extendedToolDefinitions) {
    assert.match(tool.description, /^Use this\b/, `${tool.name} has selection-oriented description`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown top-level arguments`);
    assert.ok(String(tool.outputSchema?.description || '').includes(tool.name), `${tool.name} output schema is tool-specific`);
    const missing = [];
    walk(tool.inputSchema, tool.name, missing);
    assert.deepEqual(missing, [], `${tool.name} has meaningful descriptions for every schema property`);
  }
  assert.match(byName.get('type_text').description, /keyboard/i);
  assert.match(byName.get('keyboard').description, /type_text/i);
  assert.match(byName.get('pointer').description, /ui_action.*browser_action|browser_action.*ui_action/i);
  assert.match(byName.get('browser_action').description, /pointer|desktop/i);
  assert.match(byName.get('browser_evaluate').description, /escape hatch/i);
  assert.match(byName.get('browser_snapshot').description, /scroll position is restored/i);
  assert.match(byName.get('read_document').description, /without opening|launching/i);
  for (const name of ['edit_spreadsheet','edit_document']) {
    assert.match(byName.get(name).description, /create/i, `${name} advertises explicit creation without adding another tool`);
    assert.ok(byName.get(name).inputSchema.properties.create, `${name} exposes create mode`);
    assert.ok(byName.get(name).outputSchema.properties.created, `${name} reports whether it created a new file`);
  }
  for (const name of ['computer_snapshot','scroll','display_inventory','installed_apps','environment','read_document']) {
    assert.equal(byName.get(name).annotations.openWorldHint, false, name + ' stays within local/private state');
  }
  for (const name of ['browser_tabs','browser_snapshot','browser_find','browser_wait','browser_navigate','browser_action','browser_evaluate','computer_action','network']) {
    assert.equal(byName.get(name).annotations.openWorldHint, true, name + ' can reach open-ended external state');
  }
  assert.equal(byName.get('browser_navigate').annotations.destructiveHint, false, 'navigation changes browser state but is not inherently irreversible');
  const power = byName.get('power_action');
  assert.equal(power.annotations.readOnlyHint, false, 'power actions mutate host state');
  assert.equal(power.annotations.destructiveHint, true, 'power actions must be advertised as destructive');
  assert.equal(power.annotations.idempotentHint, false, 'power actions are not safe automatic retries');
  assert.equal(power.annotations.openWorldHint, false, 'power actions stay on the paired host');
});

test('extended output schemas expose stable chaining fields instead of an untyped object', () => {
  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  for (const tool of extendedToolDefinitions) {
    const fields = Object.keys(tool.outputSchema?.properties || {}).filter(name => !['truncated','bytes','preview','data','text'].includes(name));
    const natural = ['list_windows','display_inventory','browser_tabs','installed_apps'].includes(tool.name)
      ? Boolean(tool.outputSchema?.properties?.data)
      : fields.length > 0 || Boolean(tool.outputSchema?.properties?.text);
    assert.equal(natural, true, `${tool.name} describes its structured result`);
  }
  const windowItem = byName.get('list_windows').outputSchema.properties.data.items.properties;
  for (const key of ['id','pid','app','title','x','y','width','height']) assert.ok(windowItem[key], `list_windows exposes ${key}`);
  const uiNode = byName.get('ui_snapshot').outputSchema.properties.nodes.items.properties;
  for (const key of ['id','label','role','name']) assert.ok(uiNode[key], `ui_snapshot exposes ${key}`);
  const tab = byName.get('browser_tabs').outputSchema.properties.data.items.properties;
  for (const key of ['id','title','url']) assert.ok(tab[key], `browser_tabs exposes ${key}`);
  const match = byName.get('browser_find').outputSchema.properties.matches.items.properties;
  for (const key of ['selector','role','text']) assert.ok(match[key], `browser_find exposes ${key}`);
  const environment = byName.get('environment').outputSchema.properties;
  for (const key of ['platform','arch','node','cwd','home','temp','shell','path_entries','environment']) {
    assert.ok(environment[key], `environment exposes ${key}`);
  }
  for (const stale of ['hostname','release','path','env']) {
    assert.equal(Object.hasOwn(environment, stale), false, `environment does not advertise stale field ${stale}`);
  }
  assert.deepEqual(environment.shell.type, ['string','null'], 'environment shell may be unavailable');
  assert.equal(environment.path_entries.type, 'array');
  assert.equal(environment.path_entries.items.type, 'string');
});

test('MCP SDK enforces conditional argument requirements before extended handlers run', async () => {
  const { fromJsonSchema } = await import('@modelcontextprotocol/server');
  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  const cases = [
    ['launch_app', {}, { app:'zenity' }],
    ['keyboard', {}, { key:'TAB' }],
    ['drag_drop', { from_id:'a' }, { from_id:'a', to_id:'b' }],
    ['ui_find', {}, { name:'Save' }],
    ['browser_find', {}, { role:'button' }],
    ['wait_for_ui', {}, { state:'changed' }],
    ['ui_action', { action:'click' }, { action:'click', name:'Save' }],
    ['window_action', { action:'focus' }, { action:'focus', app:'Editor' }],
    ['pointer', { action:'move' }, { action:'move', x:10, y:20 }],
    ['scroll', {}, { direction:'down' }],
    ['computer_action', { action:'click' }, { action:'click', x:10, y:20 }],
    ['computer_action', { action:'click', target:'window', window_id:'w1', x:10, y:20 }, { action:'focus', target:'window', window_id:'w1' }],
    ['computer_action', { action:'type', selector:'#message' }, { action:'type', selector:'#message', text:'hello' }],
    ['computer_action', { action:'type', target:'browser', id:'native-edit', text:'hello' }, { action:'type', target:'browser', selector:'#message', text:'hello' }],
    ['computer_action', { action:'type', target:'coordinates', x:10, y:20, text:'hello' }, { action:'type', target:'ui', id:'native-edit', text:'hello' }],
    ['computer_action', { action:'scroll', selector:'#panel' }, { action:'scroll', selector:'#panel', delta_y:120 }],
    ['computer_action', { action:'scroll', target:'ui', direction:'down' }, { action:'scroll', target:'ui', id:'panel', direction:'down' }],
    ['computer_action', { action:'scroll', target:'coordinates', x:10, direction:'down' }, { action:'scroll', target:'coordinates', x:10, y:20, direction:'down' }],
    ['computer_action', { action:'scroll', target:'window', direction:'down' }, { action:'scroll', target:'window', window_id:'w1', direction:'down' }],
    ['computer_action', { action:'drag', from_id:'a' }, { action:'drag', from_id:'a', to_id:'b' }],
    ['computer_action', { action:'drag', target:'browser', from_x:1, from_y:2, to_x:3, to_y:4 }, { action:'drag', target:'coordinates', from_x:1, from_y:2, to_x:3, to_y:4 }],
    ['computer_action', { action:'drag', target:'ui', from_x:1, from_y:2, to_x:3, to_y:4 }, { action:'drag', target:'ui', from_id:'a', to_id:'b' }],
    ['network', { action:'test', host:'127.0.0.1' }, { action:'test', host:'127.0.0.1', port:443 }],
    ['browser_action', { action:'type', text:'hello' }, { action:'type', selector:'#message', text:'hello' }],
    ['browser_action', { action:'scroll' }, { action:'scroll', direction:'down' }],
    ['browser_action', { action:'press' }, { action:'press', key:'Enter' }],
    ['browser_wait', { condition:'text' }, { condition:'text', text:'ready' }],
    ['service', { action:'restart' }, { action:'restart', name:'demo.service' }],
    ['audio', { action:'set_volume' }, { action:'set_volume', volume:50 }],
    ['power_action', {}, { action:'lock' }],
    ['pdf_action', { action:'merge', paths:['a.pdf','b.pdf'] }, { action:'merge', paths:['a.pdf','b.pdf'], output:'merged.pdf' }],
  ];
  for (const [name, invalid, valid] of cases) {
    const wrapped = fromJsonSchema(byName.get(name).inputSchema);
    const bad = await wrapped['~standard'].validate(invalid);
    const good = await wrapped['~standard'].validate(valid);
    assert.ok(bad.issues?.length, name + ' rejects its incomplete action shape');
    assert.equal(good.issues?.length || 0, 0, name + ' accepts its complete action shape');
  }
});

test('capability-aware live advertising is a subset of the full release contract', async () => {
  const all = allExtendedTools();
  const advertised = await advertisedExtendedTools();
  const capabilities = await capabilitySnapshot();
  assert.equal(all.length, EXPECTED.length);
  assert.ok(advertised.length > 0);
  assert.ok(advertised.length <= all.length);
  assert.equal(typeof capabilities, 'object');
  const allNames = new Set(all.map(tool => tool.name));
  for (const tool of advertised) assert.ok(allNames.has(tool.name));
  for (const always of [
    'computer_snapshot','computer_action',
    'network','environment','read_document','pdf_action',
  ]) {
    assert.ok(advertised.some(tool => tool.name === always), `${always} should remain discoverable`);
  }
  assert.equal(
    advertised.some(tool => tool.name === 'launch_app'),
    Boolean(capabilities.desktop_session),
    'launch_app should follow the live desktop-session capability',
  );
  for (const browserTool of ['browser_tabs','browser_navigate','browser_snapshot','browser_find','browser_action','browser_wait','browser_evaluate']) {
    assert.equal(advertised.some(tool => tool.name === browserTool), Boolean(capabilities.browser_cdp), `${browserTool} should follow the live CDP capability`);
  }
});
