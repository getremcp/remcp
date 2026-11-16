// Fixed first-party TURN destinations; no model-selected URL or long-lived relay key.
export function validateDeviceIce(value,now=Date.now()){
  const bad=()=>{throw Error('Trusted device ICE unavailable');};
  if(!value||Object.keys(value).sort().join(',')!=='expiresAt,iceServers,ttlSeconds'||
    !Number.isSafeInteger(value.expiresAt)||!Number.isSafeInteger(value.ttlSeconds)||
    value.ttlSeconds<120||value.ttlSeconds>900||
    value.expiresAt*1000<now+60000||value.expiresAt*1000>now+(value.ttlSeconds+15)*1000||
    !Array.isArray(value.iceServers)||value.iceServers.length!==1)bad();
  const server=value.iceServers[0];
  if(!server||Object.keys(server).sort().join(',')!=='credential,urls,username'||
    !Array.isArray(server.urls)||server.urls.length<1||server.urls.length>3||new Set(server.urls).size!==server.urls.length||
    !server.urls.every(u=>typeof u==='string'&&
      /^(?:turn:turn\.remcp\.site:3478\?transport=(?:udp|tcp)|turns:turn\.remcp\.site:5349\?transport=tcp)$/.test(u))||
    typeof server.username!=='string'||!new RegExp('^'+value.expiresAt+':[a-f0-9]{32}$').test(server.username)||
    typeof server.credential!=='string'||!/^[A-Za-z0-9+/]{27}=$/.test(server.credential))bad();
  return structuredClone(value);
}
