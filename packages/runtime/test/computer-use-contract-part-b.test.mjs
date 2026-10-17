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
  assert.match(
    source,
    /const delay = normalizePowerActionDelay\(args\.delay_seconds\);[\s\S]{0,220}await waitForPowerActionDelay\(delay, extra\.signal\);[\s\S]{0,220}throwIfCancelled\(extra\.signal\);[\s\S]{0,220}if \(process\.platform === 'win32'\)/,
    'delayed power actions must honor cancellation before any native power command is dispatched',
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
  const windowsSource = (await readFile(new URL('../src/extended/desktop-windows.mjs', import.meta.url), 'utf8')) + (await readFile(new URL('../src/extended/desktop-windows-msaa.mjs', import.meta.url), 'utf8'));
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
