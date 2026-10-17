import { readDesktopSource } from './helpers/desktop-source.mjs';
import { readLinuxSource } from './helpers/linux-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';
import { computerAction, computerActionWindowTextArgs, computerSnapshot, pointer, scroll, uiAction, uiFind, waitForUi, windowAction } from '../src/extended/desktop.mjs';
import { browserFind, findExpression } from '../src/extended/browser.mjs';
import * as linux from '../src/extended/desktop-linux.mjs';

const tool = name => {
  const value = extendedToolDefinitions.find(item => item.name === name);
  assert.ok(value, `missing tool definition: ${name}`);
  return value;
};

test('computer_action window text targeting never aliases a window id into a semantic UI element id', () => {
  const routed = computerActionWindowTextArgs({
    action:'type',
    target:'window',
    window_id:'linux:123:r.0',
    window_title:'Scratch',
    id:'stale-ui-element',
    label:7,
    name:'Search',
    role:'textbox',
    automation_id:'query',
    selector:'#message',
    browser_text:'Message',
    text:'hello',
    clear:true,
    backend:'portal',
  });
  assert.equal(routed.window_id, 'linux:123:r.0');
  assert.equal(routed.title, 'Scratch');
  assert.equal(routed.text, 'hello');
  assert.equal(routed.clear, true);
  assert.equal(routed.backend, 'portal');
  for (const field of ['id','label','name','role','automation_id','automationId','selector','browser_text']) {
    assert.equal(Object.hasOwn(routed, field), false, `window text route must strip ${field}`);
  }
});

test('computer_action exposes the universal cross-backend actions without absorbing specialist-only controls', () => {
  const computerAction = tool('computer_action');
  const actions = computerAction.inputSchema.properties.action.enum;
  for (const action of [
    'click','type','invoke','focus','select','scroll','drag','set_value','toggle',
    'expand','collapse','scroll_into_view','set_range_value',
    'add_to_selection','remove_from_selection','multi_select','multi_edit',
  ]) assert.ok(actions.includes(action), `computer_action missing cross-backend action ${action}`);
  for (const action of [
    'ui','pointer','window','keyboard','clipboard','launch_app',
    'double_click','right_click',
    'open_path','reveal_path','notification','move','down','up','minimize','maximize',
    'restore','move_resize','resize','close','wait','batch',
  ]) assert.equal(actions.includes(action), false, `computer_action must not duplicate specialist action ${action}`);
  for (const property of ['operation','shortcut','key','path','message','wait_ms','seconds','steps','args']) {
    assert.equal(Object.hasOwn(computerAction.inputSchema.properties, property), false, `computer_action must not advertise specialist field ${property}`);
  }
  for (const property of ['window_id','delta_x','delta_y','direction','from_x','from_y','to_x','to_y','from_id','to_id']) {
    assert.ok(Object.hasOwn(computerAction.inputSchema.properties, property), `computer_action universal action field missing: ${property}`);
  }
  assert.ok(computerAction.inputSchema.properties.target.enum.includes('window'), 'computer_action must support explicit window targeting');
  assert.match(computerAction.description, /only when/i);
  assert.match(computerAction.description, /ui_action/i);
  assert.match(computerAction.description, /browser_action/i);
  assert.match(computerAction.description, /type_text/i);
  assert.match(computerAction.description, /window_action/i);

  const uiAction = tool('ui_action');
  const uiActions = uiAction.inputSchema.properties.action.enum;
  for (const action of [
    'invoke','focus','set_value','select','toggle','expand','collapse',
    'scroll_into_view','set_range_value','add_to_selection','remove_from_selection',
  ]) assert.ok(uiActions.includes(action), `ui_action missing ${action}`);

  const snapshotTool = tool('computer_snapshot');
  const snapshot = snapshotTool.inputSchema.properties;
  assert.deepEqual(snapshotTool.outputSchema.properties.active_window.type, ['object','null'], 'active_window may be unknown even when native accessibility is available');
  assert.deepEqual(snapshot.ui_scope.enum, ['active','desktop']);
  assert.equal(snapshot.screenshot_region.minItems, 4);
  assert.equal(snapshot.screenshot_region.maxItems, 4);
  assert.equal(snapshot.ui_browser_dom.type, 'boolean');

  const launch = tool('launch_app').inputSchema.properties;
  assert.equal(launch.cwd.type, 'string');
  assert.equal(launch.wait_for_window.type, 'string');

  const find = tool('ui_find').inputSchema.properties;
  assert.equal(find.label.type, 'number');
  assert.equal(find.refresh.type, 'boolean');
});

