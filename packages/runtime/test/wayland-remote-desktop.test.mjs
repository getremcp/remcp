import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWaylandRemoteDesktopSession, portalPointerMotionAbsolute, portalTypeText, waylandPortalCandidate, portalShortcut, portalPointerButton, portalScroll } from '../src/wayland-remote-desktop.mjs';

const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REMOTE = 'org.freedesktop.portal.RemoteDesktop';
const REQUEST = 'org.freedesktop.portal.Request';
const SESSION = 'org.freedesktop.portal.Session';

class FakeVariant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

class FakeMessage {
  constructor(value) { Object.assign(this, value); }
}

function fakeDbus({ startResponse = 0, devices = 3, restoreToken = 'restore-next', expectedParentWindow = '' } = {}) {
  const bus = new EventEmitter();
  bus.name = ':1.77';
  let disconnected = false;
  let matchDepth = 0;
  const calls = [];
  const sessionPath = '/org/freedesktop/portal/desktop/session/1_77/remcp_test';

  const emitResponse = (options, response, results = {}) => {
    assert.ok(matchDepth > 0, 'Response match must be installed before the portal method runs');
    const handle = `/org/freedesktop/portal/desktop/request/1_77/${options.handle_token.value}`;
    bus.emit('message', {
      type: 4,
      path: handle,
      interface: REQUEST,
      member: 'Response',
      body: [response, results],
    });
    return handle;
  };

  const remote = {
    async CreateSession(options) {
      calls.push({ method: 'CreateSession', options });
      assert.match(options.handle_token.value, /^create_remote_desktop_/);
      assert.match(options.session_handle_token.value, /^session_/);
      return emitResponse(options, 0, { session_handle: new FakeVariant('o', sessionPath) });
    },
    async SelectDevices(session, options) {
      calls.push({ method: 'SelectDevices', session, options });
      assert.equal(session, sessionPath);
      assert.equal(options.types.value, 3);
      assert.equal(options.persist_mode.value, 2);
      return emitResponse(options, 0, {});
    },
    async Start(session, parentWindow, options) {
      calls.push({ method: 'Start', session, parentWindow, options });
      assert.equal(session, sessionPath);
      assert.equal(parentWindow, expectedParentWindow);
      return emitResponse(options, startResponse, startResponse === 0 ? {
        devices: new FakeVariant('u', devices),
        restore_token: new FakeVariant('s', restoreToken),
        streams: new FakeVariant('a(ua{sv})', []),
      } : {});
    },
  };

  const sessionInterface = new EventEmitter();
  sessionInterface.Close = async () => {};

  bus.call = async message => {
    if (message.member === 'AddMatch') matchDepth += 1;
    if (message.member === 'RemoveMatch') matchDepth -= 1;
    return null;
  };
  bus.disconnect = () => { disconnected = true; };
  bus.getProxyObject = async (_name, objectPath) => {
    if (objectPath === PORTAL_PATH) {
      return {
        getInterface(name) {
          assert.equal(name, REMOTE);
          return remote;
        },
      };
    }
    assert.equal(objectPath, sessionPath);
    return {
      getInterface(name) {
        assert.equal(name, SESSION);
        return sessionInterface;
      },
    };
  };

  return {
    module: {
      Variant: FakeVariant,
      Message: FakeMessage,
      MessageType: { SIGNAL: 4 },
      sessionBus: () => bus,
    },
    calls,
    disconnected: () => disconnected,
    sessionPath,
  };
}

