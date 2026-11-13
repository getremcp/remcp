import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync,readFileSync,writeFileSync,symlinkSync,statSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createAppExecuteJournal} from '../src/extended/app-execute-journal.mjs';

function fixture(t,opts={}){
  const root=mkdtempSync(path.join(tmpdir(),'remcp-journal-check-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'state');
  const make=()=>createAppExecuteJournal({directory,maxEntries:opts.maxEntries||8});
  return {root,directory,make};
}
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const digest='a'.repeat(64);
const result={status:'completed',verified:true,executed:true,elapsed_ms:2.3};

test('durable journal reserves UUID before execution and rejects retry after simulated process crash',t=>{
 const {directory,make}=fixture(t);
 assert.deepEqual(make().begin(A,digest),{reserved:true});
 const another=make().begin(A,digest);
 assert.equal(another.replayed,true);
 assert.equal(another.result.status,'outcome_unknown');
 assert.equal(another.result.executed,null);
 const record=JSON.parse(readFileSync(path.join(directory,A+'.json'),'utf8'));
 assert.equal(record.status,'pending');
 assert.ok(!JSON.stringify(record).includes('password123'));
});

test('completed result survives a new journal instance without repeating an action',t=>{
 const {make}=fixture(t);
 assert.equal(make().begin(B,digest).reserved,true);
 make().complete(B,digest,result);
 const replay=make().begin(B,digest);
 assert.equal(replay.replayed,true);
 assert.deepEqual(replay.result,result);
 assert.throws(()=>make().begin(B,'another-fingerprint'),/reused/);
 assert.throws(()=>make().complete(B,digest,result),/already finalized/);
});

test('record permissions are private and symlink journal directory is rejected',t=>{
 const {directory,root,make}=fixture(t);
 make().begin(A,digest);
 if(process.platform!=='win32'){
   assert.equal(lstatSync(directory).mode&0o077,0);
   assert.equal(lstatSync(path.join(directory,A+'.json')).mode&0o077,0);
 }
 const alias=path.join(root,'alias');
 symlinkSync(directory,alias,process.platform==='win32'?'junction':'dir');
 const linked=createAppExecuteJournal({directory:alias});
 assert.throws(()=>linked.begin(B,digest),/Unsafe app execution journal directory/);
});

test('corrupt or replaced operation record blocks mutation, including after restart',t=>{
 const {directory,make}=fixture(t);
 make().begin(A,digest);
 writeFileSync(path.join(directory,A+'.json'),'{broken_json');
 assert.throws(()=>make().begin(A,digest),/Unexpected token|Expected property name|JSON/);
});

test('at capacity journal fails closed but still permits replay of existing IDs',t=>{
 const {make}=fixture(t,{maxEntries:1});
 assert.equal(make().begin(A,digest).reserved,true);
 assert.throws(()=>make().begin(B,digest),/journal is full/);
 assert.equal(make().begin(A,digest).replayed,true);
});

test('distinct Node processes cannot execute the same operation id after a crash',t=>{
 const {directory}=fixture(t);
 const moduleUrl=new URL('../src/extended/app-execute-journal.mjs',import.meta.url).href;
 const childCode=[
   'import {createAppExecuteJournal} from '+JSON.stringify(moduleUrl)+';',
   'const [directory,id,digest,op]=process.argv.slice(1);',
   'const journal=createAppExecuteJournal({directory});',
   'const item=op==="begin"?journal.begin(id,digest):journal.begin(id,digest);',
   'process.stdout.write(JSON.stringify(item));',
 ].join('\n');
 const run=()=>{
   const child=spawnSync(process.execPath,['--input-type=module','-e',childCode,directory,A,digest,'begin'],
     {encoding:'utf8',timeout:7000,maxBuffer:4096});
   assert.equal(child.status,0,child.stderr);
   return JSON.parse(child.stdout);
 };
 assert.deepEqual(run(),{reserved:true});
 assert.equal(run().result.status,'outcome_unknown','second process must not repeat an incomplete action');
 createAppExecuteJournal({directory}).complete(A,digest,result);
 assert.deepEqual(run().result,result,'completed result survives another process restart');
});