test('desktop action schemas reject targetless or no-op calls before execution', async () => {
  const uiSchema = tool('ui_action').inputSchema;
  assert.ok(Array.isArray(uiSchema.allOf) && uiSchema.allOf.length >= 2, 'ui_action declares target/value conditions');

  const windowSchema = tool('window_action').inputSchema;
  assert.ok(Array.isArray(windowSchema.allOf) && windowSchema.allOf.length >= 4, 'window_action declares target and geometry conditions');

  const pointerSchema = tool('pointer').inputSchema;
  assert.ok(Array.isArray(pointerSchema.allOf) && pointerSchema.allOf.length >= 1, 'pointer move declares coordinate requirements');

  const scrollSchema = tool('scroll').inputSchema;
  assert.ok(Array.isArray(scrollSchema.anyOf) && scrollSchema.anyOf.length >= 4, 'scroll requires direction or delta');

  const computerSchema = tool('computer_action').inputSchema;
  assert.ok(Array.isArray(computerSchema.allOf) && computerSchema.allOf.length >= 9, 'computer_action declares action-specific target/value/gesture requirements');

  assert.ok(Array.isArray(tool('ui_find').inputSchema.anyOf), 'ui_find declares an element selector requirement');
  assert.ok(Array.isArray(tool('browser_find').inputSchema.anyOf), 'browser_find declares a page-element selector requirement');
  assert.ok(Array.isArray(tool('wait_for_ui').inputSchema.anyOf), 'wait_for_ui requires an explicit state or condition');

  await assert.rejects(() => uiFind({}), /use ui_snapshot to enumerate UI/);
  await assert.rejects(() => browserFind({}), /use browser_snapshot to enumerate page structure/);
  await assert.rejects(() => waitForUi({}), /requires state or condition/);
  await assert.rejects(() => waitForUi({ state:'present' }), /requires a semantic target/);
  await assert.rejects(() => waitForUi({ condition:'active_window' }), /requires text, name, or window_title/);
  await assert.rejects(() => uiAction({ action:'click' }), /requires id, label, name, role, or automation_id/);
  await assert.rejects(() => uiAction({ action:'set_value', name:'Search' }), /requires value/);
  await assert.rejects(() => windowAction({ action:'focus' }), /requires id, pid, app, or title/);
  await assert.rejects(() => windowAction({ action:'move', id:'window-1' }), /requires x and y/);
  await assert.rejects(() => pointer({ action:'move' }), /requires x and y/);
  await assert.rejects(() => scroll({}), /requires direction or a delta/);
});

