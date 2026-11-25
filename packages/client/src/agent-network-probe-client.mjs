/** Bounded, device-originated HTTPS probe. Never accept a destination from relay callers. */
export const NETWORK_PROBE_MIN_AGENT = '0.2.190';
export const NETWORK_PROBE_PROGRESS_MIN_AGENT = '0.2.268';
export function agentNetworkProbeSupported(version, minimum = NETWORK_PROBE_MIN_AGENT) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version || '');
  if (!match) return false;
  const parts=match.slice(1).map(Number), min=minimum.split('.').map(Number);
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
export async function runAgentNetworkProbe({ serverUrl, deviceToken, signal, request = fetch, clock = () => performance.now(), onProgress = () => {} }) {
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
  const emit = (phase, downloadMbps=null, uploadMbps=null, latencyMs=null) => {
    if (!combined.aborted) onProgress({phase,downloadMbps,uploadMbps,latencyMs});
  };
  emit('latency');
  const rtts=[];
  let rounds=1;
  for (let i=0;i<3;i++) {
    const ping=await sample('/ping');
    if(i===0) {
      const info=await ping.response.json();
      if(info?.probeVersion===2)rounds=4;
    } else await ping.response.body?.cancel();
    rtts.push(ping.elapsed());
  }
  const latency=Math.round(median(rtts)*10)/10;
  emit('download',null,null,latency);
  const started=clock(), targetMs=5000;
  let received=0, sent=0, downMs=0, upMs=0, payload=null;
  // Fixed byte caps remain per transfer; use up to four independently admitted
  // rounds to reduce short-transfer bias. Never pad timings with idle delays.
  for(let round=1;round<=rounds;round++){
    if(round>1&&(downMs>=targetMs||clock()-started>=12000))break;
    const down=await sample('/download'+(round===1?'':'?round='+round));
    let count=0, lastProgress=clock();
    if(!down.response.body)throw new Error('Device download stream unavailable');
    const reader=down.response.body.getReader();
    try{
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        count+=value.byteLength;
        if(count>DEVICE_PROBE_DOWNLOAD_BYTES)throw new Error('Invalid device download size');
        if(clock()-lastProgress>=350 && down.elapsed()>=350){
          emit('download',mbps(received+count,downMs+down.elapsed()),null,latency);
          lastProgress=clock();
        }
      }
    }finally{reader.releaseLock();}
    if(count!==DEVICE_PROBE_DOWNLOAD_BYTES)throw new Error('Incomplete device download');
    received+=count;downMs+=Math.max(1,down.elapsed());
    emit('download',mbps(received,downMs),null,latency);
  }
  emit('upload',mbps(received,downMs),null,latency);
  const uploadBody=Buffer.alloc(DEVICE_PROBE_UPLOAD_BYTES,0x5a);
  const uploadStarted=clock();
  for(let round=1;round<=rounds;round++){
    if(round>1&&(upMs>=targetMs||clock()-uploadStarted>=12000||clock()-started>=25000))break;
    const up=await sample('/upload'+(round===1?'':'?round='+round),{method:'POST',body:uploadBody,headers:{'Content-Type':'application/octet-stream'}});
    payload=await up.response.json();
    if(payload?.receivedBytes!==DEVICE_PROBE_UPLOAD_BYTES)throw new Error('Incomplete device upload');
    sent+=DEVICE_PROBE_UPLOAD_BYTES;upMs+=Math.max(1,up.elapsed());
    emit('upload',mbps(received,downMs),mbps(sent,upMs),latency);
  }
  return {scope:'device_to_remcp',downloadMbps:mbps(received,downMs),uploadMbps:mbps(sent,upMs),
    latencyMs:latency,
    jitterMs:Math.round((Math.abs(rtts[1]-rtts[0])+Math.abs(rtts[2]-rtts[1]))/2*10)/10,
    downloadBytes:received,uploadBytes:sent,downloadDurationMs:Math.round(downMs),uploadDurationMs:Math.round(upMs),
    publicIp:typeof payload?.publicIp==='string'?payload.publicIp:null,measuredAt:Date.now()};
}
