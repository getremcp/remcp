import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizedProcessName,linuxRegisteredProcessState}
  from '../src/extended/app-process-preflight.mjs';
import {inspectGuidedWorkflow} from '../src/extended/app-workflow-inspect.mjs';
import {planAppNavigation} from '../src/extended/app-navigation.mjs';

test('kernel-truncated task comm matches process only when full known prefix agrees',()=>{
  assert.equal(recognizedProcessName('gnome-calculato',['gnome-calculator']),true);
  assert.equal(recognizedProcessName('gnome-calculator',['gnome-calculator']),true);
  assert.equal(recognizedProcessName('thunderbird',['thunderbird']),true);
  assert.equal(recognizedProcessName('thunderbird-helper',['thunderbird']),false);
  assert.equal(recognizedProcessName('thunderbird-helper',['thunderbird-helper']),true);
  assert.equal(recognizedProcessName('not-thunderbird',['thunderbird']),false);
  assert.equal(recognizedProcessName('other.exe',['other']),true);
  assert.equal(recognizedProcessName('',['thunderbird']),false);
});

test('Linux process preflight is bounded and reports running or no registered process',()=>{
  const rows=['self','24','25','26'];
  const read=path=>path.includes('/24/')?'systemd':path.includes('/25/')?'thunderbird':'node';
  assert.equal(linuxRegisteredProcessState(['thunderbird'],{list:()=>rows,read}).state,'running');
  assert.equal(linuxRegisteredProcessState(['firefox'],{list:()=>rows,read}).state,'not_found');
  assert.equal(linuxRegisteredProcessState(['thunderbird'],{list:()=>rows,read,maxEntries:1}).state,'unknown');
  assert.equal(linuxRegisteredProcessState(['thunderbird'],{list:()=>{throw Error('permission denied')},read}).state,'unknown');
  assert.equal(linuxRegisteredProcessState(['thunderbird'],{list:()=>rows,read:()=>{throw Error('EPERM')}}).state,'unknown');
  assert.equal(linuxRegisteredProcessState([],{list:()=>rows,read}).state,'unknown');
});

test('Linux actual registered Thunderbird absence blocks before expensive accessibility scan',async()=>{
  if(process.platform!=='linux')return;
  let checks=0;
  const plan=planAppNavigation({app:'thunderbird',destination:'find_email'},{platform:'linux'});
  const result=await inspectGuidedWorkflow(plan,{},{
    requireInteractiveGuiSession:async()=>{},
    linuxRegisteredProcessState:()=>{checks++;return {state:'not_found'};},
  });
  assert.equal(checks,1);
  assert.equal(result.inspected,false);
  assert.equal(result.status,'inspection_unavailable');
  assert.equal(result.reason,'registered_process_not_running');
});

test('a stale or fake process is never enough to authorize UI actions',()=>{
  const state=linuxRegisteredProcessState(['thunderbird'],{
    list:()=>['101'],read:()=> 'thunderbird'
  });
  assert.equal(state.state,'running');
  // This state only permits an AX scan. No process PID is passed to any
  // action without a verified window+element snapshot.
  assert.equal(Object.hasOwn(state,'pid'),false);
  assert.equal(Object.hasOwn(state,'ui_id'),false);
});
