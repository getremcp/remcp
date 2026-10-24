// Local-only Chrome DOMSnapshot geometry aggregation.
// DOMSnapshot can contain page text and attributes: NEVER serialize, log or return it.
// The result contains counts and bounded geometry of tag types, not DOM content.
const ALLOWED_TAGS = new Set([
  'A','ARTICLE','ASIDE','BLOCKQUOTE','BUTTON','CANVAS','CODE','DD','DETAILS','DIV',
  'DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4',
  'H5','H6','HEADER','IFRAME','IMG','INPUT','LABEL','LI','MAIN','NAV','OL','OPTION',
  'P','PICTURE','PRE','SECTION','SELECT','SPAN','SVG','TABLE','TBODY','TD',
  'TEXTAREA','TH','THEAD','TR','UL','VIDEO',
]);
const MAX_LAYOUT_NODES = 12000;
const MAX_CANDIDATES = 8;
const EPSILON = 1;
function decimal(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-10000000, Math.min(10000000, Math.round(value * 100) / 100))
    : null;
}
function typeForNode(doc, strings, nodeIndex) {
  const idx = doc?.nodes?.nodeName?.[nodeIndex];
  if (!Number.isSafeInteger(idx) || !Array.isArray(strings)) return '';
  const str = strings[idx];
  if (typeof str !== 'string' || str.length > 20) return '';
  const upper = str.toUpperCase();
  return ALLOWED_TAGS.has(upper) ? upper.toLowerCase() : '';
}
export function summarizeDomGeometry(snapshot, pageMetrics, { maxNodes = MAX_LAYOUT_NODES } = {}) {
  const rawDocs = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const doc = rawDocs[0] || {};
  const indices = Array.isArray(doc?.layout?.nodeIndex) ? doc.layout.nodeIndex : [];
  const bounds = Array.isArray(doc?.layout?.bounds) ? doc.layout.bounds : [];
  const width = decimal(pageMetrics?.cssLayoutViewport?.clientWidth);
  const scrollX = decimal(pageMetrics?.cssLayoutViewport?.pageX) ?? 0;
  if (width == null || width <= 0) throw new Error('Chrome did not report a valid layout viewport width');
  const left = scrollX, right = scrollX + width;
  const count = Math.min(MAX_LAYOUT_NODES, Math.max(0,Math.floor(Number(maxNodes) || MAX_LAYOUT_NODES)),indices.length,bounds.length);
  let eligible = 0, candidateCount = 0, leftOverflowCount = 0, rightOverflowCount = 0;
  let biggestOverflow = 0;
  const byTag = Object.create(null);
  const top = [];
  for (let i = 0; i < count; i++) {
    const tag = typeForNode(doc,snapshot?.strings,indices[i]);
    if (!tag) continue;
    const box = bounds[i];
    if (!Array.isArray(box) || box.length < 4) continue;
    const [x,y,w,h] = box.map(decimal);
    if ([x,y,w,h].some(v => v == null) || w <= 0 || h <= 0) continue;
    eligible++;
    const extraLeft = Math.max(0,left-x);
    const extraRight = Math.max(0,x+w-right);
    if (extraLeft <= EPSILON && extraRight <= EPSILON) continue;
    candidateCount++;
    if (extraLeft > EPSILON) leftOverflowCount++;
    if (extraRight > EPSILON) rightOverflowCount++;
    const overflow = Math.ceil(Math.max(extraLeft,extraRight));
    biggestOverflow = Math.max(biggestOverflow,overflow);
    byTag[tag] = (byTag[tag] || 0) + 1;
    // Never send selectors, attributes, text, sources, titles or URLs.
    const candidate = { tag, side:extraLeft > EPSILON && extraRight > EPSILON ? 'both' :
      extraLeft > EPSILON ? 'left' : 'right', overflow_px:overflow,
      bounds: { x, y, width:w, height:h } };
    if (top.length < MAX_CANDIDATES) top.push(candidate);
    else {
      let smallest = 0;
      for (let j=1; j<top.length; j++) if (top[j].overflow_px < top[smallest].overflow_px) smallest = j;
      if (candidate.overflow_px > top[smallest].overflow_px) top[smallest] = candidate;
    }
  }
  top.sort((a,b)=>b.overflow_px-a.overflow_px);
  return {
    viewport_width_px:width,
    sampled_layout_nodes:count,
    eligible_elements:eligible,
    candidate_count:candidateCount,
    left_overflow_count:leftOverflowCount,
    right_overflow_count:rightOverflowCount,
    maximum_overflow_px:biggestOverflow,
    by_tag:Object.fromEntries(Object.entries(byTag).sort((a,b)=>b[1]-a[1]).slice(0,20)),
    candidates:top,
    frames_omitted:Math.max(0,rawDocs.length-1),
    truncated:count<indices.length || count<bounds.length,
    note:'Only numeric geometry and allowlisted HTML tag types leave the device. Candidate bounds may be intentional (for example carousels or offscreen animations); this is not proof of a layout bug. Only the main frame is inspected.',
  };
}
export async function inspectDomGeometry(session) {
  // Fetch just enough geometry for local assessment. The CDP transport enforces
  // its own 16 MiB message bound; snapshot text never leaves this process.
  const [metrics,snapshot] = await Promise.all([
    session.send('Page.getLayoutMetrics'),
    session.send('DOMSnapshot.captureSnapshot',{
      computedStyles:[],includePaintOrder:false,includeDOMRects:false,
    }),
  ]);
  return {action:'geometry',geometry:summarizeDomGeometry(snapshot,metrics)};
}
