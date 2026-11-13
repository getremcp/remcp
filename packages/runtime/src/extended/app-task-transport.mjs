// App Connector Protocol v1: local, user-owned Unix sockets only.
// The connector is a separate user-authorized application process (e.g.
// TDLib). Never extract Telegram Desktop keys, load arbitrary local JS, or
// send account credentials through a tool call or remote HTTP endpoint.
import {lstatSync} from 'node:fs';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {findAppProfile} from './app-launch-registry.mjs';
import {findWebAppProfile} from './app-web-profiles.mjs';
import {appConnectorLocation} from './app-connector-path.mjs';

export const APP_CONNECTOR_PROTOCOL='remcp.app.v1';
const MAX_RPC_BYTES=64*1024;
const MAX_REQUEST_BYTES=48*1024;

export function appConnectorSocket(app,options={}) {
  if(typeof app!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/.test(app)||
    (!findAppProfile(app)&&!findWebAppProfile(app)))return null;
  const platform=options.platform||process.platform;
  if(platform!=='linux'&&platform!=='darwin')return null;
  const {dir,socket:socketPath}=appConnectorLocation(app,options);
  const uid=options.uid??(typeof process.getuid==='function'?process.getuid():null);
  if(!Number.isSafeInteger(uid)||uid<0)return null;
  try {
    const parent=lstatSync(dir);
    const socket=lstatSync(socketPath);
    if(!parent.isDirectory()||parent.uid!==uid||(parent.mode&0o077)!==0 ||
      !socket.isSocket()||socket.uid!==uid||(socket.mode&0o077)!==0)
      return null;
  }catch{return null}
  return socketPath;
}

export function appConnectorRequest(socketPath,operation,params,options={}) {
  const app=options.app||'telegram';
  const permitted=app==='telegram'
    ? ['get_post','edit_post','find','find_posts','inspect'] : ['find','inspect'];
  if(!permitted.includes(operation))
    throw new Error('Unsupported trusted app connector operation');
  if(typeof socketPath!=='string'||!socketPath)return Promise.reject(Error('Connector unavailable'));
  const requestId=randomUUID();
  const encoded=JSON.stringify({protocol:APP_CONNECTOR_PROTOCOL,
    request_id:requestId,app,operation,params})+'\n';
  if(Buffer.byteLength(encoded)>MAX_REQUEST_BYTES)
    return Promise.reject(Error('App connector request exceeds bounded size'));
  const connect=options.createConnection||createConnection;
  const timeoutMs=['get_post','find','find_posts','inspect'].includes(operation)?2600:4600;
  return new Promise((resolve,reject)=>{
    let completed=false,buffer='';
    const socket=connect({path:socketPath});
    // Preserve Unicode even when UTF-8 codepoints span separate socket chunks.
    socket.setEncoding('utf8');
    const settle=(error,value)=>{
      if(completed)return;
      completed=true;
      socket.destroy();
      if(error)reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('timeout',()=>settle(Error('App connector response timed out')));
    socket.on('error',()=>settle(Error('App connector connection failed')));
    socket.on('connect',()=>socket.write(encoded));
    socket.on('data',chunk=>{
      if(completed)return;
      buffer+=String(chunk);
      if(Buffer.byteLength(buffer)>MAX_RPC_BYTES)
        return settle(Error('App connector reply too large'));
      const index=buffer.indexOf('\n');
      if(index<0)return;
      let reply;
      try{reply=JSON.parse(buffer.slice(0,index));}
      catch{return settle(Error('App connector response is not valid JSON'))}
      if(reply?.protocol!==APP_CONNECTOR_PROTOCOL||
        reply?.request_id!==requestId||reply?.ok!==true||
        !reply.result||typeof reply.result!=='object')
        return settle(Error('App connector returned unauthenticated or unsuccessful response'));
      settle(null,reply.result);
    });
    socket.on('end',()=>settle(Error('App connector closed without response')));
  });
}

export function connectedTelegramAppProvider(options={}) {
  const socketPath=appConnectorSocket('telegram',options);
  if(!socketPath)return null;
  const request=options.request||appConnectorRequest;
  return Object.freeze({
    kind:'telegram_user_account_local_socket',
    getPost:ref=>request(socketPath,'get_post',{post_url:ref.url},options),
    editPost:payload=>request(socketPath,'edit_post',payload,options),
    findPosts:(query,channel)=>request(socketPath,'find_posts',
      {query,...(channel?{channel}:{})},options),
  });
}

export function connectedApplicationProvider(app,options={}) {
  const socketPath=appConnectorSocket(app,options);
  if(!socketPath)return null;
  const request=options.request||appConnectorRequest;
  const scope={...options,app};
  return Object.freeze({
    kind:'user_local_app_connector',
    inspect:()=>request(socketPath,'inspect',{},scope),
    find:query=>request(socketPath,'find',{query},scope),
  });
}
