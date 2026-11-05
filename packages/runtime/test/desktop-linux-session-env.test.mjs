import assert from 'node:assert/strict';
import test from 'node:test';
import {hydrateLinuxDesktopEnv} from '../src/extended/desktop-linux-session-env.mjs';

const managerEnv=[
  'DISPLAY=:0',
  'WAYLAND_DISPLAY=wayland-0',
  'XDG_SESSION_TYPE=wayland',
  'XDG_CURRENT_DESKTOP=ubuntu:GNOME',
  'PRIVATE_API_KEY=must-not-import',
].join('\n');
const base=()=>({DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',
  XDG_RUNTIME_DIR:'/run/user/1000'});
const socket={uid:1000,isSocket:()=>true};
const privateDir={uid:1000,mode:0o40700,isDirectory:()=>true};
const fake=(overrides={})=>({
  platform:'linux',uid:1000,env:base(),
  runFileFn:async()=>({code:0,stdout:managerEnv}),
  realpathFn:async path=>path,
  lstatFn:async path=>path==='/run/user/1000'?privateDir:socket,
  ...overrides,
});

test('managed GNOME Wayland service imports only verified current-user GUI env',async()=>{
  const env=base();
  const options=fake({env});
  const changed=await hydrateLinuxDesktopEnv(options);
  assert.equal(changed,true);
  assert.equal(env.DISPLAY,':0');
  assert.equal(env.WAYLAND_DISPLAY,'wayland-0');
  assert.equal(env.XDG_SESSION_TYPE,'wayland');
  assert.equal(env.XDG_CURRENT_DESKTOP,'ubuntu:GNOME');
  assert.equal(env.PRIVATE_API_KEY,undefined);
  assert.equal(await hydrateLinuxDesktopEnv(options),false);
});

test('do not replace existing graphical session or query on non-Linux',async()=>{
  for(const env of [{...base(),WAYLAND_DISPLAY:'already-running'},{...base(),DISPLAY:':1'}]){
    const changed=await hydrateLinuxDesktopEnv(fake({env,runFileFn:()=>{throw Error('unexpected manager call');}}));
    assert.equal(changed,false);
  }
  assert.equal(await hydrateLinuxDesktopEnv(fake({
    platform:'darwin',runFileFn:()=>{throw Error('unexpected');},
  })),false);
});

test('preserve explicitly selected X11 and TTY sessions without querying manager',async()=>{
  for(const type of ['x11','tty']){
    const env={...base(),XDG_SESSION_TYPE:type};
    let managerCalls=0;
    const changed=await hydrateLinuxDesktopEnv(fake({
      env,runFileFn:async()=>{
        managerCalls++;
        return {code:0,stdout:managerEnv};
      },
    }));
    assert.equal(managerCalls,0,'must not query manager for explicit '+type);
    assert.equal(changed,false);
    assert.equal(env.XDG_SESSION_TYPE,type);
    assert.equal(env.WAYLAND_DISPLAY,undefined);
  }
});

test('hydrate a declared Wayland session lacking its display socket name',async()=>{
  const env={...base(),XDG_SESSION_TYPE:'wayland'};
  assert.equal(await hydrateLinuxDesktopEnv(fake({env})),true);
  assert.equal(env.WAYLAND_DISPLAY,'wayland-0');
});

test('reject a user-manager socket that is not a same-user UNIX socket',async()=>{
  for(const invalid of [
    {uid:0,isSocket:()=>true},
    {uid:1000,isSocket:()=>false},
  ]){
    const env=base();
    const changed=await hydrateLinuxDesktopEnv(fake({
      env,lstatFn:async path=>path===env.XDG_RUNTIME_DIR?privateDir:invalid,
    }));
    assert.equal(changed,false);
    assert.equal(env.WAYLAND_DISPLAY,undefined);
  }
});

test('refuse traversal, manager errors and non-Wayland sessions',async()=>{
  const candidates=[
    managerEnv.replace('wayland-0','../other-socket'),
    managerEnv.replace('wayland-0','other/socket'),
    managerEnv.replace('XDG_SESSION_TYPE=wayland','XDG_SESSION_TYPE=tty'),
  ];
  for(const stdout of candidates){
    const env=base();
    const changed=await hydrateLinuxDesktopEnv(fake({
      env,runFileFn:async()=>({code:0,stdout}),
    }));
    assert.equal(changed,false);
    assert.equal(env.WAYLAND_DISPLAY,undefined);
  }
  const missing=base();
  assert.equal(await hydrateLinuxDesktopEnv(fake({
    env:missing,runFileFn:async()=>({code:1,stdout:''}),
  })),false);
  assert.equal(missing.WAYLAND_DISPLAY,undefined);
});

