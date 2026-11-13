// Optional local connector SDK for trusted app integrations. This is NOT a
// network service, does not start automatically, and owns no app credentials.
// A companion must establish its own user authorization and enforce an atomic
// compare-and-swap before applying any post mutation.
import {createServer} from 'node:net';
import {mkdirSync,lstatSync,chmodSync,unlinkSync} from 'node:fs';
import {APP_CONNECTOR_PROTOCOL} from './app-task-transport.mjs';
import {appConnectorSocket} from './app-task-transport.mjs';
import {appConnectorLocation} from './app-connector-path.mjs';
import {findAppProfile} from './app-launch-registry.mjs';
import {findWebAppProfile} from './app-web-profiles.mjs';
import {telegramPostReference} from './app-task-contract.mjs';
import os from 'node:os';
import path from 'node:path';

const METHODS=new Set(['inspect','find','find_posts','get_post','edit_post']);
const MAX_IN=48*1024, MAX_OUT=64*1024;
const isObject=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const keysAllowed=(obj,allowed)=>isObject(obj)&&
  Object.keys(obj).every(key=>allowed.includes(key));
const printable=(value,max)=>typeof value==='string'&&value.length>0&&
  value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
const queryOk=value=>printable(value,256)&&!value.includes('\n')&&!value.includes('\r');

export function validateConnectorMethod(app,operation,params) {
  if(!METHODS.has(operation)||typeof app!=='string')return false;
  if(!isObject(params))return false;
  if(app!=='telegram'&&['find_posts','get_post','edit_post'].includes(operation))
    return false;
  if(operation==='inspect')return keysAllowed(params,[]);
  if(operation==='find')return keysAllowed(params,['query'])&&queryOk(params.query);
  if(operation==='find_posts')return keysAllowed(params,['query','channel'])&&
    queryOk(params.query)&&
    (params.channel===undefined||typeof params.channel==='string'&&
      /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(params.channel));
  if(operation==='get_post'){
    if(!keysAllowed(params,['post_url']))return false;
    try{telegramPostReference(params.post_url);return true}catch{return false}
  }
  if(operation==='edit_post'){
    if(!keysAllowed(params,['post_url','message_id','chat_id','account_id',
      'expected_text','new_text','expected_revision','expected_content_kind',
      'expected_has_text_entities','expected_has_media','expected_has_link_preview']))
      return false;
    try{
      const ref=telegramPostReference(params.post_url);
      if(String(params.message_id)!==ref.message_id)return false;
    }catch{return false}
    return printable(params.new_text,4096)&&
      typeof params.expected_text==='string'&&params.expected_text.length<=4096&&
      typeof params.chat_id==='string'&&params.chat_id.length>0&&params.chat_id.length<=80&&
      typeof params.account_id==='string'&&params.account_id.length>0&&params.account_id.length<=80&&
      params.expected_content_kind==='text'&&
      params.expected_has_text_entities===false&&
      params.expected_has_media===false&&params.expected_has_link_preview===false;
  }
  return false;
}

export function telegramEditPreconditions(current,params) {
  if(!isObject(current)||!isObject(params))return false;
  if(current.post_url!==params.post_url||
    String(current.message_id)!==String(params.message_id)||
    current.chat_id!==params.chat_id||current.account_id!==params.account_id||
    current.is_own_post!==true||current.can_edit!==true||
    current.content_kind!=='text'||current.has_text_entities!==false||
    current.has_media!==false||current.has_link_preview!==false||
    current.text!==params.expected_text)return false;
  if(params.expected_revision!==undefined&&
    String(current.revision)!==String(params.expected_revision))return false;
  return true;
}

function privateDirectory(app,options) {
  const home=options.home||os.homedir();
  const uid=options.uid??(typeof process.getuid==='function'?process.getuid():null);
  if(!Number.isSafeInteger(uid)||uid<0)throw Error('Local owner identity unavailable');
  const loc=appConnectorLocation(app,{...options,home,uid});
  const {dir,socket}=loc;
  mkdirSync(dir,{recursive:true,mode:0o700});
  const stat=lstatSync(dir);
  if(!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o077)!==0)
    throw Error('App connector directory must be private and owned by user');
  try {lstatSync(socket);throw Error('App connector socket already exists; refuse to replace it')}
  catch(error){if(error.code!=='ENOENT')throw error}
  return {dir,socket,uid,short:loc.short};
}

