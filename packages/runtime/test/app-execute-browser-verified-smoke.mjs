// Explicit localhost-only ASUS Chrome QA: real guarded app_execute plus durable UUID journal.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {appExecute} from '../src/extended/app-execute.mjs';
import {createAppExecuteJournal} from '../src/extended/app-execute-journal.mjs';
import {browserTabs,browserEvaluate,browserSnapshot,browserWait} from '../src/extended/browser.mjs';

process.env.NODE_ENV='test';
process.env.REMCP_BROWSER_REMOTE_ENABLED='1';
process.env.REMCP_BROWSER_ALLOW_LOCAL_NAVIGATION='1';
const home=mkdtempSync(path.join(os.tmpdir(),'remcp-codex-app-e2e-'));
const html="<!doctype html><html><meta charset=\"utf-8\"><title>ReMCP verified Computer Use QA</title>\n<style>body{font:18px system-ui;max-width:600px;margin:40px auto}input{padding:8px;margin:6px}label{display:inline-block;width:100px}</style>\n<h1>Verified Computer Use</h1><form>\n<label for=\"name\">Company</label><input id=\"name\" value=\"before\">\n<label for=\"email\">Email</label><input id=\"email\" type=\"email\" value=\"old@example.invalid\">\n<label for=\"agree\">Agree</label><input id=\"agree\" type=\"checkbox\">\n<label for=\"reactive\">Reactive</label><input id=\"reactive\" value=\"before\">\n<button type=\"submit\">Submit</button></form><script>\nwindow.__changes=0;window.__submits=0;\ndocument.querySelector('form').addEventListener('submit',e=>{e.preventDefault();__submits++});\nfor(const node of document.querySelectorAll('input'))node.addEventListener('input',()=>__changes++);\ndocument.querySelector('#reactive').addEventListener('change',e=>{\nqueueMicrotask(()=>{e.target.value='before'});\n});</script></html>";
const server=createServer((req,res)=>{
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 res.end(html);
});
let chrome;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const pageOrigin='http://127.0.0.1:'+server.address().port;
 const chromeBinary=process.env.REMCP_TEST_CHROME||'/usr/bin/google-chrome';
 if(!existsSync(chromeBinary))throw Error('Chrome binary unavailable');
 chrome=spawn(chromeBinary,['--headless=new','--disable-gpu',
 '--disable-background-networking','--no-first-run','--no-default-browser-check',
 '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
 '--user-data-dir='+path.join(home,'chrome'),
 pageOrigin+'/'],{stdio:'ignore'});
 let endpoint;
 for(let i=0;i<130;i++){
   const active=path.join(home,'chrome','DevToolsActivePort');
   if(existsSync(active)){
     const port=Number(readFileSync(active,'utf8').split('\n')[0]);
     if(Number.isInteger(port)&&port>0){endpoint='http://127.0.0.1:'+port;break;}
   }
   await sleep(100);
 }
 assert.ok(endpoint,'isolated Chromium CDP endpoint must start');
 let target;
 for(let i=0;i<120;i++){
  let tabs=[];
  try{tabs=(await browserTabs({endpoint})).structuredContent?.data||[];}
  catch(error){
    if(!/CDP endpoint is unavailable|connection refused|ECONNREFUSED/i.test(String(error)))
      throw error;
  }
  target=tabs.find(x=>x.url.startsWith(pageOrigin));
  if(target)break;
  await sleep(100);
 }
 assert.ok(target,'exact local QA browser page must exist');
 const ready=(await browserWait({endpoint,target_id:target.id,
   condition:'selector',selector:'#name',timeout_ms:5000})).structuredContent;
 assert.equal(ready.matched,true,'form must be rendered before readback');
 const operationJournal=createAppExecuteJournal({directory:path.join(home,'journal'),maxEntries:12});
 const adapters={operationJournal};
 const state=async()=>{
  const result=(await browserEvaluate({endpoint,target_id:target.id,
    expression:"({name:document.querySelector('#name').value,email:document.querySelector('#email').value,agree:document.querySelector('#agree').checked,reactive:document.querySelector('#reactive').value,submits:__submits,changes:__changes})"})).structuredContent.value;
  return result;
 };
 const basic={mode:'browser_form',origin:pageOrigin,target_id:target.id,endpoint,
   fields:[{label:'Company',expected_value:'before',value:'Safe QA'},
     {selector:'#email',expected_value:'old@example.invalid',value:'qa@invalid.test'},
     {label:'Agree',expected_value:false,value:true}]};
 const preview=(await appExecute({...basic,dry_run:true},adapters)).structuredContent;
 assert.equal(preview.status,'planned');
 assert.equal((await state()).changes,0);
 console.log('PREVIEW_CONFIRMED_NO_MUTATION');
 const id=randomUUID();
 const first=(await appExecute({...basic,commit:true,operation_id:id},adapters)).structuredContent;
 assert.equal(first.status,'completed');assert.equal(first.verified,true);
 assert.equal(first.submitted,false);
 let now=await state();
 assert.equal(now.name,'Safe QA');assert.equal(now.email,'qa@invalid.test');
 assert.equal(now.agree,true);assert.equal(now.submits,0);assert.equal(now.changes,3);
 console.log('APP_EXECUTE_REAL_FORM_VERIFIED',JSON.stringify({filled:first.field_count,changes:now.changes,submits:now.submits}));
 const replay=(await appExecute({...basic,commit:true,operation_id:id},adapters)).structuredContent;
 assert.equal(replay.replayed,true);assert.equal((await state()).changes,3);
 console.log('DURABLE_UUID_REPLAY_NO_DUPLICATE_ACTION');
 const reactive={...basic,fields:[{selector:'#reactive',expected_value:'before',value:'should-revert'}]};
 const badid=randomUUID();
 const bad=(await appExecute({...reactive,commit:true,operation_id:badid},adapters)).structuredContent;
 assert.equal(bad.status,'outcome_unknown');assert.equal(bad.verified,false);
 now=await state();assert.equal(now.reactive,'before');assert.equal(now.changes,4);
 const cached=(await appExecute({...reactive,commit:true,operation_id:badid},adapters)).structuredContent;
 assert.equal(cached.replayed,true);assert.equal((await state()).changes,4);
 assert.equal(now.submits,0);
 console.log('ASYNC_REACTIVE_MISMATCH_UNKNOWN_AND_NO_RETRY');
 const screenshot=(await browserSnapshot({endpoint,target_id:target.id,max_nodes:70,include_screenshot:true}));
 const pic=screenshot.content?.find(x=>x.type==='image');
 assert.equal(pic?.mimeType,'image/png');assert.ok(pic.data?.length>500);
 const screenshotBytes=Buffer.from(pic.data,'base64');
 if(process.env.REMCP_TEST_SCREENSHOT)
   writeFileSync(process.env.REMCP_TEST_SCREENSHOT,screenshotBytes,{flag:'wx',mode:0o600});
 console.log('SCREENSHOT_CONFIRMED_BYTES',screenshotBytes.length);
 console.log('APP_ENGINE_BROWSER_E2E_OK');
}finally{
 if(chrome&&chrome.exitCode===null&&chrome.signalCode===null){
   const closed=new Promise(resolve=>chrome.once('close',resolve));
   chrome.kill('SIGTERM');
   await Promise.race([closed,sleep(2500)]);
 }
 await new Promise(resolve=>server.close(resolve));
 rmSync(home,{force:true,recursive:true,maxRetries:8,retryDelay:180});
}