test('require verified user D-Bus and runtime directory before querying manager',async()=>{
  for(const env of [{XDG_RUNTIME_DIR:'/run/user/1000'},
    {DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'},{}]){
    assert.equal(await hydrateLinuxDesktopEnv(fake({
      env,runFileFn:()=>{throw Error('must not call systemctl');},
    })),false);
  }
});

function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

test('reject unsafe XDG runtime directory before trusting a same-user Wayland socket',async()=>{
  for(const runtime of [
    {uid:1000,mode:0o40777,isDirectory:()=>true},
    {uid:1001,mode:0o40700,isDirectory:()=>true},
    {uid:1000,mode:0o120777,isDirectory:()=>false}, // symlink
    {uid:1000,mode:0o40750,isDirectory:()=>true},
  ]){
    const env=base();
    const paths=[];
    const changed=await hydrateLinuxDesktopEnv(fake({
      env,lstatFn:async path=>{
        paths.push(path);
        return path===env.XDG_RUNTIME_DIR?runtime:socket;
      },
    }));
    assert.equal(changed,false,'untrusted runtime directory must fail closed');
    assert.equal(env.WAYLAND_DISPLAY,undefined);
    assert.equal(env.XDG_SESSION_TYPE,undefined);
  }
});

test('do not replace a GUI session established while the async manager query is pending',async()=>{
  const entered=deferred(),release=deferred(),env=base();
  const pending=hydrateLinuxDesktopEnv(fake({
    env,runFileFn:async()=>{
      entered.resolve();
      await release.promise;
      return {code:0,stdout:managerEnv};
    },
  }));
  await entered.promise;
  env.DISPLAY=':13';
  env.WAYLAND_DISPLAY='wayland-existing';
  env.XDG_SESSION_TYPE='wayland';
  release.resolve();
  assert.equal(await pending,false);
  assert.equal(env.DISPLAY,':13');
  assert.equal(env.WAYLAND_DISPLAY,'wayland-existing');
});

test('do not import a stale Wayland socket after session context switches during lstat',async()=>{
  for(const key of ['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XDG_SESSION_TYPE']){
    const entered=deferred(),release=deferred(),env=base();
    const pending=hydrateLinuxDesktopEnv(fake({
      env,lstatFn:async path=>{
        if(path===env.XDG_RUNTIME_DIR)return {
          uid:1000,mode:0o40700,isDirectory:()=>true,
        };
        entered.resolve();
        await release.promise;
        return socket;
      },
    }));
    await entered.promise;
    env[key]=key==='XDG_SESSION_TYPE'?'tty':env[key]+'-replacement';
    release.resolve();
    assert.equal(await pending,false,'changed '+key+' must fail closed');
    assert.equal(env.WAYLAND_DISPLAY,undefined,'must not import stale socket');
  }
});

test('reject a symlinked runtime directory even when trailing slash makes lstat follow it',async()=>{
  for(const runtimeDir of ['/run/user/alias/','/run/alias/1000']){
    const env={...base(),XDG_RUNTIME_DIR:runtimeDir};
    const touched=[];
    const result=await hydrateLinuxDesktopEnv(fake({
      env,
      realpathFn:async path=>{
        touched.push('realpath:'+path);
        return '/run/user/1000';
      },
      lstatFn:async path=>{
        touched.push('lstat:'+path);
        return path===runtimeDir?privateDir:socket;
      },
    }));
    assert.equal(result,false,'runtime path alias must fail closed');
    assert.equal(env.WAYLAND_DISPLAY,undefined,'no session imported via alias');
    assert.ok(touched.includes('realpath:'+runtimeDir),
      'resolve canonical runtime path before trusting it');
  }
});

test('reject runtime directory when canonical path cannot be verified',async()=>{
  const env=base();
  let socketReads=0;
  const result=await hydrateLinuxDesktopEnv(fake({
    env,
    realpathFn:async()=>{throw new Error('unresolvable directory');},
    lstatFn:async path=>{
      if(path!==env.XDG_RUNTIME_DIR)socketReads++;
      return path===env.XDG_RUNTIME_DIR?privateDir:socket;
    },
  }));
  assert.equal(result,false);
  assert.equal(env.WAYLAND_DISPLAY,undefined);
  assert.equal(socketReads,0,'must not probe socket without canonical directory');
});

test('allow benign runtime directory trailing slash when realpath is identical',async()=>{
  const env={...base(),XDG_RUNTIME_DIR:'/run/user/1000/'};
  const result=await hydrateLinuxDesktopEnv(fake({
    env,realpathFn:async()=>'/run/user/1000',
    lstatFn:async path=>path===env.XDG_RUNTIME_DIR?privateDir:socket,
  }));
  assert.equal(result,true);
  assert.equal(env.WAYLAND_DISPLAY,'wayland-0');
});

test('Linux Wayland socket paths use POSIX semantics on any test host',async()=>{
  const env={...base(),XDG_RUNTIME_DIR:'/run/user/1000/'};
  const paths=[];
  const changed=await hydrateLinuxDesktopEnv(fake({
    env,
    realpathFn:async()=>'/run/user/1000',
    lstatFn:async path=>{
      paths.push(path);
      return path==='/run/user/1000/'?privateDir:socket;
    },
  }));
  assert.equal(changed,true);
  assert.ok(paths.includes('/run/user/1000/wayland-0'),
    'Linux socket path must be portable across Windows and POSIX test runners');
  assert.equal(paths.some(path=>path.includes('\\')),false);
});