test('computer_action wait is bounded and batch executes sequential grouped actions', async () => {
  const started = Date.now();
  const waited = await computerAction({ action:'wait', wait_ms:25 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 15, `wait returned too early: ${elapsed}ms`);
  const payload = waited.structuredContent;
  assert.equal(payload.action, 'wait');
  assert.equal(payload.waited_ms, 25);
  assert.equal(payload.capped, false);

  const batch = await computerAction({
    action:'batch',
    steps:[
      { action:'wait', wait_ms:5 },
      { action:'wait', wait_ms:5 },
    ],
  });
  assert.equal(batch.structuredContent.action, 'batch');
  assert.equal(batch.structuredContent.ok, true);
  assert.equal(batch.structuredContent.completed, 2);
  assert.deepEqual(batch.structuredContent.results.map(row => row.index), [0,1]);

  await assert.rejects(() => computerAction({ action:'wait' }), /requires wait_ms or seconds/);
}, { timeout: 2_000 });

test('Linux XWayland pixel geometry uses xwininfo absolute client coordinates', () => {
  const sample = `
  Absolute upper-left X:  421
  Absolute upper-left Y:  280
  Relative upper-left X:  14
  Relative upper-left Y:  49
  Width: 600
  Height: 240
`;
  assert.deepEqual(linux.parseX11PixelBounds(sample), { x:421, y:280, width:600, height:240 });
  assert.equal(linux.parseX11PixelBounds('Width: 0\nHeight: 0'), null);
});

test('Linux Wayland inventory refreshes X11 rows after AT-SPI and XWayland focus avoids portal cycling when direct activation verifies', async () => {
  const linuxSource = await readLinuxSource();
  const listStart = linuxSource.indexOf('export async function listWindows() {');
  const listEnd = linuxSource.indexOf('async function windowMatch', listStart);
  const listBody = listStart >= 0 && listEnd > listStart ? linuxSource.slice(listStart, listEnd) : '';
  assert.match(
    listBody,
    /uiSnapshot\(\{ max_nodes: 2500, max_depth: 1 \}\)/,
    'Wayland window inventory must stop at top-level AT-SPI windows instead of traversing descendant controls',
  );
  assert.doesNotMatch(
    listBody,
    /uiSnapshot\(\{ max_nodes: 2500, max_depth: [2-9]/,
    'Wayland window inventory must not rebuild deeper accessibility subtrees just to discover top-level windows',
  );
  assert.match(
    listBody,
    /window inventory refresh[\s\S]{0,240}if \(refreshedWmRows\.length\) wmRows = refreshedWmRows/,
    'Wayland inventory must refresh wmctrl after the AT-SPI top-level scan so late XWayland windows are not misclassified',
  );

  const focusStart = linuxSource.indexOf("if (action === 'focus') {");
  const focusEnd = linuxSource.indexOf("else if (nativeWayland)", focusStart);
  const focusBody = focusStart >= 0 && focusEnd > focusStart ? linuxSource.slice(focusStart, focusEnd) : '';
  const direct = focusBody.indexOf("runFile('wmctrl', ['-ia', row.wm_id]");
  const portal = focusBody.indexOf("portalShortcut('ALT+ESC'");
  assert.ok(direct >= 0, 'Wayland XWayland focus must try the real wm_id directly');
  assert.ok(portal > direct, 'portal window cycling must remain a fallback after direct XWayland activation');
  assert.match(
    focusBody,
    /targetAccessibilityFocus\(row\)[\s\S]{0,160}verified XWayland activation/,
    'direct XWayland activation must be verified before success is reported',
  );

  const matchStart = linuxSource.indexOf('async function windowMatch(args)');
  const matchEnd = linuxSource.indexOf('async function focusedAccessibilityContext', matchStart);
  const matchBody = matchStart >= 0 && matchEnd > matchStart ? linuxSource.slice(matchStart, matchEnd) : '';
  const fastMatch = matchBody.indexOf('fastX11WindowMatch(args)');
  const fullInventory = matchBody.indexOf('await listWindows()');
  assert.ok(fastMatch >= 0 && fullInventory > fastMatch, 'window actions must resolve X11/XWayland selectors before rebuilding the full semantic inventory');
});

test('Linux semantic typing rejects false AT-SPI writes and auto typing fails safely', async () => {
  const linuxSource = await readLinuxSource();
  const desktopSource = await readDesktopSource();

  assert.match(
    linuxSource,
    /setTextContents\(value\)[\s\S]{0,180}is False[\s\S]{0,180}raise Exception/,
    'Linux set_value must treat an explicit AT-SPI false result as a failed semantic write',
  );
  assert.match(
    desktopSource,
    /method === 'auto'[\s\S]{0,600}try \{[\s\S]{0,500}uiAction\([\s\S]{0,900}catch[\s\S]{0,300}method === 'accessibility'[\s\S]{0,120}throw/,
    'type_text auto mode must inspect semantic set_value failure while accessibility-only mode stays fail-closed',
  );
  assert.match(
    desktopSource,
    /Semantic text target rejected accessibility input[\s\S]{0,160}browser_action/,
    'auto typing must fail safely instead of claiming an unverified keyboard paste into a semantic browser target',
  );
  assert.match(
    desktopSource,
    /if \(method === 'accessibility'\)[\s\S]{0,180}Accessibility-only text input requires a semantic element target/,
    'explicit accessibility-only typing must never silently fall through to clipboard or key injection',
  );
  assert.match(
    linuxSource,
    /already_focused=False[\s\S]{0,220}STATE_FOCUSED[\s\S]{0,260}if not already_focused:[\s\S]{0,220}grabFocus\(\)/,
    'Linux semantic focus should be idempotent when AT-SPI already reports the target focused',
  );
  assert.match(
    linuxSource,
    /grabFocus\(\) is False[\s\S]{0,120}raise Exception/,
    'Linux semantic focus must reject an explicit false AT-SPI focus result',
  );
  assert.doesNotMatch(
    linuxSource,
    /backend !== 'portal' && await runXdotool\(\)\) return jsonResult\(\{ from:\[args\.from_x,args\.from_y\], to:\[args\.to_x,args\.to_y\], backend:'xwayland-xdotool'/,
    'GNOME Wayland drag must not claim success through unreliable XTEST/xdotool fallback',
  );
  assert.match(
    linuxSource,
    /Wayland drag and drop[\s\S]{0,240}XTEST\/xdotool drag events are not reliably delivered through GNOME Wayland/,
    'Wayland drag failures should direct the caller to the portal backend',
  );
});

test('geometry-sensitive semantic actions refresh UI bounds instead of reusing the 5-second cache', async () => {
  const desktopSource = await readDesktopSource();
  assert.ok(
    desktopSource.includes("const matches = await uiMatches({ id, limit: 1, max_nodes: 5000, max_depth: 32, refresh:true });"),
    'drag_drop element ids must resolve from a fresh UI snapshot',
  );
  const scrollStart = desktopSource.indexOf('export async function scroll(args = {}) {');
  const scrollEnd = desktopSource.indexOf('function matches(', scrollStart);
  const scrollBody = scrollStart >= 0 && scrollEnd > scrollStart ? desktopSource.slice(scrollStart, scrollEnd) : '';
  assert.ok(
    scrollBody.includes('const nodes = await uiMatches({ ...args, limit:1, refresh:true });'),
    'semantic scroll targets must resolve from a fresh UI snapshot',
  );
});

test('Linux Wayland portal clicks keep a real press interval before release', async () => {
  const linuxSource = await readLinuxSource();
  const pointerBody = linuxSource.match(/export async function pointer\(args = \{\}\) \{[\s\S]*?(?=export async function dragDrop)/)?.[0] || '';
  assert.match(
    pointerBody,
    /portalPointerButton\(buttonName, true, portalOptions\);[\s\S]{0,300}setTimeout\(resolve, 60\)[\s\S]{0,200}portalPointerButton\(buttonName, false, portalOptions\)/,
    'Wayland portal click must not collapse button-down and button-up into a zero-duration gesture',
  );
});

test('Wayland EIS helper releases a button through the same device that received its press', async () => {
  const helper = await readFile(new URL('../src/helpers/wayland_eis_sender.py', import.meta.url), 'utf8');
  assert.match(helper, /self\.button_device_keys = \{\}/);
  assert.match(
    helper,
    /if pressed:[\s\S]{0,260}self\.button_device_keys\[button\] = self\._device_key\(device\)[\s\S]{0,420}key = self\.button_device_keys\.pop\(button, None\)[\s\S]{0,520}device = state\["ptr"\]/,
    'button release must reuse the exact EIS device selected for button press',
  );
});

test('Wayland EIS absolute pointer converts desktop coordinates into the selected region before motion', async () => {
  const helper = await readFile(new URL('../src/helpers/wayland_eis_sender.py', import.meta.url), 'utf8');
  assert.match(
    helper,
    /ei_region_convert_point\.argtypes[\s\S]{0,220}ei_region_convert_point\.restype/,
    'the helper must bind libei region coordinate conversion',
  );
  const convertStart = helper.indexOf('def _absolute_motion_for_device');
  const convertEnd = helper.indexOf('def device_for_absolute', convertStart);
  const convertBody = convertStart >= 0 && convertEnd > convertStart ? helper.slice(convertStart, convertEnd) : '';
  assert.ok(convertBody.includes('ei_device_get_region_at(device, float(x), float(y))'));
  assert.ok(convertBody.includes('ei_region_convert_point(region, ctypes.byref(motion_x), ctypes.byref(motion_y))'));
  assert.ok(convertBody.includes('return motion_x.value, motion_y.value'));
  assert.match(
    helper,
    /device, motion_x, motion_y = self\.device_for_absolute\(x, y\)[\s\S]{0,180}ei_device_pointer_motion_absolute\(device, motion_x, motion_y\)/,
    'absolute motion must send converted region-local coordinates, not the original desktop-wide point',
  );
  const selectStart = helper.indexOf('def device_for_absolute');
  const selectEnd = helper.indexOf('def device_for_pointer_context', selectStart);
  const selectBody = selectStart >= 0 && selectEnd > selectStart ? helper.slice(selectStart, selectEnd) : '';
  const preferredIndex = selectBody.indexOf('self.pointer_device_key');
  const scanIndex = selectBody.indexOf('for state in self.devices.values()');
  assert.ok(
    preferredIndex >= 0 && scanIndex > preferredIndex,
    'absolute motion must prefer the current pointer device before scanning other EIS devices so pointer capture survives a drag',
  );
});

test('Linux Wayland portal drag settles the source and preserves pressed state through one absolute target move', async () => {
  const linuxSource = await readLinuxSource();
  const dragBody = linuxSource.match(/export async function dragDrop\(args = \{\}\) \{[\s\S]*?(?=export async function scroll)/)?.[0] || '';
  assert.match(
    dragBody,
    /portalMoveTo\(fromX, fromY, portalOptions\);[\s\S]{0,420}setTimeout\(resolve, 60\)[\s\S]{0,220}portalPointerButton\(button, true, portalOptions\)/,
    'Wayland portal drag must let the target observe the source position before button-down',
  );
  const pressIndex = dragBody.indexOf("await portalPointerButton(button, true, portalOptions);");
  const moveIndex = dragBody.indexOf("await portalMoveTo(toX, toY, portalOptions);", pressIndex);
  const releaseIndex = dragBody.indexOf("await portalPointerButton(button, false, portalOptions);", moveIndex);
  const releaseReassertIndex = dragBody.lastIndexOf("await portalMoveTo(toX, toY, portalOptions);", releaseIndex);
  assert.ok(
    pressIndex >= 0 && moveIndex > pressIndex && releaseReassertIndex > moveIndex && releaseIndex > releaseReassertIndex,
    'Wayland portal drag must reassert the target immediately before release so XWayland emits pointerup on the dragged target',
  );
  assert.equal(
    dragBody.includes('for (let step = 1; step <= steps; step += 1)'),
    false,
    'drag must not synthesize an intermediate absolute-motion path across EIS regions',
  );
});

test('Linux Wayland keyboard and key typing focus an explicit window target before dispatch', async () => {
  const linuxSource = await readLinuxSource();

  const keyboardBody = linuxSource.match(/export async function keyboard\(args = \{\}\) \{[\s\S]*?(?=export async function typeTextKeys)/)?.[0] || '';
  const typeBody = linuxSource.match(/export async function typeTextKeys\(value, args = \{\}\) \{[\s\S]*?(?=function buttonNumber)/)?.[0] || '';

  assert.match(
    keyboardBody,
    /if \(isWaylandSession\(\)\) \{\s*await focusExplicitWaylandInputTarget\(args\);/,
    'Wayland keyboard input must focus and verify an explicit window target before wtype/portal dispatch',
  );
  assert.match(
    typeBody,
    /if \(isWaylandSession\(\)\) \{\s*await focusExplicitWaylandInputTarget\(args\);/,
    'Wayland key-by-key text input must focus and verify an explicit window target before wtype/portal dispatch',
  );
  assert.match(
    linuxSource,
    /async function focusExplicitWaylandInputTarget\(args = \{\}\)[\s\S]*windowAction\(\{[\s\S]*action:'focus'/,
    'explicit Wayland input targeting must reuse verified window focus rather than assuming delivery',
  );
  assert.match(
    linuxSource,
    /const windowCycles =[\s\S]{0,500}portalShortcut\('ALT\+ESC'[\s\S]{0,500}targetAccessibilityFocus\(row\)/,
    'Wayland focus should cycle windows directly and verify each candidate before falling back to the app switcher',
  );
  assert.ok(
    linuxSource.indexOf("portalShortcut('ALT+ESC'") < linuxSource.indexOf("portalShortcut('ALT+TAB'"),
    'direct Alt+Esc window cycling must run before the MRU Alt+Tab fallback',
  );
});
