import test from 'node:test';
import assert from 'node:assert/strict';
import {advertisedExtendedTools} from '../src/extended/catalog.mjs';
import {createDesktopWebRtcBridge} from '../src/extended/desktop-webrtc-bridge.mjs';

test('active capture keeps lifecycle reachable when fresh desktop discovery fails closed',async()=>{
  const tools=await advertisedExtendedTools({webrtc_pilot:false,desktop_session:false},
    {hasWebRtcSession:()=>true});
  const names=tools.map(t=>t.name).filter(n=>n.startsWith('desktop_webrtc_'));
  assert.deepEqual(names.sort(),[
    'desktop_webrtc_heartbeat','desktop_webrtc_status','desktop_webrtc_stop',
  ]);
  assert.ok(!names.includes('desktop_webrtc_offer'));
  assert.ok(!names.includes('desktop_webrtc_control'));
});

test('missing desktop never admits lifecycle tools without an owned active session',async()=>{
  const tools=await advertisedExtendedTools({webrtc_pilot:false},
    {hasWebRtcSession:()=>false});
  assert.ok(!tools.some(t=>t.name.startsWith('desktop_webrtc_')));
  const bridge=createDesktopWebRtcBridge({workerAvailable:()=>false});
  assert.equal(bridge.hasSession,false);
  await assert.rejects(bridge.heartbeat({session_id:crypto.randomUUID()}));
  await assert.rejects(bridge.control({session_id:crypto.randomUUID(),
    input:{seq:1,kind:'text',text:'must-not-type'}}));
  assert.equal(bridge.hasSession,false);
  await bridge.shutdown();
});
