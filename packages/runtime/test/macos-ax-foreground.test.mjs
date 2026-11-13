import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {MAC_AX_FOREGROUND_SOURCE,MAC_AX_READBACK_SOURCE}
  from '../src/extended/desktop-macos-ax-guards.mjs';

const evalScript=code=>vm.runInNewContext(code+';({foreground:axWindowForeground,readback:typeof axActionReadback!=="undefined"?axActionReadback:null})');
const ax=evalScript(MAC_AX_FOREGROUND_SOURCE+'\n'+MAC_AX_READBACK_SOURCE);
const processState=frontmost=>({frontmost:()=>frontmost});
const windowState=(main=true)=>({attributes:{byName:()=>({value:()=>main})}});
const noMainWindow=()=>({attributes:{byName:()=>{throw Error('AXMain inaccessible')}}});

test('macOS AX foreground requires actual frontmost process and AXMain, not window.focused',()=>{
  assert.equal(ax.foreground(processState(true),windowState(true),()=>[{}]),true);
  assert.equal(ax.foreground(processState(true),windowState(false),()=>[{}]),false);
  assert.equal(ax.foreground(processState(false),windowState(true),()=>[{}]),false);
  assert.equal(ax.foreground(processState(true),noMainWindow(),()=>[{}]),true);
  assert.equal(ax.foreground(processState(true),noMainWindow(),()=>[{},{}]),false);
  assert.equal(ax.foreground({frontmost:()=>{throw Error('TCC')}} ,windowState(true),()=>[{}]),false);
});

test('AX action attestation reports booleans only and does not leak a search query',()=>{
  const query='private string not to echo';
  const target={focused:true,value:query};
  const props=value=>({focused:value.focused,value:value.value});
  const scalar=value=>value;
  const focused=ax.readback(processState(true),windowState(true),target,'focus',
    query,props,scalar,()=>[{}]);
  assert.equal(focused.foreground_after,true);
  assert.equal(focused.focused_after,true);
  assert.equal(Object.hasOwn(focused,'value_matches_after'),false);
  const updated=ax.readback(processState(true),windowState(true),target,'set_value',
    query,props,scalar,()=>[{}]);
  assert.equal(updated.value_matches_after,true);
  assert.equal(Object.hasOwn(updated,'focused_after'),false);
  assert.ok(!JSON.stringify(updated).includes(query));
  target.value='';
  assert.equal(ax.readback(processState(true),windowState(true),target,'set_value',
    query,props,scalar,()=>[{}]).value_matches_after,false);
  assert.equal(ax.readback(processState(false),windowState(true),target,'focus',
    query,props,scalar,()=>[{}]).foreground_after,false);
});

test('macOS main adapter uses shared guard for snapshot and mutations',()=>{
  const source=readFileSync(new URL('../src/extended/desktop-macos.mjs',import.meta.url),'utf8');
  assert.match(source,/active:foregroundVerified/);
  assert.match(source,/const foregroundVerified=axWindowForeground\(proc,win,safeWindows\)/);
  assert.match(source,/if\(!axWindowForeground\(proc,win,safeWindows\)\)/);
  assert.match(source,/const attested=axActionReadback\(proc,win,target,action,inputValue,props,scalar,safeWindows\)/);
  assert.doesNotMatch(source,/window:windowName,active:true/);
});
