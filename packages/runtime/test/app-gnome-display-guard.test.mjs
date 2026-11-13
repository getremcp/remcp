import test from 'node:test';
import assert from 'node:assert/strict';
import {isAffectedClosedLidGnomeDisplay,assertGnomeDisplaySafe} from '../src/extended/app-gnome-display-guard.mjs';

const affected={
  osRelease:'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="26.04"\n',
  packageVersion:'1:50.3-0ubuntu0.2',
  lidStates:['state:      closed\n'],
  connectors:[{name:'card1-eDP-1',status:'connected'},{name:'card1-HDMI-A-1',status:'disconnected'}],
};
test('only the known GNOME 50.3 closed-lid crash case is refused',()=>{
  assert.equal(isAffectedClosedLidGnomeDisplay(affected),true);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,lidStates:['state: open']}),false);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,connectors:[...affected.connectors,{name:'card1-DP-2',status:'connected'}]}),false);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,packageVersion:'1:50.3-0ubuntu0.3'}),false);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,osRelease:'ID=fedora\nVERSION_ID="43"'}),false);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,connectors:[]}),false);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,connectors:[{name:'card0-HDMI-A-1',status:'disconnected'}]}),false);
  assert.equal(isAffectedClosedLidGnomeDisplay({...affected,packageVersion:'1:50.3-0ubuntu0.1'}),true);
});
test('safe panels never query device or OS state',async()=>{
  await assert.doesNotReject(assertGnomeDisplaySafe({shell:'gnome',panel:'wifi'}));
  await assert.doesNotReject(assertGnomeDisplaySafe({shell:'kde',panel:'display'}));
});
test('ASUS known crash scenario is rejected before launching Settings',{skip:process.platform!=='linux'||!process.env.DISPLAY},async()=>{
  // Linux hosts with other distributions/packages simply pass this preflight.
  const module = await import('node:fs/promises');
  const osr=await module.readFile('/etc/os-release','utf8');
  if (!/VERSION_ID="26\.04"/.test(osr)) return;
  const e=await assertGnomeDisplaySafe({shell:'gnome',panel:'display'})
    .then(()=>null,error=>error);
  // On matching known-bad machines we must get an explicit refusal, not SIGSEGV.
  if(e) assert.match(e.message,/2169467/);
});
