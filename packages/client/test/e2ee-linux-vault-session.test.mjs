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

test('Linux vault retains a supplied user-session bus and does not inspect a fallback',async()=>{
  const supplied={HOME:'/home/a',DBUS_SESSION_BUS_ADDRESS:'unix:path=/custom/bus'};
  const result=await linuxSecretServiceEnvironment({environment:supplied,uid:owner,lstat:()=>{throw new Error('must not run');}});
  assert.equal(result,supplied);
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
