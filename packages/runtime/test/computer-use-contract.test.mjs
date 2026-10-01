import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';
import { computerAction, computerSnapshot, pointer, scroll, uiAction, uiFind, waitForUi, windowAction } from '../src/extended/desktop.mjs';
import { browserFind, findExpression } from '../src/extended/browser.mjs';
import * as linux from '../src/extended/desktop-linux.mjs';

const tool = name => {
  const value = extendedToolDefinitions.find(item => item.name === name);
  assert.ok(value, `missing tool definition: ${name}`);
  return value;
};

test('computer_action stays a narrow cross-backend fallback instead of duplicating specialist tools', () => {
  const computerAction = tool('computer_action');
  const actions = computerAction.inputSchema.properties.action.enum;
  for (const action of [
    'click','invoke','focus','set_value','select','toggle',
    'expand','collapse','scroll_into_view','set_range_value',
    'add_to_selection','remove_from_selection','multi_select','multi_edit',
  ]) assert.ok(actions.includes(action), `computer_action missing cross-backend action ${action}`);
  for (const action of [
    'ui','pointer','window','type','keyboard','scroll','drag','clipboard','launch_app',
    'double_click','right_click',
    'open_path','reveal_path','notification','move','down','up','minimize','maximize',
    'restore','move_resize','resize','close','wait','batch',
  ]) assert.equal(actions.includes(action), false, `computer_action must not duplicate specialist action ${action}`);
  for (const property of ['operation','shortcut','key','from_x','from_y','to_x','to_y','delta_x','delta_y','path','message','wait_ms','seconds','steps','args']) {
    assert.equal(Object.hasOwn(computerAction.inputSchema.properties, property), false, `computer_action must not advertise specialist field ${property}`);
  }
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
  assert.ok(Array.isArray(computerSchema.allOf) && computerSchema.allOf.length >= 6, 'computer_action declares action-specific target requirements');

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
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
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
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const desktopSource = await readFile(new URL('../src/extended/desktop.mjs', import.meta.url), 'utf8');

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
  const desktopSource = await readFile(new URL('../src/extended/desktop.mjs', import.meta.url), 'utf8');
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
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const pointerBody = linuxSource.match(/export async function pointer\(args = \{\}\) \{[\s\S]*?(?=export async function dragDrop)/)?.[0] || '';
  assert.match(
    pointerBody,
    /portalPointerButton\(buttonName, true, portalOptions\);[\s\S]{0,300}setTimeout\(resolve, 60\)[\s\S]{0,200}portalPointerButton\(buttonName, false, portalOptions\)/,
    'Wayland portal click must not collapse button-down and button-up into a zero-duration gesture',
  );
});

test('Wayland EIS helper releases a button through the same device that received its press', async () => {
  const helper = await readFile(new URL('../src/helpers/wayland-eis-helper.py', import.meta.url), 'utf8');
  assert.match(helper, /self\.button_device_keys = \{\}/);
  assert.match(
    helper,
    /if pressed:[\s\S]{0,260}self\.button_device_keys\[button\] = self\._device_key\(device\)[\s\S]{0,420}key = self\.button_device_keys\.pop\(button, None\)[\s\S]{0,520}device = state\["ptr"\]/,
    'button release must reuse the exact EIS device selected for button press',
  );
});

test('Wayland EIS absolute pointer converts desktop coordinates into the selected region before motion', async () => {
  const helper = await readFile(new URL('../src/helpers/wayland-eis-helper.py', import.meta.url), 'utf8');
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
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
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
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');

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

test('native Wayland window geometry actions verify the observed result before success', async () => {
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const body = linuxSource.match(/async function nativeWaylandWindowAction\(row, action, args\) \{[\s\S]*?(?=export async function windowAction)/)?.[0] || '';

  assert.match(
    linuxSource,
    /async function verifyNativeWaylandGeometry[\s\S]*windowMatch\(\{ id:row\.id \}\)[\s\S]*Could not verify native Wayland window/,
    'native Wayland geometry verification must re-read the target window and fail closed when the compositor result is not observable',
  );
  assert.match(
    body,
    /await dragDrop\([\s\S]{0,500}verifyNativeWaylandGeometry\(row, \{ x, y \}, 'move'\)/,
    'move must verify observed coordinates after the portal drag',
  );
  assert.match(
    body,
    /verifyNativeWaylandGeometry\(row, \{ x, y \}, 'move'\)[\s\S]{0,900}await dragDrop\([\s\S]{0,500}verifyNativeWaylandGeometry\(row, \{ width, height \}, 'resize'\)/,
    'move_resize must verify move before attempting resize and then verify the final size',
  );
});

test('native Wayland global window actions require verified target focus and close verifies the target disappeared', async () => {
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const body = linuxSource.match(/async function nativeWaylandWindowAction\(row, action, args\) \{[\s\S]*?(?=export async function windowAction)/)?.[0] || '';

  assert.match(
    body,
    /nativeWaylandAccessibilityAction\(row, \['window\.close'\]\)[\s\S]*verifyNativeWaylandWindowClosed\(row\)/,
    'native Wayland close should prefer a target-specific AT-SPI window.close action and verify disappearance',
  );
  assert.match(
    linuxSource,
    /want_window\.strip\(\)\.lower\(\)!=name\.strip\(\)\.lower\(\)/,
    'native Wayland semantic window actions must match the exact target title instead of a fuzzy sibling',
  );
  assert.match(
    body,
    /focusNativeWaylandForAction\(row, portalBackend\);\s*await portalShortcut\('ALT\+F4'/,
    'Alt+F4 fallback must only run after verified target focus',
  );
  assert.match(
    linuxSource,
    /async function focusNativeWaylandForAction[\s\S]*windowAction\(\{ action:'focus'[\s\S]*targetAccessibilityFocus\(row\)[\s\S]*if \(!focusState\.exact\) throw/,
    'the native Wayland shortcut guard must fail closed when target focus cannot be proved',
  );
  assert.match(
    body,
    /else \{\s*await focusNativeWaylandForAction\(row, portalBackend\);\s*let currentX/,
    'native Wayland move and resize must verify target focus before coordinate drag',
  );
});

test('type_text prefers window-scoped semantic replacement before Wayland compositor focus', async () => {
  const desktopSource = await readFile(new URL('../src/extended/desktop.mjs', import.meta.url), 'utf8');
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const typeBody = desktopSource.match(/export async function typeText\(args = \{\}\) \{[\s\S]*?(?=async function uiElementCenter)/)?.[0] || '';

  assert.match(
    typeBody,
    /explicitWindowTarget[\s\S]{0,700}adapter\.typeTextWindowTarget/,
    'explicit window auto/accessibility typing should try a window-scoped semantic write without compositor focus',
  );
  assert.ok(
    typeBody.indexOf('adapter.typeTextWindowTarget') < typeBody.indexOf("windowAction({ action:'focus'"),
    'semantic window typing must run before any compositor focus attempt',
  );
  assert.match(
    typeBody,
    /if \(explicitWindowTarget\) await windowAction\(\{ action:'focus', \.\.\.explicitWindowTarget \}\);[\s\S]{0,900}adapter\.typeTextKeys/,
    'key-based fallback must still verify the explicit window target before dispatch',
  );
  assert.match(
    linuxSource,
    /export async function typeTextWindowTarget[\s\S]{0,1400}if \(candidates\.length !== 1\) return null;[\s\S]{0,700}action:'set_value'/,
    'window-scoped semantic typing must only write when exactly one editable accessibility control is found',
  );
});

test('Linux ui_action falls back to a bounded pointer click only for click/invoke', async () => {
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');

  assert.match(
    linuxSource,
    /if action in \("click","invoke"\):[\s\S]{0,500}queryAction\(\)\.doAction\(0\)[\s\S]{0,700}getExtents\(pyatspi\.DESKTOP_COORDS\)/,
    'click/invoke should derive fallback coordinates from the same AT-SPI target when Action is unavailable',
  );
  assert.match(
    linuxSource,
    /if pw<=0 or ph<=0: raise Exception\("target has no usable screen bounds"\)/,
    'coordinate fallback must fail closed when the target has no usable bounds',
  );
  assert.match(
    linuxSource,
    /if \(payload\?\.pointer_fallback\)[\s\S]{0,500}await pointer\(\{ action:'click'/,
    'Linux adapter should execute the fallback through the existing pointer backend',
  );
  assert.match(linuxSource, /backend:'pointer_fallback'/);
  assert.match(
    linuxSource,
    /elif action in \("select","toggle"\):[\s\S]{0,160}queryAction\(\)\.doAction\(0\)/,
    'non-click semantic actions must remain semantic and fail closed',
  );
});

test('Linux accessibility retries false-empty AT-SPI walks before using the conservative fallback depth', async () => {
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const desktopSource = await readFile(new URL('../src/extended/desktop.mjs', import.meta.url), 'utf8');

  assert.match(
    linuxSource,
    /const maxDepth = clamp\(args\.max_depth, 8, 1, 32\)/,
    'Linux ui_snapshot should still honor deep requests up to the documented maximum',
  );
  assert.match(
    desktopSource,
    /process\.platform === 'linux' && isEmptySnapshot\(value\)[\s\S]{0,420}await sleep\(40\)[\s\S]{0,240}adapter\.uiSnapshot\(effective\)/,
    'a false-empty Linux snapshot should retry once at the requested depth',
  );
  assert.match(
    desktopSource,
    /isEmptySnapshot\(value\) && Number\.isFinite\(requestedDepth\) && requestedDepth > 12[\s\S]{0,180}max_depth:12/,
    'a repeatedly empty deep Linux snapshot should fall back to the conservative depth',
  );
  assert.match(
    desktopSource,
    /max_depth: resolved\.max_depth \|\| \(process\.platform === 'linux' \? 12 : 16\)/,
    'generic UI matching should default to the stable Linux traversal depth',
  );
});

test('browser_find derives native HTML roles when no explicit ARIA role is present', async () => {
  const browserSource = await readFile(new URL('../src/extended/browser.mjs', import.meta.url), 'utf8');

  assert.match(browserSource, /function semanticRole\(el\)/);
  assert.match(browserSource, /\^h\[1-6\]\$/);
  assert.match(browserSource, /if \(tag === 'button'\) return 'button'/);
  assert.match(browserSource, /tag === 'a' && el\.hasAttribute\('href'\)/);
  assert.match(browserSource, /type === 'checkbox'.*return 'checkbox'/s);
  assert.match(browserSource, /type === 'radio'.*return 'radio'/s);
  assert.match(browserSource, /type === 'range'.*return 'slider'/s);
  assert.match(browserSource, /tag === 'select'.*'listbox'.*'combobox'/s);
  assert.match(browserSource, /role: semanticRole\(el\)/);
});

test('browser_find ranks exact semantic text targets ahead of ancestor text containers', () => {
  const makeElement = (tag, text, attributes = {}) => ({
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: attributes.id || '',
    innerText: text,
    textContent: text,
    type: attributes.type || '',
    multiple: false,
    size: 0,
    disabled: false,
    parentElement: null,
    children: [],
    getAttribute(name) {
      if (name === 'role') return attributes.role || null;
      if (name === 'aria-label') return attributes.ariaLabel || null;
      if (name === 'name') return attributes.name || null;
      return null;
    },
    hasAttribute(name) {
      if (name === 'href') return Boolean(attributes.href);
      return false;
    },
    getClientRects() { return [{}]; },
    getBoundingClientRect() { return { x:0, y:0, width:100, height:20 }; },
    contains(other) {
      for (let current = other; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
  });
  const append = (parent, child) => {
    child.parentElement = parent;
    parent.children.push(child);
    return child;
  };

  const html = makeElement('html', 'Sign in to ReMCP Continue with Google');
  const body = append(html, makeElement('body', 'Sign in to ReMCP Continue with Google'));
  const main = append(body, makeElement('main', 'Sign in to ReMCP Continue with Google'));
  const section = append(main, makeElement('section', 'Sign in to ReMCP Continue with Google'));
  append(section, makeElement('h1', 'Sign in to ReMCP'));
  const button = append(section, makeElement('button', 'Continue with Google'));
  append(button, makeElement('span', 'Continue with Google'));

  const all = [html, body, main, section, ...section.children, ...button.children];
  const document = {
    documentElement: html,
    querySelectorAll(selector) {
      if (selector === '*') return all;
      return all.filter(element => element.tagName.toLowerCase() === selector.toLowerCase());
    },
  };
  const run = args => Function(
    'document',
    'getComputedStyle',
    'CSS',
    `return ${findExpression(args)};`,
  )(document, () => ({ visibility:'visible', display:'block' }), { escape:value => String(value) });

  const headingMatches = run({ text:'Sign in to ReMCP', limit:20 });
  assert.equal(headingMatches.length, 1);
  assert.equal(headingMatches[0].tag, 'h1');
  assert.equal(headingMatches[0].role, 'heading');

  const buttonMatches = run({ text:'Continue with Google', limit:20 });
  assert.equal(buttonMatches.length, 1);
  assert.equal(buttonMatches[0].tag, 'button');
  assert.equal(buttonMatches[0].role, 'button');
});

test('headless Linux computer_snapshot skips desktop probes without false error noise', { skip: process.platform !== 'linux' }, async () => {
  const previousDisplay = process.env.DISPLAY;
  const previousWaylandDisplay = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    const result = await computerSnapshot({
      include_ui:true,
      include_screenshot:true,
      include_browser:false,
      include_ocr:true,
      max_ui_nodes:40,
      max_ui_depth:4,
    });
    const snapshot = result.structuredContent;
    assert.ok(snapshot);
    assert.deepEqual(snapshot.windows, []);
    assert.deepEqual(snapshot.displays, []);
    assert.deepEqual(snapshot.cursor, { x:null, y:null });
    assert.equal(snapshot.ui?.unavailable, true);
    assert.equal(snapshot.clipboard?.available, false);
    assert.equal(snapshot.fallback_chain?.accessibility?.requested, true);
    assert.equal(snapshot.fallback_chain?.accessibility?.available, false);
    assert.equal(snapshot.fallback_chain?.ocr?.requested, true);
    assert.equal(snapshot.fallback_chain?.ocr?.available, false);
    assert.equal(snapshot.fallback_chain?.vision_screenshot?.available, false);
    assert.deepEqual(snapshot.errors, []);
    assert.equal(result.content.some(part => part.type === 'image'), false);
  } finally {
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    if (previousWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = previousWaylandDisplay;
  }
});

test('Linux Wayland cursor telemetry fails closed instead of reporting stale XWayland coordinates', { skip: process.platform !== 'linux' }, async () => {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  const previousWaylandDisplay = process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = 'wayland';
  process.env.WAYLAND_DISPLAY = 'wayland-test';
  try {
    await assert.rejects(
      () => linux.cursorPosition(),
      /Cursor position.*native Wayland.*authoritative global cursor position/i,
    );
  } finally {
    if (previousSessionType === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = previousSessionType;
    if (previousWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = previousWaylandDisplay;
  }

  const desktopSource = await readFile(new URL('../src/extended/desktop.mjs', import.meta.url), 'utf8');
  assert.match(
    desktopSource,
    /const parsedCursor = parse\(cursorResult, \{ x:null, y:null \}\);/,
    'computer_snapshot must normalize a rejected cursor capture to null coordinates',
  );
  assert.match(
    desktopSource,
    /\['cursor', cursorResult\][\s\S]{0,500}snapshotError\(source, result\)/,
    'computer_snapshot must preserve the rejected cursor reason as a bounded snapshot error',
  );
});

test('power_action routes restart and shutdown through command policy before native power commands', async () => {
  const source = await readFile(new URL('../src/extended/diagnostics.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /assertAllowedCommand\(action === 'restart' \? 'reboot' : action === 'shutdown' \? 'shutdown' : action\)/,
    'restart/shutdown must reach the destructive-command guardrail before OS dispatch',
  );
  assert.match(source, /systemctl', \[action === 'sleep' \? 'suspend' : action === 'restart' \? 'reboot' : 'poweroff'/);
});

test('Linux direct app launch honors cwd rather than silently accepting it', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'remcp-launch-cwd-'));
  try {
    const marker = 'cwd-marker';
    await linux.launchApp('/usr/bin/touch', [marker], { cwd:dir });
    const target = path.join(dir, marker);
    const deadline = Date.now() + 3000;
    let found = false;
    while (Date.now() < deadline) {
      try { await stat(target); found = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(found, true, 'detached child did not create marker in requested cwd');
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
});

test('Windows adapter source keeps the rich UIA/MSAA path compatible with Windows PowerShell 5.1', async () => {
  const windowsSource = await readFile(new URL('../src/extended/desktop-windows.mjs', import.meta.url), 'utf8');
  const commonSource = await readFile(new URL('../src/extended/common.mjs', import.meta.url), 'utf8');

  for (const marker of [
    'CacheRequest',
    'RootWebArea',
    'AccessibleObjectFromWindow',
    'LegacyIAccessiblePattern',
    'AttachThreadInput',
    'GetDpiForMonitor',
    'Get-StartApps',
    "Filter '*.lnk'",
    '-WorkingDirectory',
    'ScrollItemPattern',
    'RangeValuePattern',
    'SelectionItemPattern',
    'ExpandCollapsePattern',
  ]) assert.ok(windowsSource.includes(marker), `Windows adapter missing ${marker}`);

  assert.ok(commonSource.includes("WindowsPowerShell', 'v1.0', 'powershell.exe'"), 'runtime must keep the Windows PowerShell 5.1 execution path');
  assert.equal(/\$[A-Za-z_][\w.]*\s*\?\?/.test(windowsSource), false, 'embedded PowerShell must not contain PS7-only null-coalescing syntax');
  assert.equal(windowsSource.includes('FindAllBuildCache'), false, 'managed .NET UIA must use activated CacheRequest + FindAll, not native-only FindAllBuildCache');
});
