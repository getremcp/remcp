import test from 'node:test';
import assert from 'node:assert/strict';
import {linuxSecretServiceEnvironment} from '../src/cli/e2ee-vault.mjs';

const owner=1000;
const secureDir={uid:owner,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false};
const socket={uid:owner,mode:0o140666,isSocket:()=>true,isSymbolicLink:()=>false};
const lookup=async path=>{
  if(path==='/run/user/1000')return secureDir;
  if(path==='/run/user/1000/bus')return socket;
  throw new Error('not found');
};

test('Linux stdio client recovers only the owner session bus when SDK removes D-Bus variables',async()=>{
  const env=await linuxSecretServiceEnvironment({environment:{HOME:'/home/anton',PATH:'/usr/bin'},uid:owner,lstat:lookup});
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS,'unix:path=/run/user/1000/bus');
  assert.equal(env.XDG_RUNTIME_DIR,'/run/user/1000');
  assert.equal(env.HOME,'/home/anton');
});

test('Linux vault validates even a pre-supplied owner session bus',async()=>{
  const supplied={HOME:'/home/a',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'};
  const result=await linuxSecretServiceEnvironment({environment:supplied,uid:owner,lstat:lookup});
  assert.equal(result,supplied);
});

test('Linux vault rejects supplied foreign, abstract, and alternate D-Bus addresses',async()=>{
  for(const address of [
    'unix:path=/run/user/2000/bus',
    'unix:path=/tmp/attacker-controlled/bus',
    'unix:abstract=/tmp/dbus-unverified',
    'tcp:host=127.0.0.1,port=1234',
    'unix:path=/run/user/1000/bus;unix:path=/tmp/other',
  ]){
    await assert.rejects(linuxSecretServiceEnvironment({
      environment:{DBUS_SESSION_BUS_ADDRESS:address},uid:owner,lstat:lookup,
    }),/OS vault unavailable/,address);
  }
});

test('Linux vault accepts a verified owner D-Bus socket in root-owned sticky /tmp',async()=>{
  const address='unix:path=/tmp/dbus-owner-qa,guid='+('a'.repeat(32));
  const env={DBUS_SESSION_BUS_ADDRESS:address};
  const stickyTmp={uid:0,mode:0o41777,isDirectory:()=>true,isSymbolicLink:()=>false};
  const result=await linuxSecretServiceEnvironment({
    environment:env,uid:owner,
    lstat:async name=>name==='/tmp'?stickyTmp:name==='/tmp/dbus-owner-qa'?socket:null,
  });
  assert.equal(result,env);
});

test('Linux vault rejects world-writable non-sticky or foreign socket directories',async()=>{
  const env={DBUS_SESSION_BUS_ADDRESS:'unix:path=/tmp/dbus-owner-qa'};
  for(const dir of [
    {uid:0,mode:0o40777,isDirectory:()=>true,isSymbolicLink:()=>false},
    {uid:2000,mode:0o40700,isDirectory:()=>true,isSymbolicLink:()=>false},
    {uid:owner,mode:0o40770,isDirectory:()=>true,isSymbolicLink:()=>false},
    {uid:0,mode:0o41777,isDirectory:()=>true,isSymbolicLink:()=>true},
  ]){
    await assert.rejects(linuxSecretServiceEnvironment({
      environment:env,uid:owner,lstat:async name=>name==='/tmp'?dir:socket,
    }),/OS vault unavailable/);
  }
});

test('Linux vault refuses a supplied canonical bus with invalid owner or socket',async()=>{
  for(const corrupt of [
    {dir:{...secureDir,uid:2000},sock:socket},
    {dir:secureDir,sock:{...socket,uid:2000}},
    {dir:secureDir,sock:{...socket,isSocket:()=>false}},
  ]){
    await assert.rejects(linuxSecretServiceEnvironment({
      environment:{DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},
      uid:owner,lstat:async name=>name.endsWith('/bus')?corrupt.sock:corrupt.dir,
    }),/OS vault unavailable/);
  }
});

test('Linux vault verifies the owner of both runtime directory and session socket',async()=>{
  for(const corrupt of [
    {dir:{...secureDir,uid:2000},sock:socket},
    {dir:{...secureDir,mode:0o40777},sock:socket},
    {dir:{...secureDir,isSymbolicLink:()=>true},sock:socket},
    {dir:secureDir,sock:{...socket,uid:2000}},
    {dir:secureDir,sock:{...socket,isSocket:()=>false}},
    {dir:secureDir,sock:{...socket,isSymbolicLink:()=>true}},
  ]){
    const fn=async path=>path.endsWith('/bus')?corrupt.sock:corrupt.dir;
    await assert.rejects(linuxSecretServiceEnvironment({environment:{},uid:owner,lstat:fn}),/OS vault unavailable/);
  }
});

test('Linux vault rejects relative runtime paths, invalid UIDs and missing session sockets',async()=>{
  await assert.rejects(linuxSecretServiceEnvironment({environment:{XDG_RUNTIME_DIR:'../../tmp'},uid:owner,lstat:lookup}),/OS vault unavailable/);
  await assert.rejects(linuxSecretServiceEnvironment({environment:{},uid:-1,lstat:lookup}),/OS vault unavailable/);
  await assert.rejects(linuxSecretServiceEnvironment({environment:{},uid:owner,lstat:async()=>{throw new Error('missing bus');}}),/OS vault unavailable/);
});
