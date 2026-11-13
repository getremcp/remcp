// Explicit Linux AT-SPI E2E. Never run as part of ordinary npm test.
// Only touches its own isolated GTK test window. No other user windows.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {uiSnapshot,uiAction,resultValue} from '../src/extended/desktop-core.mjs';

if(process.platform!=='linux')throw Error('Native AT-SPI smoke requires Linux');
const check=spawnSync('python3',['-c',
  "import gi;gi.require_version('Gtk','3.0');from gi.repository import Gtk"],{
  timeout:3000,encoding:'utf8'});
if(check.status!==0)throw Error('GTK3 is not available; no changes made');
const root=mkdtempSync(path.join(os.tmpdir(),'remcp-native-ui-qa-'));
const label='ReMCP QA Search Entry';
const windowTitle='ReMCP Native Computer Use QA';
const python=String.raw`import gi,os
gi.require_version("Gtk","3.0")
from gi.repository import Gtk, GLib
w=Gtk.Window(title="ReMCP Native Computer Use QA")
w.set_default_size(420,190)
outer=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=12)
outer.set_border_width(18)
label=Gtk.Label(label="ReMCP QA Search Entry")
label.set_xalign(0)
field=Gtk.Entry()
field.set_text("before")
def reactive_reset(entry):
 if entry.get_text()=="reject-me": entry.set_text("after")
field.connect("changed",reactive_reset)
field.get_accessible().set_name("ReMCP QA Search Entry")
outer.pack_start(label,False,False,0)
outer.pack_start(field,False,False,0)
check=Gtk.CheckButton(label="ReMCP QA Never Touch")
outer.pack_start(check,False,False,0)
w.add(outer)
w.connect("destroy",Gtk.main_quit)
w.show_all();w.present()
image_path=os.environ.get("REMCP_TEST_SCREENSHOT","")
if image_path:
 import cairo
 def capture_qa_window():
  if field.get_text()!="after": return True
  if os.path.isabs(image_path) and not os.path.exists(image_path):
   surface=cairo.ImageSurface(cairo.FORMAT_ARGB32,w.get_allocated_width(),w.get_allocated_height())
   w.draw(cairo.Context(surface))
   surface.write_to_png(image_path)
  return False
 GLib.timeout_add(200,capture_qa_window)
print("GTK_QA_READY="+str(os.getpid()),flush=True)
Gtk.main()
`;
const script=path.join(root,'remcp-native-qa.py');
writeFileSync(script,python,{mode:0o600});
const gtk=spawn('python3',['-u',script],{stdio:['ignore','pipe','pipe']});
let stderr='';
gtk.stderr.on('data',chunk=>{stderr+=String(chunk).slice(0,1000);});
const pid=gtk.pid;
assert.ok(Number.isSafeInteger(pid)&&pid>0);
try{
 let found=null,window=null;
 for(let attempt=0;attempt<45;attempt++){
   try{
     const res=(await uiSnapshot({pid,max_nodes:100,max_depth:9,timeout_ms:5000})).structuredContent;
     const matching=(res.nodes||[]).filter(x=>x.pid===pid&&x.name===label&&x.role==='text');
     const windows=(res.nodes||[]).filter(x=>x.pid===pid&&x.name===windowTitle&&
       ['frame','dialog','window'].includes(String(x.role).toLowerCase()));
     if(matching.length===1&&windows.length===1&&matching[0].active){
       found=matching[0];window=windows[0];break;
     }
   }catch(error){if(attempt===44)throw error;}
   await sleep(150);
 }
 assert.ok(found&&window,'Expected one active native QA field and window, no other application');
 assert.match(found.id,new RegExp('^linux:'+pid+':r(?:\\.\\d+)+$'));
 assert.equal(found.value,'before');
 console.log('AT_SPI_NATIVE_SEMANTIC_SNAPSHOT_OK');
 const target={id:found.id,pid,app:found.app,window_title:windowTitle,
   name:label,role:'text',action:'set_value',semantic_only:true,strict_target_id:true};
 const read=async()=>{
   const tree=(await uiSnapshot({pid,max_nodes:100,max_depth:9,timeout_ms:8000})).structuredContent;
   const exact=(tree.nodes||[]).filter(x=>x.id===target.id&&x.pid===pid&&
     x.name===label&&x.role==='text');
   assert.equal(exact.length,1,'Native target changed, refuse to act');
   return exact[0].value;
 };
 const rejects=async(options)=>{
   await assert.rejects(uiAction({...target,value:'unexpected',...options}));
 };
 await rejects({expected_value:'stale'});
 assert.equal(await read(),'before');
 console.log('NATIVE_STALE_CAS_REJECTED');
 await rejects({id:'linux:'+pid+':r.0.99.99',expected_value:'before'});
 assert.equal(await read(),'before');
 console.log('NATIVE_STALE_PATH_REJECTED');
 await rejects({role:'button',expected_value:'before'});
 assert.equal(await read(),'before');
 console.log('NATIVE_IDENTITY_MISMATCH_REJECTED');
 const ack=resultValue(await uiAction({...target,value:'after',expected_value:'before'}));
 assert.equal(ack?.value_matches_after,true,'native AT-SPI provider readback must confirm');
 assert.equal(await read(),'after');
 console.log('NATIVE_EXACT_SET_VALUE_READBACK_OK');
 await assert.rejects(uiAction({...target,value:'reject-me',expected_value:'after'}));
 assert.equal(await read(),'after','reactive rollback must not be reported as success');
 console.log('NATIVE_REACTIVE_REVERT_BLOCKED');
 await rejects({expected_value:'before'});
 assert.equal(await read(),'after');
 console.log('NATIVE_REPLAY_CAS_REJECTED');
 const final=(await uiSnapshot({pid,max_nodes:100,max_depth:9,timeout_ms:8000})).structuredContent;
 assert.ok(final.nodes.some(n=>n.name==='ReMCP QA Never Touch'&&
   /check/i.test(String(n.role))),'unrelated QA checkbox must remain enumerated');
 console.log('NATIVE_AT_SPI_E2E_OK');
}finally{
 if(gtk.exitCode===null&&gtk.signalCode===null){
   const closed=new Promise(resolve=>gtk.once('close',resolve));
   gtk.kill('SIGTERM');
   await Promise.race([closed,sleep(2000)]);
 }
 rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
 if(stderr.trim())console.log('GTK_QA_DIAGNOSTIC',stderr.trim().slice(0,140));
}
