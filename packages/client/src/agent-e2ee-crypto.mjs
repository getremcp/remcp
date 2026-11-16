// RFC 9180 authenticated HPKE. Shared by the device and first-party clients.
// Relay-visible fields are routing metadata; tool requests and results are AEAD ciphertext.
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';

export const E2EE_PROTOCOL = 'remcp-hpke-auth-p256-v1';
export const E2EE_CHUNK_BYTES = 180 * 1024;
export const E2EE_PACKET_LIMIT = 256 * 1024;
export const E2EE_MESSAGE_LIMIT = 10 * 1024 * 1024;
const MAX_AGE = 120_000, enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal:true });
const suite = () => new CipherSuite({ kem:new DhkemP256HkdfSha256(), kdf:new HkdfSha256(), aead:new Aes256Gcm() });
const fail = () => { throw new Error('e2ee_packet_rejected'); };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{5,128}$/.test(value);
const fields = ['call','chunk','chunks','ciphertext','device','direction','enc','epoch','expires','from','issued','nonce','session','to','version'];
const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
export function encodeE2eeBytes(value) {
  const input = bytes(value); let text = '';
  for (let start=0;start<input.length;start+=8192)
    text += String.fromCharCode(...input.subarray(start,start+8192));
  return btoa(text).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function decodeE2eeBytes(text, maximum=E2EE_PACKET_LIMIT) {
  if (typeof text !== 'string' || text.length > maximum * 1.4 ||
      !/^[A-Za-z0-9_-]+$/.test(text)) fail();
  let out;
  try { out=Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)); }
  catch { fail(); }
  if (out.length > maximum || encodeE2eeBytes(out)!==text) fail();
  return out;
}
export async function e2eeFingerprint(publicKey) {
  const raw=decodeE2eeBytes(publicKey,65);
  if(raw.length!==65||raw[0]!==4)fail();
  // Import validates that the encoded P-256 point is on the curve.
  await suite().kem.deserializePublicKey(raw);
  const digest=await crypto.subtle.digest('SHA-256',enc.encode(E2EE_PROTOCOL+':'+publicKey));
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}
export async function createE2eeIdentity() {
  const keys=await suite().kem.generateKeyPair();
  const publicKey=encodeE2eeBytes(await suite().kem.serializePublicKey(keys.publicKey));
  return { keys, publicKey, fingerprint:await e2eeFingerprint(publicKey) };
}
export async function exportE2eeIdentity(identity) {
  return { version:E2EE_PROTOCOL, publicKey:identity.publicKey,
    privateKey:encodeE2eeBytes(await suite().kem.serializePrivateKey(identity.keys.privateKey)) };
}
export async function importE2eeIdentity(record) {
  if(!record||record.version!==E2EE_PROTOCOL||
      Object.keys(record).sort().join(',')!=='privateKey,publicKey,version')fail();
  const hpke=suite();
  const keys={ publicKey:await hpke.kem.deserializePublicKey(decodeE2eeBytes(record.publicKey,65)),
    privateKey:await hpke.kem.deserializePrivateKey(decodeE2eeBytes(record.privateKey,32)) };
  const identity={keys,publicKey:record.publicKey,fingerprint:await e2eeFingerprint(record.publicKey)};
  // Prove the stored secret matches its public key rather than trusting metadata.
  const probe=await sealE2eePacket({sender:identity,recipient:record.publicKey,pinnedRecipient:identity.fingerprint,
    device:'identity-check',session:'identity-check',call:'identity-check',direction:'request',epoch:'identity-check',plaintext:enc.encode('key-match')});
  const opened=await openE2eePacket({receiver:identity,sender:record.publicKey,pinnedSender:identity.fingerprint,
    packet:probe,device:'identity-check',session:'identity-check',call:'identity-check',direction:'request',epoch:'identity-check',
    replay:createE2eeReplayGuard()});
  if(dec.decode(opened)!=='key-match')fail();
  return identity;
}
function checkMetadata(p,{device,session,call,direction,epoch,now}) {
  if(!p||p.version!==E2EE_PROTOCOL||!validId(device)||!validId(session)||!validId(call)||
      p.device!==device||p.session!==session||p.call!==call||p.direction!==direction||
      !validId(epoch)||p.epoch!==epoch||
      !['request','response'].includes(direction)||!/^[0-9a-f]{64}$/.test(p.to||'')||
      !/^[0-9a-f]{64}$/.test(p.from||'')||!/^[A-Za-z0-9_-]{22}$/.test(p.nonce||'')||
      !Number.isSafeInteger(now)||!Number.isSafeInteger(p.issued)||!Number.isSafeInteger(p.expires)||
      p.issued>now+15000||p.expires<=now||p.expires<=p.issued||p.expires-p.issued>MAX_AGE||
      !Number.isSafeInteger(p.chunk)||!Number.isSafeInteger(p.chunks)||p.chunk<0||
      p.chunks<1||p.chunks>64||p.chunk>=p.chunks)fail();
}
const aad = p => enc.encode(JSON.stringify([p.version,p.device,p.session,p.call,p.direction,p.from,p.to,
  p.epoch,p.issued,p.expires,p.nonce,p.chunk,p.chunks]));
