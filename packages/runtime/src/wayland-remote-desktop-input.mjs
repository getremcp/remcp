import { ToolError } from './util.mjs';

// Bind input operations to the owning portal session manager. Never establish an
// independent session here: restore tokens, grant revocation and cleanup belong to
// wayland-remote-desktop.mjs.
export function createWaylandInput(ensureWaylandRemoteDesktop) {
function keysymForToken(tokenValue) {
  const token = String(tokenValue || '').trim();
  const normalized = token.toLowerCase();
  const named = {
    ctrl: 0xffe3, control: 0xffe3, shift: 0xffe1, alt: 0xffe9, option: 0xffe9,
    super: 0xffeb, meta: 0xffeb, cmd: 0xffeb, command: 0xffeb,
    enter: 0xff0d, return: 0xff0d, esc: 0xff1b, escape: 0xff1b, tab: 0xff09,
    backspace: 0xff08, delete: 0xffff, up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53,
    home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56, space: 0x20,
  };
  if (named[normalized]) return named[normalized];
  const fn = normalized.match(/^f(\d{1,2})$/);
  if (fn) {
    const number = Number(fn[1]);
    if (number >= 1 && number <= 35) return 0xffbd + number;
  }
  const chars = [...token];
  if (chars.length !== 1) throw new ToolError(`Unsupported keyboard token: ${token}`);
  const codePoint = chars[0].codePointAt(0);
  return codePoint <= 0xff ? codePoint : (0x01000000 | codePoint);
}

async function notifyKeysym(state, keysym, keyState) {
  if (state.backend === 'xdg-eis') throw new ToolError('EIS 1.2 keyboard input requires evdev keycodes, not X11 keysyms');
  await state.remote.NotifyKeyboardKeysym(state.session, {}, keysym, keyState);
}

async function notifyKeycode(state, keycode, keyState) {
  if (state.backend === 'xdg-eis') {
    await state.send({ op:'key', keycode:Number(keycode), pressed:keyState === 1 });
    return;
  }
  await state.remote.NotifyKeyboardKeycode(state.session, {}, keycode, keyState);
}

function keycodeForToken(tokenValue) {
  const token = String(tokenValue || '').trim().toLowerCase();
  const named = {
    esc:1, escape:1,
    '1':2, '2':3, '3':4, '4':5, '5':6, '6':7, '7':8, '8':9, '9':10, '0':11,
    minus:12, '-':12, equal:13, '=':13, backspace:14, tab:15,
    q:16, w:17, e:18, r:19, t:20, y:21, u:22, i:23, o:24, p:25,
    '[':26, ']':27, enter:28, return:28, ctrl:29, control:29,
    a:30, s:31, d:32, f:33, g:34, h:35, j:36, k:37, l:38,
    ';':39, "'":40, grave:41, backtick:41, '`':41, shift:42, '\\':43,
    z:44, x:45, c:46, v:47, b:48, n:49, m:50, ',':51, '.':52, '/':53,
    alt:56, option:56, space:57,
    f1:59, f2:60, f3:61, f4:62, f5:63, f6:64, f7:65, f8:66, f9:67, f10:68,
    f11:87, f12:88,
    home:102, up:103, pageup:104, left:105, right:106, end:107, down:108, pagedown:109,
    insert:110, delete:111,
    super:125, meta:125, cmd:125, command:125,
  };
  return Number.isInteger(named[token]) ? named[token] : null;
}

async function notifyToken(state, token, keyState) {
  if (state.backend === 'xdg-eis') {
    const keycode = keycodeForToken(token);
    if (!Number.isInteger(keycode)) throw new ToolError(`Unsupported EIS keyboard token: ${token}`);
    return notifyKeycode(state, keycode, keyState);
  }
  return notifyKeysym(state, keysymForToken(token), keyState);
}

async function portalShortcut(shortcut, options = {}) {
  const state = options.state || await ensureWaylandRemoteDesktop(options);
  const tokens = String(shortcut || '').split('+').map(value => value.trim()).filter(Boolean);
  if (!tokens.length) throw new ToolError('shortcut or key is required');
  const modifiers = tokens.slice(0, -1);
  const key = tokens.at(-1);
  for (const modifier of modifiers) await notifyToken(state, modifier, 1);
  await notifyToken(state, key, 1);
  await notifyToken(state, key, 0);
  for (const modifier of [...modifiers].reverse()) await notifyToken(state, modifier, 0);
}

function eisStrokeForChar(char) {
  if (char === '\n') return { keycode:28, shift:false };
  if (char === '\t') return { keycode:15, shift:false };
  if (char === ' ') return { keycode:57, shift:false };
  if (/^[a-z]$/.test(char)) return { keycode:keycodeForToken(char), shift:false };
  if (/^[A-Z]$/.test(char)) return { keycode:keycodeForToken(char), shift:true };
  if (/^[0-9]$/.test(char)) return { keycode:keycodeForToken(char), shift:false };
  const plain = { '-':12, '=':13, '[':26, ']':27, ';':39, "'":40, '`':41, '\\':43, ',':51, '.':52, '/':53 };
  if (Number.isInteger(plain[char])) return { keycode:plain[char], shift:false };
  const shifted = { '!':2, '@':3, '#':4, '$':5, '%':6, '^':7, '&':8, '*':9, '(':10, ')':11, '_':12, '+':13, '{':26, '}':27, ':':39, '"':40, '~':41, '|':43, '<':51, '>':52, '?':53 };
  if (Number.isInteger(shifted[char])) return { keycode:shifted[char], shift:true };
  return null;
}

async function portalTypeText(value, { delayMs = 1, timeoutMs, state: suppliedState } = {}) {
  const state = suppliedState || await ensureWaylandRemoteDesktop({ timeoutMs });
  const input = String(value ?? '');
  if (state.backend === 'xdg-eis') {
    const strokes = [...input].map(eisStrokeForChar);
    if (strokes.some(stroke => !stroke)) {
      throw new ToolError('EIS 1.2 direct typing supports ASCII only; use accessibility or clipboard-paste input for Unicode text');
    }
    for (const stroke of strokes) {
      if (stroke.shift) await notifyKeycode(state, 42, 1);
      await notifyKeycode(state, stroke.keycode, 1);
      await notifyKeycode(state, stroke.keycode, 0);
      if (stroke.shift) await notifyKeycode(state, 42, 0);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1000, delayMs)));
    }
    return;
  }
  for (const char of input) {
      const keysym = char === '\n' ? 0xff0d : char === '\t' ? 0xff09 : keysymForToken(char);
      await notifyKeysym(state, keysym, 1);
      await notifyKeysym(state, keysym, 0);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1000, delayMs)));
  }
}

