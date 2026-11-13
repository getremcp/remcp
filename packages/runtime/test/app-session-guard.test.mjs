import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGuiSession, requireInteractiveGuiSession } from '../src/extended/app-session-guard.mjs';

test('Windows Session 0 and noninteractive logins refuse desktop input', () => {
  assert.equal(classifyGuiSession('win32',{sessionId:0,userInteractive:false}).interactive,false);
  assert.equal(classifyGuiSession('win32',{sessionId:0,userInteractive:true}).interactive,false);
  assert.equal(classifyGuiSession('win32',{sessionId:2,userInteractive:false}).interactive,false);
  assert.equal(classifyGuiSession('win32',{sessionId:2,userInteractive:true}).interactive,true);
  assert.equal(classifyGuiSession('win32',{sessionId:undefined,userInteractive:true}).interactive,false);
  assert.equal(classifyGuiSession('win32',{sessionId:2,userInteractive:'true'}).interactive,false);
});

test('Linux without X11 or Wayland and macOS without console owner refuse GUI navigation', () => {
  assert.equal(classifyGuiSession('linux',{env:{}}).interactive,false);
  assert.equal(classifyGuiSession('linux',{env:{DISPLAY:':0'}}).interactive,true);
  assert.equal(classifyGuiSession('linux',{env:{WAYLAND_DISPLAY:'wayland-0'}}).interactive,true);
  assert.equal(classifyGuiSession('darwin',{consoleUser:'root',currentUser:'root'}).interactive,false);
  assert.equal(classifyGuiSession('darwin',{consoleUser:'anton',currentUser:'qa'}).interactive,false);
  assert.equal(classifyGuiSession('darwin',{consoleUser:'anton',currentUser:'anton'}).interactive,true);
  assert.equal(classifyGuiSession('other',{}).interactive,false);
});

test('Linux current environment is checked without launching anything', {skip:process.platform!=='linux'}, async () => {
  const result = await requireInteractiveGuiSession();
  assert.equal(result.interactive,true);
  assert.equal(result.reason,'display_advertised');
});
