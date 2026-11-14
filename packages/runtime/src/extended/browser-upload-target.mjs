// Uploads must never silently resolve the first of several matching fields.
// Use the exact CDP node ID returned by one selector query (no extra RTT).
export async function uniqueUploadNodeId(session, rootNodeId, selector) {
  const matches=await session.send('DOM.querySelectorAll',{nodeId:rootNodeId,selector});
  const ids=matches?.nodeIds;
  if(!Array.isArray(ids)||ids.length!==1||
      !Number.isSafeInteger(ids[0])||ids[0]<1){
    throw new Error('File upload selector missing or ambiguous');
  }
  return ids[0];
}
