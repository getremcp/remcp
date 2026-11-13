import test from 'node:test';
import assert from 'node:assert/strict';
import {issueControlValueToken,verifyControlValueToken}
  from '../src/extended/app-control-value-token.mjs';

const subject={app:'local-00112233445566778899',pid:321,
  window_id:'win-1',control_id:'linux:321:r.0',name:'Search',
  role:'entry',text:'private existing value'};
const nowMs=1_800_000_000_000;
test('short-lived HMAC does not disclose the old field value',()=>{
  const token=issueControlValueToken(subject,{nowMs});
  assert.match(token,/^av1\.\d{10}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(token.includes(subject.text),false);
  assert.equal(verifyControlValueToken(token,subject,{nowMs:nowMs+30_000}),true);
});
test('value attestation expires after 90s and refuses a future timestamp',()=>{
  const token=issueControlValueToken(subject,{nowMs});
  assert.equal(verifyControlValueToken(token,subject,{nowMs:nowMs+91_000}),false);
  assert.equal(verifyControlValueToken(token,subject,{nowMs:nowMs-6_000}),false);
});
test('token is bound to app, PID, window, control identity and old value',()=>{
  const token=issueControlValueToken(subject,{nowMs});
  for(const [field,v] of Object.entries({app:'local-ffffffffffffffffffff',
    pid:322,window_id:'other',control_id:'different',
    name:'Another',role:'textbox',text:'changed'})){
    assert.equal(verifyControlValueToken(token,{...subject,[field]:v},{nowMs}),false,field);
  }
});
test('altered, malformed or missing field tokens fail safely',()=>{
  const token=issueControlValueToken(subject,{nowMs});
  const bad=[null,'',token.slice(0,-1)+'!',token.replace(/^av1/,'av2'),
    token.replace(/\d{10}/,'1000000000')];
  for(const item of bad)assert.equal(verifyControlValueToken(item,subject,{nowMs}),false);
});

test('noncanonical base64url re-encoding is refused even when bytes match',()=>{
  const token=issueControlValueToken(subject,{nowMs});
  const parts=token.split('.');
  const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const i=abc.indexOf(parts[2].at(-1));
  assert.equal(i%4,0);
  const alternate=parts[0]+'.'+parts[1]+'.'+parts[2].slice(0,-1)+abc[i+1];
  assert.equal(Buffer.from(parts[2],'base64url').equals(Buffer.from(alternate.split('.')[2],'base64url')),true);
  assert.equal(verifyControlValueToken(alternate,subject,{nowMs}),false);
});
