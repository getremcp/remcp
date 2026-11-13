import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {appConnectorLocation} from '../src/extended/app-connector-path.mjs';
import {startAppConnectorServer} from '../src/extended/app-connector-server.mjs';
import {appConnectorSocket,connectedApplicationProvider} from '../src/extended/app-task-transport.mjs';

test('short app connector path preserves existing location for ordinary homes',()=>{
 const out=appConnectorLocation('blender',{uid:501,home:'/Users/qa'});
 assert.equal(out.short,false);
 assert.match(out.socket,/\.local\/share\/remcp\/app-bridges\/blender\.sock$/);
});
test('long home paths produce a deterministic private /tmp fallback with bounded sockaddr_un',()=>{
 const a=appConnectorLocation('blender',{uid:501,home:'/var/folders/very-long-user-private-tmp-path/'.repeat(3)});
 const b=appConnectorLocation('blender',{uid:501,home:'/var/folders/very-long-user-private-tmp-path/'.repeat(3)});
 assert.equal(a.short,true);
 assert.equal(a.socket,b.socket);
 assert.ok(Buffer.byteLength(a.socket)<=100);
 assert.match(a.dir,/^\/tmp\/remcp-bridge-501-[a-f0-9]{16}$/);
 const other=appConnectorLocation('blender',{uid:501,home:'/other/very-long-user-private-tmp-path/'.repeat(3)});
 assert.notEqual(other.socket,a.socket);
});
test('client and server use the same owner-only short path for an actual Unix bridge',
 {skip:!['linux','darwin'].includes(process.platform)},async t=>{
 const home=mkdtempSync(path.join(tmpdir(),'remcp-long-socket-path-'+('abcd'.repeat(14))+'-'));
 const options={home,uid:process.getuid(),platform:process.platform};
 const pathInfo=appConnectorLocation('blender',options);
 assert.equal(pathInfo.short,true);
 let server;
 t.after(async()=>{
  if(server)await server.close();
  if(pathInfo.short)rmSync(pathInfo.dir,{recursive:true,force:true});
  rmSync(home,{recursive:true,force:true});
 });
 server=await startAppConnectorServer('blender',{
  inspect:async()=>({ok:true,available:true,capabilities:['qa_readonly']}),
 },options);
 assert.equal(server.socket_path,pathInfo.socket);
 assert.equal(appConnectorSocket('blender',options),pathInfo.socket);
 assert.equal(statSync(pathInfo.dir).mode&0o077,0);
 assert.equal(statSync(server.socket_path).mode&0o077,0);
 const provider=connectedApplicationProvider('blender',options);
 const data=await provider.inspect();
 assert.equal(data.available,true);
 assert.deepEqual(data.capabilities,['qa_readonly']);
 chmodSync(pathInfo.dir,0o755);
 assert.equal(appConnectorSocket('blender',options),null);
});
