import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {initializeDeviceE2ee,manageE2eePeer} from '../src/cli/e2ee-identity.mjs';
import {createE2eeVault} from '../src/cli/e2ee-vault.mjs';
import {createE2eeIdentity} from '../src/agent-e2ee-crypto.mjs';
import {createE2eeDeviceClient} from '../src/agent-e2ee-client.mjs';
import {fileURLToPath} from 'node:url';

test('strict real agent uses OS key, rejects plaintext, and encrypts local runtime calls',{
  skip:process.env.REMCP_E2EE_NATIVE_VAULT_QA!=='1'?
    'Requires owner OS vault and explicit native QA':false,
  // Keychain and Windows DPAPI can be slower across fresh owner processes;
  // keep bounded native deadlines without hiding a failed encrypted call.
  timeout:process.platform==='win32'?75000:process.platform==='darwin'?65000:20000,
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'remcp-secure-agent-'));
  const vault=createE2eeVault({directory:root});
  const runtime=path.join(root,process.platform==='win32'?'node_modules':'modules',
    '@example','runtime');
  await fs.mkdir(runtime,{recursive:true});
  const telemetry=path.join(root,'runtime-telemetry'),effects=path.join(root,'effects');
  const script=`
    import fs from 'node:fs';import readline from 'node:readline';
    fs.writeFileSync(${JSON.stringify(telemetry)},process.env.REMCP_RUNTIME_DISABLE_TELEMETRY||'');
    readline.createInterface({input:process.stdin}).on('line',raw=>{
      const m=JSON.parse(raw);if(m.id===undefined)return;
      let result={};
      if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,
        capabilities:{tools:{}},serverInfo:{name:'secure-fixture',version:'1'}};
      if(m.method==='tools/list')result={tools:[{name:'write',description:'QA local write',
        inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},
        annotations:{readOnlyHint:false}}]};
      if(m.method==='tools/call'){
        fs.appendFileSync(${JSON.stringify(effects)},'executed\\n');
        result={content:[{type:'text',text:m.params.arguments.text}]};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `;
  await fs.writeFile(path.join(runtime,'index.mjs'),script);
  const npm=path.join(root,'npm'),modules=path.join(root,'modules');
  const quoted="'"+modules.replaceAll("'","'\\''")+"'";
  await fs.writeFile(npm,"#!/bin/sh\nprintf '%s\\n' "+quoted+"\n",{mode:0o700});
  const httpServer=http.createServer(),wss=new WebSocketServer({server:httpServer});
  httpServer.listen(0,'127.0.0.1');await once(httpServer,'listening');
  const config={deviceId:'device-real-agent-1234',deviceToken:'synthetic-pairing-token',
    serverUrl:'http://127.0.0.1:'+httpServer.address().port};
  const device=await initializeDeviceE2ee(config,{directory:root}),owner=await createE2eeIdentity();
  await manageE2eePeer(config,'trust',{'public-key':owner.publicKey,
    fingerprint:owner.fingerprint,mode:'control'},{directory:root});
  let socket,sequence=0;
  const frames=[],waiters=new Map();
  wss.on('connection',s=>{
    socket=s;
    s.on('message',raw=>{
      const m=JSON.parse(raw.toString());frames.push(m);
      if(m.type==='response'&&waiters.has(m.id)){
        const p=waiters.get(m.id);waiters.delete(m.id);
        m.error?p.reject(new Error('agent_rejected')):p.resolve(m.result);
      }
    });
  });
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id='rpc-'+(++sequence);waiters.set(id,{resolve,reject});
    socket.send(JSON.stringify({type:'request',id,method,params}));
  });
  const runUrl=new URL('../src/agent.mjs',import.meta.url).href;
  const launch=`
    import {runAgent} from ${JSON.stringify(runUrl)};
    const agent=await runAgent(${JSON.stringify({...config,e2eeIdentity:true,requireE2ee:true,
      telemetryEnabled:true,installReported:true,autoUpdate:false,
      runtime:{kind:'npm',packageName:'@example/runtime',packageSpec:'@example/runtime@1.0.0',entry:'index.mjs'}})});
    process.on('SIGTERM',async()=>{await agent.stop();process.exit(0);});
  `;
  const child=spawn(process.execPath,['--input-type=module','--eval',launch],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    // The installed Windows ReMCP agent sets uppercase NPM_CONFIG_PREFIX.
    // Override that exact environment key: Windows treats differently cased
    // names as the same variable, and a lowercase duplicate can be ignored.
    env:{...process.env,REMCP_CONFIG_DIR:root,...(process.platform==='win32'
      ?{REMCP_NPM:'',NPM_CONFIG_PREFIX:root}:{REMCP_NPM:npm})},
    stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
  const wait=async check=>{
    const end=Date.now()+(process.platform==='win32'?35000:process.platform==='darwin'?25000:8000);
    while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,20));}
    throw new Error('secure_agent_fixture_timed_out');
  };
  try{
    await wait(()=>frames.some(m=>m.type==='hello'));
    const first=socket;
    // A new plaintext call is refused on the same authenticated socket. The agent must not
    // terminate it (that made the computer look offline for valid encrypted clients).
    await assert.rejects(rpc('tools/call',{name:'write',arguments:{text:'must not execute'}}),
      /agent_rejected/);
    assert.equal(socket,first,'the authenticated WebSocket survives a plaintext refusal');
    assert.equal(frames.filter(m=>m.type==='hello').length,1,'a refusal must not force a reconnect');
    await assert.rejects(fs.readFile(effects),{code:'ENOENT'});
    const client=createE2eeDeviceClient({identity:owner,deviceId:config.deviceId,
      pinnedDevice:device.fingerprint,describe:()=>rpc('e2ee/identity'),
      dispatch:packet=>rpc('e2ee/packet',{packet})});
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['write']);
    const secret='PRIVATE ENDPOINT 日本語 Привет';
    assert.equal((await client.callTool({name:'write',arguments:{text:secret}})).content[0].text,secret);
    assert.equal((await fs.readFile(effects,'utf8')).trim(),'executed');
    assert.equal(await fs.readFile(telemetry,'utf8'),'1','inner tool telemetry is disabled for encryption-enabled agents');
    assert.ok(!JSON.stringify(frames).includes(secret));
    assert.ok(!logs.includes(secret));
  }finally{
    // A Windows child can exit before the fixture begins cleanup; awaiting
    // a second 'exit' event would hang and conceal the actual test failure.
    if(child.exitCode===null&&child.signalCode===null){
      const exited=once(child,'exit',{signal:AbortSignal.timeout(4000)});
      child.kill('SIGTERM');
      await exited.catch(error=>{
        if(error?.name!=='AbortError')throw error;
        child.kill('SIGKILL');
      });
    }
    for(const s of wss.clients)s.terminate();
    await new Promise(r=>wss.close(r));await new Promise(r=>httpServer.close(r));
    await vault.remove();await fs.rm(root,{recursive:true,force:true});
  }
});
