// Shared, bounded Unix socket path for trusted app connectors.
// macOS often rejects sockaddr_un paths exceeding ~104 bytes. Fall back to
// an owner-only, hashed directory under /tmp without following other users'
// sockets. Both the server and client must compute the exact same path.
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const MAX_SOCKET_BYTES=100;

export function appConnectorLocation(app,options={}){
  const uid=options.uid??(typeof process.getuid==='function'?process.getuid():null);
  if(!Number.isSafeInteger(uid)||uid<0)throw Error('Local owner identity unavailable');
  if(typeof app!=='string'||!/^[a-z][a-z0-9_-]{0,79}$/.test(app))
    throw Error('Invalid registered app connector name');
  const home=options.home||os.homedir();
  if(typeof home!=='string'||!path.isAbsolute(home))
    throw Error('App connector home must be absolute');
  const primary=path.join(home,'.local','share','remcp','app-bridges');
  const normal=path.join(primary,app+'.sock');
  if(Buffer.byteLength(normal)<=MAX_SOCKET_BYTES)
    return {dir:primary,socket:normal,short:false};
  const dir=path.join('/tmp','remcp-bridge-'+uid+'-'+hash(home));
  let socket=path.join(dir,app+'.sock');
  if(Buffer.byteLength(socket)>MAX_SOCKET_BYTES)
    socket=path.join(dir,'app-'+hash(app)+'.sock');
  if(Buffer.byteLength(socket)>MAX_SOCKET_BYTES)
    throw Error('App connector socket path cannot fit OS limit');
  return {dir,socket,short:true};
}
