import test from 'node:test';
import assert from 'node:assert/strict';
import {webRtcWorkerAvailable} from '../src/extended/desktop-webrtc-bridge.mjs';
test('native X11 worker requires a local display and refuses Wayland override',()=>{
  const env={REMCP_WEBRTC_RUNTIME_PILOT:'1',REMCP_WEBRTC_DEV_SOURCE:'x11',
    REMCP_WEBRTC_WORKER_SCRIPT:process.execPath,REMCP_WEBRTC_PYTHON:process.execPath,DISPLAY:':0'};
  assert.equal(webRtcWorkerAvailable(env,'linux'),true);
  for(const extra of [{DISPLAY:'host:0'},{DISPLAY:''},{WAYLAND_DISPLAY:'wayland-0'},{XDG_SESSION_TYPE:'wayland'}])
    assert.equal(webRtcWorkerAvailable({...env,...extra},'linux'),false);
  assert.equal(webRtcWorkerAvailable(env,'win32'),false);
  assert.equal(webRtcWorkerAvailable(env,'darwin'),false);
});
