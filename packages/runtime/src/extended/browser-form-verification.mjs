// Second independent CDP readback after reactive UI microtasks.
// This is a read-only page function; do not echo form values.
export const PAGE_VERIFY_FORM = `function(fields, expectedOrigin) {
  if (expectedOrigin && location.origin !== expectedOrigin)
    throw new Error('Form origin changed before verification');
  const norm = value => String(value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
  const seen = new Set();
  for (const field of fields) {
    let matches;
    if (field.selector) {
      matches = Array.from(document.querySelectorAll(field.selector));
    } else {
      const wanted = norm(field.label);
      matches = Array.from(document.querySelectorAll('input,textarea,select')).filter(el => {
        const labels = Array.from(el.labels || []).map(label => label.textContent);
        const aria = el.getAttribute?.('aria-label');
        if (aria) labels.push(aria);
        const ids = String(el.getAttribute?.('aria-labelledby') || '').trim().split(/\\s+/).filter(Boolean);
        for (const id of ids) labels.push(document.getElementById(id)?.textContent);
        return labels.some(label => norm(label) === wanted);
      });
    }
    if (matches.length !== 1)
      throw new Error('Form verification target missing or ambiguous');
    const el = matches[0];
    if (seen.has(el) || el.isConnected === false || !el.getClientRects().length ||
        el.disabled || el.readOnly)
      throw new Error('Form verification target changed');
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
    if (!['input','textarea','select'].includes(tag) ||
        (field.expected_tag && field.expected_tag !== tag) ||
        (field.expected_type && field.expected_type !== type))
      throw new Error('Form verification kind changed');
    const checked = tag === 'input' && (type === 'checkbox' || type === 'radio');
    const actual = checked ? Boolean(el.checked) : String(el.value);
    const expected = checked ? Boolean(field.value) : String(field.value);
    if (actual !== expected) throw new Error('Form verification readback mismatch');
  }
  return {verified:true,count:fields.length};
}`;
