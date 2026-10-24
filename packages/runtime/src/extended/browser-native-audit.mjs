// Read-only, native CDP audits. Only numeric aggregates leave the device.
// Unlike DOM snapshots, these methods do not transmit page text to ReMCP.
const CONTROL_ROLES = new Set([
  'button','link','checkbox','radio','switch','textbox','searchbox','combobox',
  'menuitem','menuitemcheckbox','menuitemradio','tab','slider','spinbutton',
]);
const REPORT_ROLES = new Set([
  ...CONTROL_ROLES, 'heading','image','img','form','table','dialog','alert',
  'navigation','main','region','list','listitem','row','cell',
]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) ? Math.max(0,Math.min(10_000_000, Math.round(value * 100) / 100)) : 0;

export function normalizeLayoutMetrics(result = {}) {
  const viewport = result.cssLayoutViewport || {};
  const visual = result.cssVisualViewport || {};
  const content = result.cssContentSize || {};
  const clientWidth = positive(viewport.clientWidth);
  const clientHeight = positive(viewport.clientHeight);
  const contentWidth = positive(content.width);
  const contentHeight = positive(content.height);
  return {
    viewport: { width:clientWidth, height:clientHeight, page_x:positive(viewport.pageX), page_y:positive(viewport.pageY) },
    visual_viewport: {
      width:positive(visual.clientWidth), height:positive(visual.clientHeight),
      scale:finite(visual.scale) ? Math.max(0,Math.min(100,visual.scale)) : null,
    },
    document: { width:contentWidth, height:contentHeight },
    horizontal_overflow_px:Math.max(0,Math.ceil(contentWidth-clientWidth)),
    vertical_scroll_px:Math.max(0,Math.ceil(contentHeight-clientHeight)),
    note:'Native CSS-pixel layout metrics from the current page. Overflow measures the document bounds, not whether a particular element is visually clipped.',
  };
}
export function summarizeAccessibilityTree(nodes, { depth = 6 } = {}) {
  const bounded = (Array.isArray(nodes) ? nodes : []).slice(0, 5000);
  const roles = {};
  let ignored = 0, interactive = 0, unlabeledControls = 0, unnamedImages = 0;
  let headings = 0;
  const headingLevels = {};
  for (const node of bounded) {
    if (!node || typeof node !== 'object') continue;
    if (node.ignored === true) { ignored++; continue; }
    const role = String(node.role?.value || '').toLowerCase();
    if (!REPORT_ROLES.has(role)) continue;
    roles[role] = (roles[role] || 0) + 1;
    const name = String(node.name?.value || '').trim();
    if (CONTROL_ROLES.has(role)) {
      interactive++;
      // Anonymous count only: actual labels, element identifiers and URLs are never returned.
      if (!name) unlabeledControls++;
    }
    if (role === 'image' || role === 'img') {
      if (!name) unnamedImages++;
    }
    if (role === 'heading') {
      headings++;
      const level = node.properties?.find(item => item?.name === 'level')?.value?.value;
      if (Number.isSafeInteger(level) && level >= 1 && level <= 6)
        headingLevels[level] = (headingLevels[level] || 0) + 1;
    }
  }
  return {
    sampled_nodes:bounded.length, ignored_nodes:ignored, requested_depth:depth,
    roles, interactive_controls:interactive, unlabeled_controls:unlabeledControls,
    headings, heading_levels:headingLevels, unnamed_images:unnamedImages,
    truncated: Array.isArray(nodes) && nodes.length > bounded.length,
    note:'Bounded native accessibility tree sample. These are diagnostic candidates, not a WCAG compliance verdict. Nodes deeper than the requested depth are not inspected.',
  };
}
export async function inspectNativeBrowserAudit(session, action) {
  if (action === 'layout') {
    const result = await session.send('Page.getLayoutMetrics');
    return { action, layout:normalizeLayoutMetrics(result) };
  }
  if (action === 'accessibility') {
    const depth = 6;
    const result = await session.send('Accessibility.getFullAXTree',{depth});
    return { action, accessibility:summarizeAccessibilityTree(result.nodes,{depth}) };
  }
  throw new Error('Unsupported native browser audit mode');
}
