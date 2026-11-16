import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {webRtcWorkerAvailable} from '../src/extended/desktop-webrtc-bridge.mjs';
test('native X11 worker requires a local display and refuses Wayland override',t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'remcp-x11-source-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const script=path.join(directory,'worker.py');
  writeFileSync(script,'# trusted local test worker\n',{mode:0o600});
  const env={REMCP_WEBRTC_RUNTIME_PILOT:'1',REMCP_WEBRTC_DEV_SOURCE:'x11',
    REMCP_WEBRTC_WORKER_SCRIPT:script,REMCP_WEBRTC_PYTHON:process.execPath,DISPLAY:':0'};
  assert.equal(webRtcWorkerAvailable(env,'linux'),true);
  for(const extra of [{DISPLAY:'host:0'},{DISPLAY:''},{WAYLAND_DISPLAY:'wayland-0'},{XDG_SESSION_TYPE:'wayland'}])
    assert.equal(webRtcWorkerAvailable({...env,...extra},'linux'),false);
  assert.equal(webRtcWorkerAvailable(env,'win32'),false);
  assert.equal(webRtcWorkerAvailable(env,'darwin'),false);
});