test('Wayland portal candidate requires Linux, Wayland and a user D-Bus session', () => {
  assert.equal(waylandPortalCandidate({ XDG_SESSION_TYPE: 'x11', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' }, 'linux'), false);
  assert.equal(waylandPortalCandidate({ XDG_SESSION_TYPE: 'wayland', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' }, 'linux'), true);
  assert.equal(waylandPortalCandidate({ XDG_SESSION_TYPE: 'wayland', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus' }, 'darwin'), false);
});

test('remote desktop portal requests keyboard+pointer and persists the refreshed restore token', async () => {
  const fake = fakeDbus({ expectedParentWindow:'x11:c00004' });
  const persisted = [];
  const cleared = [];
  const state = await createWaylandRemoteDesktopSession({
    timeoutMs: 1000,
    parentWindow:'x11:c00004',
    env: { XDG_SESSION_TYPE: 'wayland' },
    loadDbusModule: async () => fake.module,
    readToken: async () => 'restore-old',
    persistToken: async value => persisted.push(value),
    clearToken: async () => cleared.push(true),
  });

  assert.equal(state.session, fake.sessionPath);
  assert.equal(state.devices, 3);
  assert.deepEqual(persisted, ['restore-next']);
  assert.deepEqual(cleared, []);
  const select = fake.calls.find(call => call.method === 'SelectDevices');
  assert.equal(select.options.restore_token.value, 'restore-old');
  assert.equal(fake.disconnected(), false, 'successful session stays connected for input events');
});

test('remote desktop portal clears a stale restore token and disconnects when Start is denied', async () => {
  const fake = fakeDbus({ startResponse: 2 });
  let cleared = 0;
  await assert.rejects(
    createWaylandRemoteDesktopSession({
      timeoutMs: 1000,
      env: { XDG_SESSION_TYPE: 'wayland' },
      loadDbusModule: async () => fake.module,
      readToken: async () => 'stale-token',
      persistToken: async () => {},
      clearToken: async () => { cleared += 1; },
    }),
    /denied by the desktop portal/,
  );
  assert.equal(cleared, 1);
  assert.equal(fake.disconnected(), true);
});


test('EIS direct typing rejects unsupported Unicode before sending any partial input', async () => {
  const sent = [];
  await assert.rejects(
    portalTypeText('abc✓', {
      delayMs:0,
      state:{
        backend:'xdg-eis',
        async send(payload) { sent.push(payload); },
      },
    }),
    /supports ASCII only/,
  );
  assert.deepEqual(sent, []);
});

test('EIS absolute pointer motion sends desktop coordinates without relative calibration', async () => {
  const sent = [];
  await portalPointerMotionAbsolute(321.5, -42, {
    state: {
      backend: 'xdg-eis',
      async send(payload) { sent.push(payload); },
    },
  });
  assert.deepEqual(sent, [{ op:'motion_absolute', x:321.5, y:-42 }]);
});

test('absolute pointer motion fails closed on legacy portal backends', async () => {
  await assert.rejects(
    portalPointerMotionAbsolute(10, 20, { state:{ backend:'xdg-dbus' } }),
    /requires the EIS Remote Desktop backend/,
  );
});

test('EIS shortcut sends modifier down/up events in safe order', async () => {
  const sent = [];
  const state = { backend:'xdg-eis', send:async payload => { sent.push(payload); } };
  await portalShortcut('Ctrl+Shift+A', { state });
  assert.deepEqual(sent, [
    { op:'key', keycode:29, pressed:true },
    { op:'key', keycode:42, pressed:true },
    { op:'key', keycode:30, pressed:true },
    { op:'key', keycode:30, pressed:false },
    { op:'key', keycode:42, pressed:false },
    { op:'key', keycode:29, pressed:false },
  ]);
});

test('Wayland EIS pointer buttons and wheel steps preserve their wire protocol', async () => {
  const sent = [];
  const state = { backend:'xdg-eis', send:async payload => { sent.push(payload); } };
  await portalPointerButton('right', true, { state });
  await portalPointerButton('right', false, { state });
  await portalScroll(241, -119, { state });
  assert.deepEqual(sent, [
    { op:'button', button:0x111, pressed:true },
    { op:'button', button:0x111, pressed:false },
    { op:'scroll', dx:240, dy:-120 },
  ]);
});

test('legacy XDG portal uses DBus input without spawning a second session', async () => {
  const calls = [];
  const state = {
    backend:'xdg-dbus', session:'/session/fixture',
    remote:{
      async NotifyPointerButton(...args) { calls.push(['button', ...args]); },
      async NotifyPointerAxisDiscrete(...args) { calls.push(['axis', ...args]); },
    },
  };
  await portalPointerButton('middle', true, { state });
  await portalScroll(0, 240, { state });
  assert.deepEqual(calls, [
    ['button', '/session/fixture', {}, 0x112, 1],
    ['axis', '/session/fixture', {}, 0, 2],
  ]);
});
