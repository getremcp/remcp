// ASUS: node runtime/test/app-task-browser-smoke.mjs
// Static, offline Chrome fixture tests Telegram post discovery without a
// Telegram account, network, screenshot dependency or message mutation.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PAGE_TELEGRAM_POST_READ} from '../src/extended/app-task-telegram.mjs';

const chrome=process.env.REMCP_TEST_CHROME||'/usr/bin/google-chrome';
if(!existsSync(chrome))throw Error('Installed Chrome required for isolated Telegram DOM QA');
const dir=mkdtempSync(path.join(tmpdir(),'remcp-app-task-telegram-'));
try{
  const html=`<!doctype html><html><meta charset="utf-8"><title>ReMCP Telegram App Task fixture</title>
  <style>body{font:18px system-ui;background:#131925;color:#eff4ff;margin:56px auto;max-width:850px}
  .bubble{background:#273b4a;border-radius:16px;padding:20px;margin:20px 0}
  a{color:#abd9ef}pre{white-space:pre-wrap}</style>
  <h1>Telegram Web post inspection — isolated fixture</h1>
  <article class="bubble" data-mid="123"><div class="message-text">First post &amp; links</div>
  <a href="https://t.me/examplechannel/123">View original post</a></article>
  <article class="bubble" data-mid="999"><div class="message-text">Other post</div>
  <a href="https://t.me/examplechannel/999">View other post</a></article>
  <pre id="result"></pre>
  <script>
  const read=(new Function('location','return ('+${JSON.stringify(PAGE_TELEGRAM_POST_READ)}+')'))({
    protocol:'https:',hostname:'web.telegram.org',username:'',password:'',port:''
  });
  let clicks=0,sends=0;
  for(const link of document.querySelectorAll('a'))link.addEventListener('click',()=>clicks++);
  const match=read({url:'https://t.me/examplechannel/123'});
  const missing=read({url:'https://t.me/examplechannel/124'});
  const impostor=read({url:'https://t.me/examplechannel/12'});
  const summary={found:match.status==='located',text:match.current_text,
    own_post_verified:match.own_post_verified,can_edit:match.can_edit,
    missing:missing.reason,impostor:impostor.reason,
    clicks,sends,verified_origin_only:true};
  document.getElementById('result').textContent=JSON.stringify(summary);
  </script></html>`;
  const fixture=path.join(dir,'telegram-fixture.html');
  const capture=path.join(dir,'telegram-qa.png');
  writeFileSync(fixture,html,{mode:0o600});
  const flags=['--headless=new','--disable-gpu','--disable-dev-shm-usage',
    '--disable-background-networking','--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--user-data-dir='+path.join(dir,'chrome-user'),
    '--window-size=1080,730','--virtual-time-budget=1600',
    '--screenshot='+capture,'--dump-dom','file://'+fixture];
  const run=spawnSync(chrome,flags,{encoding:'utf8',timeout:20000,maxBuffer:3*1024*1024});
  if(run.error||run.status!==0)throw Error('Chrome fixture failed: '+String(run.error||run.stderr).slice(0,240));
  const encoded=run.stdout.split('<pre id="result">')[1]?.split('</pre>')[0];
  if(!encoded)throw Error('Local fixture did not produce report');
  const actual=JSON.parse(encoded.replaceAll('&quot;','"').replaceAll('&amp;','&'));
  assert.deepEqual(actual,{found:true,text:'First post & links',
    own_post_verified:false,can_edit:false,
    missing:'post_not_visible_in_tab',impostor:'post_not_visible_in_tab',
    clicks:0,sends:0,verified_origin_only:true});
  console.log(JSON.stringify({status:'passed',test:'telegram-post-read-only',
    browser:'headless Chrome',offline:true,screenshot_bytes:readFileSync(capture).length,
    ...actual},null,2));
} finally {
  // No user Telegram profile, account, or page was accessed.
  rmSync(dir,{recursive:true,force:true});
}