async function portalPointerMotion(dx, dy, options = {}) {
  const state = options.state || await ensureWaylandRemoteDesktop(options);
  if (state.backend === 'xdg-eis') {
    await state.send({ op:'motion', dx:Number(dx), dy:Number(dy) });
    return;
  }
  await state.remote.NotifyPointerMotion(state.session, {}, Number(dx), Number(dy));
}

async function portalPointerMotionAbsolute(x, y, options = {}) {
  const state = options.state || await ensureWaylandRemoteDesktop(options);
  if (state.backend === 'xdg-eis') {
    await state.send({ op:'motion_absolute', x:Number(x), y:Number(y) });
    return;
  }
  throw new ToolError('Absolute pointer motion requires the EIS Remote Desktop backend');
}

async function portalPointerButton(button, pressed, options = {}) {
  const state = options.state || await ensureWaylandRemoteDesktop(options);
  const code = String(button || 'left').toLowerCase() === 'right' ? 0x111 : String(button || 'left').toLowerCase() === 'middle' ? 0x112 : 0x110;
  if (state.backend === 'xdg-eis') {
    await state.send({ op:'button', button:code, pressed:Boolean(pressed) });
    return;
  }
  await state.remote.NotifyPointerButton(state.session, {}, code, pressed ? 1 : 0);
}

async function portalScroll(dx, dy, options = {}) {
  const state = options.state || await ensureWaylandRemoteDesktop(options);
  const steps = delta => delta ? Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 120)) : 0;
  const x = steps(dx), y = steps(dy);
  if (state.backend === 'xdg-eis') {
    await state.send({ op:'scroll', dx:x * 120, dy:y * 120 });
    return;
  }
  if (x) await state.remote.NotifyPointerAxisDiscrete(state.session, {}, 1, x);
  if (y) await state.remote.NotifyPointerAxisDiscrete(state.session, {}, 0, y);
}


  return {
    portalShortcut, portalTypeText, portalPointerMotion, portalPointerMotionAbsolute,
    portalPointerButton, portalScroll,
  };
}
