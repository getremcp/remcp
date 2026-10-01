import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePortalScreenshot, isWaylandSession } from '../src/screenshot-portal.mjs';
import { portalCropGeometry, regionScreenshotBackends } from '../src/extended/desktop-linux.mjs';

class FakeVariant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

class FakeMessage {
  constructor(value) { Object.assign(this, value); }
}

function fakeDbus({ response = 0, uri, returnedHandle } = {}) {
  const bus = new EventEmitter();
  bus.name = ':1.42';
  let addMatchSeen = false;
  let disconnected = false;
  const signalType = 4;
  bus.call = async message => {
    if (message.member === 'AddMatch') addMatchSeen = true;
    if (message.member === 'RemoveMatch') addMatchSeen = false;
    return null;
  };
  bus.disconnect = () => { disconnected = true; };
  bus.getProxyObject = async (_name, objectPath) => {
    assert.equal(objectPath, '/org/freedesktop/portal/desktop');
    return {
      getInterface(name) {
        assert.equal(name, 'org.freedesktop.portal.Screenshot');
        return {
          async Screenshot(_parent, options) {
            assert.equal(addMatchSeen, true, 'Response match must be installed before Screenshot()');
            assert.equal(options.interactive.value, false);
            assert.match(options.handle_token.value, /^remcp_/);
            const predicted = `/org/freedesktop/portal/desktop/request/1_42/${options.handle_token.value}`;
            const handle = returnedHandle?.(options.handle_token.value) || predicted;
            // Emit synchronously, before the method reply. This is the race the implementation must
            // handle: a listener installed after Screenshot() returns would miss this response.
            bus.emit('message', {
              type: signalType,
              path: handle,
              interface: 'org.freedesktop.portal.Request',
              member: 'Response',
              body: [response, uri ? { uri: new FakeVariant('s', uri) } : {}],
            });
            return handle;
          },
        };
      },
    };
  };
  return {
    module: {
      Variant: FakeVariant,
      Message: FakeMessage,
      MessageType: { SIGNAL: signalType },
      sessionBus: () => bus,
    },
    disconnected: () => disconnected,
  };
}

test('Wayland detection accepts session type or WAYLAND_DISPLAY', () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }), true);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), false);
});

test('region screenshot backends only advertise working session-specific candidates', () => {
  assert.deepEqual(
    regionScreenshotBackends({ wayland:true, grim:false, gnomeScreenshot:true, ffmpeg:true, imagemagick:true, portalCandidate:true }),
    ['gnome-screenshot','portal'],
  );
  assert.deepEqual(
    regionScreenshotBackends({ wayland:true, grim:true, gnomeScreenshot:true, ffmpeg:true, imagemagick:true, portalCandidate:true }),
    ['grim','gnome-screenshot','portal'],
  );
  assert.deepEqual(
    regionScreenshotBackends({ wayland:true, grim:false, gnomeScreenshot:true, ffmpeg:true, imagemagick:true, portalCandidate:false }),
    ['gnome-screenshot'],
  );
  assert.deepEqual(
    regionScreenshotBackends({ wayland:true, grim:false, gnomeScreenshot:false, ffmpeg:true, imagemagick:true, portalCandidate:false }),
    [],
  );
  assert.deepEqual(
    regionScreenshotBackends({ wayland:false, grim:true, gnomeScreenshot:true, ffmpeg:true, imagemagick:true, portalCandidate:true }),
    ['imagemagick'],
  );
});

test('portal crop clips oversized and off-screen window bounds to the visible desktop', () => {
  const displays = [{ x:0, y:0, width:1440, height:900 }];
  assert.deepEqual(
    portalCropGeometry({ x:0, y:0, width:931, height:910 }, displays, { width:1440, height:900 }),
    {
      x:0, y:0, width:931, height:900,
      visible:{ x:0, y:0, width:931, height:900 },
      clipped:true,
    },
  );
  assert.deepEqual(
    portalCropGeometry({ x:-50, y:-20, width:200, height:100 }, displays, { width:1440, height:900 }),
    {
      x:0, y:0, width:150, height:80,
      visible:{ x:0, y:0, width:150, height:80 },
      clipped:true,
    },
  );
});