export function createE2eeReplayGuard({maximum=8192}={}) {
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)fail();
  const seen=new Map();
  return { claim(id,expiry,now) {
    for(const [key,end] of seen)if(end<=now)seen.delete(key);
    if(seen.has(id)||seen.size>=maximum)fail();
    seen.set(id,expiry);
  }, size:()=>seen.size };
}
export async function sealE2eePacket({sender,recipient,pinnedRecipient,device,session,call,direction,
  plaintext,epoch,chunk=0,chunks=1,now=Date.now()}) {
  if(await e2eeFingerprint(recipient)!==pinnedRecipient||!sender?.keys?.privateKey)fail();
  const body=typeof plaintext==='string'?enc.encode(plaintext):bytes(plaintext);
  if(body.length>E2EE_CHUNK_BYTES)fail();
  const p={version:E2EE_PROTOCOL,device,session,call,direction,epoch,from:sender.fingerprint,to:pinnedRecipient,
    issued:now,expires:now+MAX_AGE,nonce:encodeE2eeBytes(crypto.getRandomValues(new Uint8Array(16))),chunk,chunks};
  checkMetadata(p,{device,session,call,direction,epoch,now});
  const hpke=suite(), recipientPublicKey=await hpke.kem.deserializePublicKey(decodeE2eeBytes(recipient,65));
  const context=await hpke.createSenderContext({recipientPublicKey,senderKey:sender.keys,
    info:enc.encode(E2EE_PROTOCOL+':'+session)});
  p.enc=encodeE2eeBytes(context.enc);
  p.ciphertext=encodeE2eeBytes(await context.seal(body,aad(p)));
  return p;
}
export async function openE2eePacket({receiver,sender,pinnedSender,packet:p,device,session,call,
  direction,epoch,replay,now=Date.now()}) {
  if(!p||Object.keys(p).sort().join(',')!==fields.join(',')||
      enc.encode(JSON.stringify(p)).length>E2EE_PACKET_LIMIT||
      await e2eeFingerprint(sender)!==pinnedSender||!replay?.claim)fail();
  checkMetadata(p,{device,session,call,direction,epoch,now});
  if(p.from!==pinnedSender||p.to!==receiver.fingerprint)fail();
  let plaintext;
  try {
    const hpke=suite(), senderPublicKey=await hpke.kem.deserializePublicKey(decodeE2eeBytes(sender,65));
    const context=await hpke.createRecipientContext({recipientKey:receiver.keys,
      senderPublicKey,enc:decodeE2eeBytes(p.enc,65),info:enc.encode(E2EE_PROTOCOL+':'+session)});
    plaintext=new Uint8Array(await context.open(decodeE2eeBytes(p.ciphertext,E2EE_CHUNK_BYTES+16),aad(p)));
  } catch { fail(); }
  if(plaintext.length>E2EE_CHUNK_BYTES)fail();
  replay.claim(p.from+':'+p.nonce,p.expires,now);
  return plaintext;
}
export async function sealE2eeMessage(options) {
  const input=typeof options.plaintext==='string'?enc.encode(options.plaintext):bytes(options.plaintext);
  if(input.length>E2EE_MESSAGE_LIMIT)fail();
  const chunks=Math.max(1,Math.ceil(input.length/E2EE_CHUNK_BYTES)), packets=[];
  for(let chunk=0;chunk<chunks;chunk++)packets.push(await sealE2eePacket({...options,chunk,chunks,
    plaintext:input.subarray(chunk*E2EE_CHUNK_BYTES,(chunk+1)*E2EE_CHUNK_BYTES)}));
  return packets;
}
export async function openE2eeMessage(options) {
  const packets=options.packets;
  if(!Array.isArray(packets)||!packets.length||packets.length>64||
      packets.some((p,i)=>p?.chunk!==i||p?.chunks!==packets.length))fail();
  const chunks=[]; let total=0;
  for(const packet of packets) {
    const chunk=await openE2eePacket({...options,packet});
    total+=chunk.length;if(total>E2EE_MESSAGE_LIMIT)fail();chunks.push(chunk);
  }
  const output=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
  return output;
}
