import test from 'node:test';
import assert from 'node:assert/strict';
import { productionBrowserSessions } from '../src/extended/browser-endpoint.mjs';
import { findGuardedCachedTarget } from '../src/extended/browser-session.mjs';

test('reuses only an exact guarded same-endpoint target without additional selectors', t => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { process.env.NODE_ENV = before; productionBrowserSessions.clear(); });
  const endpoint = new URL('http://127.0.0.1:9222');
  const target = { id:'page-17', title:'Old', url:'https://example.test',
    webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/page-17' };
  const session = {url:target.webSocketDebuggerUrl,closed:false,socket:{readyState:1}};
  const record = {target,targetId:target.id,session,removeGuard:() => {},guardInstalled:true};
  productionBrowserSessions.set('http://127.0.0.1:9222|page-17',record);
  assert.equal(findGuardedCachedTarget({target_id:'page-17'},endpoint)?.target,target);
  assert.equal(findGuardedCachedTarget({target_id:'page-17',title:'Another'},endpoint),null);
  assert.equal(findGuardedCachedTarget({target_id:'page-17',url_contains:'else'},endpoint),null);
  assert.equal(findGuardedCachedTarget({target_id:'page-18'},endpoint),null);
  assert.equal(findGuardedCachedTarget({target_id:'page-17'},new URL('http://127.0.0.1:9333')),null);
  assert.equal(findGuardedCachedTarget({title:'Old'},endpoint),null);
  session.closed=true;
  assert.equal(findGuardedCachedTarget({target_id:'page-17'},endpoint),null);
  session.closed=false;
  session.socket.readyState=3;
  assert.equal(findGuardedCachedTarget({target_id:'page-17'},endpoint),null);
  session.socket.readyState=1;
  record.guardInstalled=false;
  assert.equal(findGuardedCachedTarget({target_id:'page-17'},endpoint),null);
});

test('no cached fast path outside production, or with unvalidated target metadata', t => {
  const before = process.env.NODE_ENV;
  const endpoint=new URL('http://127.0.0.1:9222');
  const key='http://127.0.0.1:9222|page-18';
  const record={targetId:'page-18',target:{id:'page-18',webSocketDebuggerUrl:'ws://127.0.0.1:9999/devtools/page/page-18'},session:{closed:false,socket:{readyState:1}},guardInstalled:true};
  productionBrowserSessions.set(key,record);
  t.after(()=>{if(before===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=before; productionBrowserSessions.clear();});
  process.env.NODE_ENV='test';
  assert.equal(findGuardedCachedTarget({target_id:'page-18'},endpoint),null);
  process.env.NODE_ENV='production';
  assert.equal(findGuardedCachedTarget({target_id:'page-18'},endpoint),null);
});
