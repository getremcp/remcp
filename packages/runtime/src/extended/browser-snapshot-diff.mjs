// Incremental CDP AX snapshots with bounded, opaque, privacy-preserving state.
// Only keyed HMAC fingerprints are cached; page text/values are never retained.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const secret = randomBytes(32);
const snapshots = new Map();
const MAX_SNAPSHOTS = 16;
const MAX_AGE_MS = 120_000;

function fingerprint(node) {
  return createHmac('sha256', secret).update(JSON.stringify(node)).digest('hex');
}

function scopeFor(target, limit, endpoint) {
  return JSON.stringify([String(endpoint ?? ''),String(target?.id || ''),String(target?.url || ''),limit]);
}

export function snapshotDelta(nodes, target, limit, {
  from = null,
  endpoint = '',
  now = Date.now(),
} = {}) {
  // Pure-data input may contain arbitrary page text. Store only HMACs and IDs,
  // never node text. Fingerprints cannot be reverse-looked up without the key.
  for (const [key, record] of snapshots) {
    if (now - record.created > MAX_AGE_MS) snapshots.delete(key);
  }
  const scope = scopeFor(target,limit,endpoint);
  const digest = new Map();
  for(let i=0;i<nodes.length;i++){
    const id = String(nodes[i].node_id || 'index:'+i);
    digest.set(id, fingerprint(nodes[i]));
  }
  const previous = typeof from === 'string' && from.length === 36 && /^[0-9a-f-]{36}$/.test(from)
    ? snapshots.get(from) : null;
  const matched = previous && previous.scope === scope && now - previous.created <= MAX_AGE_MS;
  const updated = [];
  const removed = [];
  if (matched) {
    for(let i=0;i<nodes.length;i++){
      const id=String(nodes[i].node_id || 'index:'+i);
      if(previous.digests.get(id)!==digest.get(id))updated.push(nodes[i]);
    }
    for(const id of previous.digests.keys())if(!digest.has(id))removed.push(id);
  }
  const id = randomUUID();
  snapshots.set(id, {scope,digests:digest,created:now});
  while(snapshots.size>MAX_SNAPSHOTS)snapshots.delete(snapshots.keys().next().value);
  return {
    snapshot_id:id,
    diff_status:matched?'delta':from?'unavailable':'full',
    nodes:matched?updated:nodes,
    removed_node_ids:matched?removed:[],
    total_nodes:nodes.length,
  };
}