export async function startAppConnectorServer(app,handlers={},options={}) {
  if(typeof app!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/.test(app)||
    (!findAppProfile(app)&&!findWebAppProfile(app)))
    throw Error('Unregistered application cannot open an app connector');
  if(options.platform&&options.platform!=='linux'&&options.platform!=='darwin')
    throw Error('This local connector server currently supports Unix desktops only');
  if(!handlers||!isObject(handlers))throw Error('Missing app-specific handlers');
  const loc=privateDirectory(app,options);
  // Registry and path restrictions are shared with the runtime client.
  // The socket does not yet exist, so validate app identity by registry.
  const id=appConnectorSocket(app,{...options,home:options.home||os.homedir()});
  if(id!==null)throw Error('Unexpected pre-existing connector socket');
  const sockets=new Set(),editing=new Set();
  const server=createServer(socket=>{
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(8000);
    let source='',handled=false;
    const reply=(requestId,ok,result={})=>{
      if(socket.destroyed)return;
      const body=JSON.stringify({
        protocol:APP_CONNECTOR_PROTOCOL,
        request_id:typeof requestId==='string'?requestId:'',
        ok,...(ok?{result}:{error:'request_rejected'}),
      })+'\n';
      if(Buffer.byteLength(body)>MAX_OUT){
        socket.end(JSON.stringify({protocol:APP_CONNECTOR_PROTOCOL,
          request_id:requestId,ok:false,error:'response_too_large'})+'\n');
      }else socket.end(body);
    };
    socket.on('timeout',()=>socket.destroy());
    socket.on('error',()=>socket.destroy());
    socket.on('close',()=>sockets.delete(socket));
    socket.on('data',async chunk=>{
      if(handled)return;
      source+=chunk;
      if(Buffer.byteLength(source)>MAX_IN){handled=true;socket.destroy();return}
      const end=source.indexOf('\n');
      if(end<0)return;
      handled=true;
      let req;
      try{req=JSON.parse(source.slice(0,end))}
      catch{reply('',false);return}
      const operation=req?.operation;
      const id=req?.request_id;
      if(req?.protocol!==APP_CONNECTOR_PROTOCOL||req?.app!==app||
        typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)||
        !validateConnectorMethod(app,operation,req.params)||
        typeof handlers[operation]!=='function'){
        reply(id,false);return;
      }
      let lock=null;
      try{
        if(operation==='edit_post'){
          if(typeof handlers.get_post!=='function'){
            reply(id,false);return;
          }
          lock=req.params.post_url;
          if(editing.has(lock)){reply(id,false);return}
          editing.add(lock);
          const current=await handlers.get_post({post_url:lock});
          if(!telegramEditPreconditions(current,req.params)){
            reply(id,false);return;
          }
        }
        const result=await handlers[operation](req.params);
        if(!isObject(result)){reply(id,false);return}
        reply(id,true,result);
      }catch{reply(id,false)}
      finally{if(lock)editing.delete(lock)}
    });
  });
  server.maxConnections=16;
  try{
    await new Promise((resolve,reject)=>{
      const fail=error=>reject(error);
      server.once('error',fail);
      server.listen(loc.socket,()=>{server.off('error',fail);resolve()});
    });
    chmodSync(loc.socket,0o600);
    const current=lstatSync(loc.socket);
    if(!current.isSocket()||current.uid!==loc.uid||(current.mode&0o077)!==0)
      throw Error('Unsafe connector socket permissions');
    return {
      app,socket_path:loc.socket,protocol:APP_CONNECTOR_PROTOCOL,
      close:async()=>{
        for(const client of sockets)client.destroy();
        await new Promise(resolve=>server.close(()=>resolve()));
        try {
          const stat=lstatSync(loc.socket);
          if(stat.isSocket()&&stat.ino===current.ino&&stat.dev===current.dev)
            unlinkSync(loc.socket);
        }catch(error){if(error.code!=='ENOENT')throw error}
      },
    };
  }catch(error){
    try{server.close()}catch{}
    throw error;
  }
}
