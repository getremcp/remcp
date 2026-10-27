/** Bounded, device-originated HTTPS probe. Never accept a destination from relay callers. */
export const NETWORK_PROBE_MIN_AGENT = '0.2.190';
export function agentNetworkProbeSupported(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version || '');
  if (!match) return false;
  const parts=match.slice(1).map(Number), min=[0,2,190];
  for(let i=0;i<3;i++) {
    if(parts[i]>min[i])return true;
    if(parts[i]<min[i])return false;
  }
  return true;
}
export const DEVICE_PROBE_DOWNLOAD_BYTES = 12 * 1024 * 1024;
export const DEVICE_PROBE_UPLOAD_BYTES = 4 * 1024 * 1024;
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const mbps = (bytes,ms) => Math.round(bytes * 8 / ms / 1000 * 10) / 10;
export async function runAgentNetworkProbe({ serverUrl, deviceToken, signal, request = fetch, clock = () => performance.now() }) {
  if (!/^https:\/\//.test(serverUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(serverUrl))
    throw new Error('Device network diagnostics require a trusted HTTPS ReMCP endpoint');
  const endpoint = serverUrl + '/api/agent-network-probe';
  const auth = {Authorization:'Bearer ' + deviceToken,'Cache-Control':'no-store'};
  const timeout = AbortSignal.timeout(35_000);
  const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
  const sample = async (path,options={}) => {
    const started = clock();
    const response = await request(endpoint + path,{...options,headers:{...auth,...options.headers},signal:combined,redirect:'error'});
    if (!response.ok) throw new Error('Device network probe HTTP ' + response.status);
    return {response,elapsed:()=>clock()-started};
  };
  const rtts=[];
  for (let i=0;i<3;i++) {
    const ping=await sample('/ping');
    await ping.response.body?.cancel();
    rtts.push(ping.elapsed());
  }
  const down=await sample('/download');
  let received=0;
  if (!down.response.body) throw new Error('Device download stream unavailable');
  const reader=down.response.body.getReader();
  try {
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      received+=value.byteLength;
      if (received>DEVICE_PROBE_DOWNLOAD_BYTES) throw new Error('Invalid device download size');
    }
  } finally { reader.releaseLock(); }
  if (received!==DEVICE_PROBE_DOWNLOAD_BYTES) throw new Error('Incomplete device download');
  const downloadMbps=mbps(received,Math.max(1,down.elapsed()));
  const uploadBody=Buffer.alloc(DEVICE_PROBE_UPLOAD_BYTES,0x5a);
  const up=await sample('/upload',{method:'POST',body:uploadBody,headers:{'Content-Type':'application/octet-stream'}});
  const payload=await up.response.json();
  if (payload?.receivedBytes!==DEVICE_PROBE_UPLOAD_BYTES) throw new Error('Incomplete device upload');
  const uploadMbps=mbps(DEVICE_PROBE_UPLOAD_BYTES,Math.max(1,up.elapsed()));
  return {scope:'device_to_remcp',downloadMbps,uploadMbps,
    latencyMs:Math.round(median(rtts)*10)/10,
    jitterMs:Math.round((Math.abs(rtts[1]-rtts[0])+Math.abs(rtts[2]-rtts[1]))/2*10)/10,
    downloadBytes:received,uploadBytes:DEVICE_PROBE_UPLOAD_BYTES,
    publicIp:typeof payload?.publicIp==='string'?payload.publicIp:null,measuredAt:Date.now()};
}