test('portal crop translates negative virtual-desktop origins and bitmap scaling', () => {
  const displays = [
    { x:-1280, y:0, width:1280, height:900 },
    { x:0, y:0, width:1440, height:900 },
  ];
  assert.deepEqual(
    portalCropGeometry({ x:-1280, y:0, width:640, height:450 }, displays, { width:5440, height:1800 }),
    {
      x:0, y:0, width:1280, height:900,
      visible:{ x:-1280, y:0, width:640, height:450 },
      clipped:false,
    },
  );
  assert.throws(
    () => portalCropGeometry({ x:3000, y:0, width:100, height:100 }, displays, { width:2720, height:900 }),
    /outside visible desktop bounds/,
  );
});

test('portal screenshot subscribes before the method call and does not delete an untrusted URI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-test-'));
  const source = join(root, 'source.png');
  const destination = join(root, 'destination.png');
  writeFileSync(source, Buffer.from('fake-png'));
  const fake = fakeDbus({ uri: pathToFileURL(source).href });

  const returned = await capturePortalScreenshot(destination, { loadDbus: async () => fake.module, timeoutMs: 1000 });
  assert.equal(returned, destination);
  assert.equal(readFileSync(destination, 'utf8'), 'fake-png');
  assert.equal(existsSync(source), true, 'an untrusted portal URI is copied but never deleted');
  assert.equal(fake.disconnected(), true);
});

test('portal screenshot buffers a fast response when an older portal returns a different handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-legacy-'));
  const source = join(root, 'source.png');
  const destination = join(root, 'destination.png');
  writeFileSync(source, Buffer.from('legacy-png'));
  const fake = fakeDbus({
    uri: pathToFileURL(source).href,
    returnedHandle: token => `/org/freedesktop/portal/desktop/request/legacy_sender/${token}`,
  });

  await capturePortalScreenshot(destination, { loadDbus: async () => fake.module, timeoutMs: 1000 });
  assert.equal(readFileSync(destination, 'utf8'), 'legacy-png');
  assert.equal(fake.disconnected(), true);
});

test('portal screenshot preserves cancellation and rejects non-file responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-errors-'));
  const destination = join(root, 'destination.png');
  const cancelled = fakeDbus({ response: 1 });
  await assert.rejects(
    capturePortalScreenshot(destination, { loadDbus: async () => cancelled.module, timeoutMs: 1000 }),
    error => error.code === 'PORTAL_CANCELLED' && /screen capture permission was cancelled/.test(error.message),
  );
  assert.equal(cancelled.disconnected(), true);

  const remote = fakeDbus({ uri: 'https://example.test/screenshot.png' });
  await assert.rejects(
    capturePortalScreenshot(destination, { loadDbus: async () => remote.module, timeoutMs: 1000 }),
    /unsupported file URI/,
  );
  assert.equal(remote.disconnected(), true);
});

test('portal screenshot refuses symlink sources and symlink destinations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-links-'));
  const realSource = join(root, 'source.png');
  const sourceLink = join(root, 'source-link.png');
  const destination = join(root, 'destination.png');
  const victim = join(root, 'victim.png');
  const destinationLink = join(root, 'destination-link.png');
  writeFileSync(realSource, Buffer.from('source-png'));
  writeFileSync(victim, Buffer.from('victim-original'));
  symlinkSync(realSource, sourceLink);
  symlinkSync(victim, destinationLink);

  const linkedSource = fakeDbus({ uri: pathToFileURL(sourceLink).href });
  await assert.rejects(
    capturePortalScreenshot(destination, { loadDbus: async () => linkedSource.module, timeoutMs:1000 }),
    /symbolic|ELOOP|too many levels/i,
  );
  assert.equal(linkedSource.disconnected(), true);
  assert.equal(existsSync(destination), false);

  const linkedDestination = fakeDbus({ uri: pathToFileURL(realSource).href });
  await assert.rejects(
    capturePortalScreenshot(destinationLink, { loadDbus: async () => linkedDestination.module, timeoutMs:1000 }),
    /symbolic|ELOOP|too many levels/i,
  );
  assert.equal(linkedDestination.disconnected(), true);
  assert.equal(readFileSync(victim, 'utf8'), 'victim-original');
});
