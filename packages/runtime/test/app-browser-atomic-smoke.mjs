// Explicit local-only Chrome browser smoke. Not a production account or real email.
// Run on ASUS: node runtime/test/app-browser-atomic-smoke.mjs
// Uses a throwaway file:// HTML fixture, isolated Chrome profile, no network.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PAGE_GUIDED_STEP} from '../src/extended/app-workflow-browser-step.mjs';
import {guidedStepPolicy} from '../src/extended/app-workflow-step-policy.mjs';

const chrome=process.env.REMCP_TEST_CHROME || '/usr/bin/google-chrome';
if(!existsSync(chrome))throw new Error('Local browser smoke needs installed Chrome; it never installs browsers');
const root=mkdtempSync(path.join(tmpdir(),'remcp-atomic-browser-'));
try{
  const file=path.join(root,'fixture.html');
  const screenshot=path.join(root,'fixture.png');
  // Deliberately supply a fake URL object to the source-owned step in a
  // browser page loaded exclusively from disk. Domain matching against real
  // CDP targets is tested separately. No Google account is accessed.
  const html=`<!DOCTYPE html><html lang="en"><meta charset="utf-8">
<title>ReMCP local App Engine QA</title>
<style>body{font:18px system-ui;max-width:680px;margin:80px auto;background:#121820;color:#f1f5f9}
input{padding:15px;font-size:20px;width:90%;border-radius:10px}
pre{white-space:pre-wrap;color:#a7e3ae}</style>
<h1>ReMCP safe search — local fixture</h1>
<label for="q">Search in mail</label>
<input id="q" type="search" role="searchbox" aria-label="Search in mail" autocomplete="off">
<button type="submit" aria-label="Send">Send (must not click)</button>
<pre id="result"></pre>
<script>
  const pageStep=(new Function('location','return ('+${JSON.stringify(PAGE_GUIDED_STEP)}+')'))({
    protocol:'https:',hostname:'mail.google.com',username:'',password:'',port:''
  });
  const field=document.querySelector('#q');
  let events=0,sends=0;
  field.addEventListener('input',()=>events++);
  document.querySelector('button').addEventListener('click',()=>sends++);
  const policy=${JSON.stringify(guidedStepPolicy('find_email','set_search_query'))};
  const payload='invoice Z-42 🧾';
  const response=pageStep('mail.google.com',policy,payload);
  const report={dispatched:response.dispatched,readback:response.readback_confirmed,
    events,sends,query_matches:field.value===payload,
    active_field:document.activeElement===field,secret_echo:JSON.stringify(response).includes(payload)};
  document.querySelector('#result').textContent=JSON.stringify(report);
</script></html>`;
  writeFileSync(file,html,{mode:0o600});
  const args=['--headless=new','--disable-gpu','--disable-dev-shm-usage',
    '--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--host-resolver-rules=MAP * ~NOTFOUND','--user-data-dir='+path.join(root,'profile'),
    '--window-size=1080,700','--virtual-time-budget=1500','--screenshot='+screenshot,
    '--dump-dom','file://'+file];
  const proc=spawnSync(chrome,args,{encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024});
  if(proc.error||proc.status!==0)throw new Error('Chrome local fixture failed: '+String(proc.error||proc.stderr).slice(0,300));
  const report=proc.stdout.split('<pre id="result">')[1]?.split('</pre>')[0];
  if(!report)throw new Error('Chrome local fixture returned no read-back result: '+proc.stdout.slice(-300));
  const qa=JSON.parse(report.replaceAll('&quot;','"').replaceAll('&amp;','&'));
  assert.deepEqual(qa,{dispatched:true,readback:true,events:1,sends:0,
    query_matches:true,active_field:true,secret_echo:false});
  console.log(JSON.stringify({status:'passed',browser:'Chrome headless',local_fixture:true,
    screenshot_bytes:existsSync(screenshot)?readFileSync(screenshot).length:0,...qa},null,2));
}finally{
  // QA screenshots are temporary and contain no personal data.
  rmSync(root,{recursive:true,force:true});
}
