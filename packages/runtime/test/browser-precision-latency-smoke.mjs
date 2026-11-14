// Opt-in Chromium E2E: exact CSS targets, no wrong clicks or accidental uploads.
// Runs only against a disposable localhost page and isolated Chrome profile.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {browserAction} from '../src/extended/browser-actions.mjs';
import {browserTabs,browserEvaluate,browserSnapshot} from '../src/extended/browser.mjs';

process.env.NODE_ENV='test';
process.env.REMCP_BROWSER_REMOTE_ENABLED='1';
process.env.REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION='1';
const home=mkdtempSync(path.join(tmpdir(),'remcp-precision-e2e-'));
const page=`<!doctype html><html><meta charset="utf-8"><title>ReMCP precision CDP QA</title>
<style>body{background:#131925;color:#f2f5fa;font:20px system-ui;margin:45px auto;max-width:700px}
button,input{padding:14px;border-radius:9px;margin:10px;font-size:17px}
#safe{background:#b5e2d1}h1{font-size:30px}#hover-overlay{display:none;position:fixed;z-index:99999;background:#eb9c9c}#swap-target{width:250px;height:56px;display:block;margin-top:48px}#workflow-swap-target{width:270px;height:56px;display:block;margin-top:22px}#spoof-target{position:fixed;left:12px;top:350px;z-index:3;width:230px;height:56px;display:block}#text-spoof-target{position:fixed;left:310px;top:350px;z-index:4;width:300px;height:56px;display:block}</style><h1>ReMCP — exact selection</h1>
<button class="duplicate" type="button">Ambiguous one</button>
<button class="duplicate" type="button">Ambiguous two</button><hr>
<button id="safe" type="button">Unique safe control</button>
<button id="text-safe" type="button">Open exact panel</button>
<button id="text-fuzzy" type="button">Open exact panel advanced</button>
<button class="text-duplicate" type="button">Repeated option</button>
<button class="text-duplicate" type="button">Repeated option</button>
<input type="file" class="upload"><input type="file" class="upload"><hr>
<button id="hover-trap" type="button">Safe hover target</button>
<button id="hover-overlay" type="button">Overlapping dangerous target</button>
<button id="swap-target" type="button">Safe stable identity</button>
<button id="workflow-swap-target" type="button">Safe workflow identity</button>
<button id="spoof-target" type="button">Safe page-owned proof</button>
<button id="text-spoof-target" type="button">Safe text-owned proof</button>
<p id="status">Ready for verified click</p><script>
window.__wrongClicks=0;window.__safeClicks=0;
window.__textClicks=0;window.__fuzzyClicks=0;
window.__hoverWrong=0;window.__hoverSafe=0;
window.__swapWrong=0;window.__swapSafe=0;window.__workflowSwapWrong=0;
window.__spoofWrong=0;window.__spoofStolen=false;window.__spoofHover=0;
window.__textSpoofWrong=0;window.__textSpoofStolen=false;window.__textSpoofHover=0;
const original=document.querySelector('#swap-target');
original.addEventListener('mouseenter',()=>{
 const replacement=document.createElement('button');
 replacement.id='swap-target';
 replacement.type='button';
 replacement.textContent='Dangerous swapped identity';
 replacement.onclick=()=>__swapWrong++;
 original.replaceWith(replacement);
});
original.onclick=()=>__swapSafe++;
const workflowOriginal=document.querySelector('#workflow-swap-target');
workflowOriginal.addEventListener('mouseenter',()=>{
 const replacement=document.createElement('button');
 replacement.id='workflow-swap-target';
 replacement.textContent='Dangerous workflow replacement';
 replacement.onclick=()=>__workflowSwapWrong++;
 workflowOriginal.replaceWith(replacement);
});
// This page is hostile: it replaces the node AND forges the private expando.
// The earlier DOM-only proof would accept this same-ID replacement.
const spoofOriginal=document.querySelector('#spoof-target');
spoofOriginal.addEventListener('mouseenter',()=>{
 __spoofHover++;
 const stolen=Object.getOwnPropertyNames(document).find(name=>name.startsWith('__remcp_pointer_'));
 const replacement=document.createElement('button');
 replacement.id='spoof-target';replacement.type='button';
 replacement.textContent='Forged proof / dangerous action';
 replacement.onclick=()=>__spoofWrong++;
 spoofOriginal.replaceWith(replacement);
 if(stolen){
  Object.defineProperty(document,stolen,{value:replacement,configurable:true,enumerable:false});
  __spoofStolen=true;
 }
});
// Text-only selection must not trust a writable expando either.
const textSpoofOriginal=document.querySelector('#text-spoof-target');
textSpoofOriginal.addEventListener('mouseenter',()=>{
 __textSpoofHover++;
 const stolen=Object.getOwnPropertyNames(document).find(name=>name.startsWith('__remcp_pointer_'));
 const replacement=document.createElement('button');
 replacement.id='text-spoof-target';replacement.type='button';
 replacement.textContent='Safe text-owned proof';
 replacement.onclick=()=>__textSpoofWrong++;
 textSpoofOriginal.replaceWith(replacement);
 if(stolen){
  Object.defineProperty(document,stolen,{value:replacement,configurable:true,enumerable:false});
  __textSpoofStolen=true;
 }
});
const trap=document.querySelector('#hover-trap');
const overlay=document.querySelector('#hover-overlay');
trap.addEventListener('mouseenter',()=>{
 const r=trap.getBoundingClientRect();
 overlay.style.left=(r.left+r.width/2-20)+'px';
 overlay.style.top=(r.top+r.height/2-10)+'px';
 overlay.style.display='block';
});
trap.onclick=()=>__hoverSafe++;
overlay.onclick=()=>__hoverWrong++;
document.querySelector('#text-safe').onclick=()=>__textClicks++;
document.querySelector('#text-fuzzy').onclick=()=>__fuzzyClicks++;
for(const b of document.querySelectorAll('.text-duplicate'))
 b.onclick=()=>__wrongClicks++;
for(const b of document.querySelectorAll('.duplicate'))
 b.onclick=()=>{__wrongClicks++;document.querySelector('#status').textContent='WRONG CLICK'};
document.querySelector('#safe').onclick=()=>{__safeClicks++;
 document.querySelector('#status').textContent='SAFE CLICKED'};
</script></html>`;
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(page)});
let chrome;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const binary=process.env.REMCP_TEST_CHROME||'/usr/bin/google-chrome';
 assert.ok(existsSync(binary),'Chrome must be installed before running QA');
 chrome=spawn(binary,['--headless=new','--disable-gpu','--disable-background-networking',
  '--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0','--user-data-dir='+path.join(home,'chrome'),origin+'/'],{stdio:'ignore'});
 let endpoint;
 for(let n=0;n<130;n++){
  const portFile=path.join(home,'chrome','DevToolsActivePort');
  if(existsSync(portFile)){
   const port=Number(readFileSync(portFile,'utf8').split('\n')[0]);
   if(port>0){endpoint='http://127.0.0.1:'+port;break;}
  }
  await sleep(100);
 }
 assert.ok(endpoint,'isolated Chrome CDP must be running');
 let target;
 for(let n=0;n<100;n++){
  let tabs=[];
  try{tabs=(await browserTabs({endpoint})).structuredContent?.data||[];}
  catch(error){
   // macOS Chrome can expose DevToolsActivePort before /json/list is ready.
   // Retry only that transient cold-start error; no GUI action was sent.
   if(!/CDP endpoint is unavailable|connection refused|ECONNREFUSED/i.test(String(error)))
    throw error;
  }
  target=tabs.find(tab=>tab.url.startsWith(origin));
  if(target)break;
  await sleep(100);
 }
 assert.ok(target,'exact localhost browser target missing');
 const args={endpoint,target_id:target.id};
 // Chrome can advertise the destination in /json/list while its JS context
 // still reports about:blank. Check the live URL and fixture readiness without
 // dispatching any action; never classify missing markup as an ambiguous UI.
 let ready=false;
 for(let attempt=0;attempt<100;attempt++){
  try{
   const state=(await browserEvaluate({...args,expression:
    '({url:location.href,loaded:document.readyState==="complete",ready:!!document.querySelector("#safe")&&typeof window.__safeClicks==="number"})'})).structuredContent.value;
   if(new URL(state.url).origin===origin && state.loaded && state.ready){
    ready=true;
    break;
   }
  }catch(error){
   if(!/target origin changed before action|execution context (was destroyed|not found)/i.test(String(error)))
    throw error;
  }
  await sleep(100);
 }
 assert.ok(ready,'isolated localhost page must finish loading before selector QA');
 await assert.rejects(browserAction({...args,action:'click',selector:'.duplicate'}),
  /selector missing or ambiguous/);
 await assert.rejects(browserAction({...args,action:'click',text:'Repeated option'}),
  /Text locator is ambiguous/);
 await assert.rejects(browserAction({...args,action:'click',text:'ReMCP — exact selection'}),
  /Text locator needs an exact visible interactive element/);
 const textClick=(await browserAction({...args,action:'click',text:'Open exact panel'})).structuredContent;
 assert.equal(textClick.action,'click');
 const initial=(await browserEvaluate({...args,expression:
  '({wrong:__wrongClicks,safe:__safeClicks})'})).structuredContent.value;
 assert.deepEqual(initial,{wrong:0,safe:0});
 const upload=path.join(home,'qa.txt');writeFileSync(upload,'reMCP isolated upload fixture');
 await assert.rejects(browserAction({...args,action:'upload',selector:'.upload',path:upload}),
  /File upload selector missing or ambiguous/);
 const t0=performance.now();
 const result=(await browserAction({...args,action:'workflow',steps:[
  {action:'wait_for',condition:'selector',selector:'#safe',timeout_ms:2000},
  {action:'click',selector:'#safe'},
  {action:'wait_for',condition:'text',text:'SAFE CLICKED',timeout_ms:2000},
 ]})).structuredContent.result;
 const elapsed=Math.round((performance.now()-t0)*10)/10;
 assert.equal(result.completed,3);
 const state=(await browserEvaluate({...args,expression:
  '({wrong:__wrongClicks,safe:__safeClicks,text:__textClicks,fuzzy:__fuzzyClicks,selectedFiles:document.querySelectorAll("input[type=file]")[0].files.length})'})).structuredContent.value;
 assert.deepEqual(state,{wrong:0,safe:1,text:1,fuzzy:0,selectedFiles:0});
 // Moving onto this control spawns a competing overlay before mousePressed.
 // No click may land on the overlay or proceed without rechecking the target.
 await assert.rejects(browserAction({...args,action:'click',selector:'#hover-trap'}),
  /hover|obstruct|target.*changed|pointer|covered/i);
 const hover=(await browserEvaluate({...args,expression:'({wrong:__hoverWrong,safe:__hoverSafe})'})).structuredContent.value;
 assert.deepEqual(hover,{wrong:0,safe:0},'hover-replaced target cannot receive any click');
 // Replacing the selected DOM node with a different button using the same
 // unique ID before mousePressed must never be accepted as the original.
 await assert.rejects(browserAction({...args,action:'click',selector:'#swap-target'}),
  /identity|changed|replaced|hover|pointer|obstruct|target/i);
 const swapped=(await browserEvaluate({...args,expression:
  '({wrong:__swapWrong,safe:__swapSafe})'})).structuredContent.value;
 assert.deepEqual(swapped,{wrong:0,safe:0},'new same-ID control must not inherit the original click');
 await assert.rejects(browserAction({...args,action:'workflow',steps:[
  {action:'click',selector:'#workflow-swap-target'},
 ]}),/Browser workflow stopped at step 1/);
 const workflowSwap=(await browserEvaluate({...args,expression:'__workflowSwapWrong'})).structuredContent.value;
 assert.equal(workflowSwap,0,'workflow must not click a new element with the original selector');
 // Hostile JS can overwrite its own document expando after hover. Native
 // CDP DOM.querySelector NodeId must still reject the swapped control.
 await assert.rejects(browserAction({...args,action:'click',selector:'#spoof-target'}),
  /CDP selector target changed after hover/);
 const spoof=(await browserEvaluate({...args,expression:
  '({stolen:__spoofStolen,wrong:__spoofWrong,hover:__spoofHover})'})).structuredContent.value;
 assert.deepEqual(spoof,{stolen:true,wrong:0,hover:1},
  'page-owned proof was forged but independent CDP identity must reject');
 await assert.rejects(browserAction({...args,action:'click',text:'Safe text-owned proof'}),
  /CDP text target changed after hover/);
 const textSpoof=(await browserEvaluate({...args,expression:
  '({stolen:__textSpoofStolen,wrong:__textSpoofWrong,hover:__textSpoofHover})'})).structuredContent.value;
 assert.deepEqual(textSpoof,{stolen:true,wrong:0,hover:1},
  'forged text locator proof must not bypass native node identity');
 const screenshot=await browserSnapshot({...args,max_nodes:60,include_screenshot:true});
 const image=screenshot.content?.find(part=>part.type==='image'&&part.mimeType==='image/png');
 assert.ok(image?.data?.length>500);
 const bytes=Buffer.from(image.data,'base64');
 if(process.env.REMCP_TEST_SCREENSHOT)
  writeFileSync(process.env.REMCP_TEST_SCREENSHOT,bytes,{flag:'wx',mode:0o600});
 console.log(JSON.stringify({result:'passed',real_chromium:true,
  wrong_clicks:state.wrong,safe_clicks:state.safe,text_clicks:state.text,
  fuzzy_clicks:state.fuzzy,uploaded_files:state.selectedFiles,
  workflow_steps:result.completed,workflow_elapsed_ms:elapsed,
  screenshot_bytes:bytes.length}));
}finally{
 if(chrome?.exitCode===null&&chrome?.signalCode===null){
  const closed=new Promise(resolve=>chrome.once('close',resolve));
  chrome.kill('SIGTERM');await Promise.race([closed,sleep(2500)]);
 }
 await new Promise(resolve=>server.close(resolve));
 rmSync(home,{recursive:true,force:true,maxRetries:8,retryDelay:180});
}
