// Only trusted internal DOM code is evaluated on the exact guarded CDP tab.
// Text locators must not silently pick <body> or the first matching account.
export const PAGE_TEXT_TARGET = `function(needle, action) {
  const norm = text => String(text ?? '').replace(/\\s+/g,' ').trim().toLocaleLowerCase();
  const wanted = norm(needle);
  if (!wanted || wanted.length > 512) throw new Error('Text locator is invalid');
  const editable = ['type','type_clear','set_value','select','read_value'].includes(action);
  const selection = editable ?
    'input,textarea,select,[contenteditable="true"]' :
    'button,a,summary,label,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="option"],[tabindex]';
  const visible = node => {
    if (!node || node.isConnected === false || node.disabled === true ||
        node.getAttribute?.('aria-disabled') === 'true' ||
        !node.getClientRects?.().length ||
        node.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    return style?.visibility !== 'hidden' && style?.visibility !== 'collapse' &&
      style?.display !== 'none';
  };
  const names = node => [
    node.getAttribute?.('aria-label'), node.getAttribute?.('title'),
    node.getAttribute?.('placeholder'),
    node.innerText ?? node.textContent,
    node.tagName === 'INPUT' && ['button','submit','reset'].includes(
      String(node.type || '').toLowerCase()) ? node.value : '',
  ].map(norm).filter(Boolean);
  const pick = nodes => {
    if (nodes.length > 5000) throw new Error('Text locator inventory too large');
    const matches = nodes.filter(node =>
      names(node).some(name => name.includes(wanted)));
    const exact = matches.filter(node => names(node).some(name => name === wanted));
    if (exact.length) {
      const actionable = exact.filter(visible);
      if (actionable.length > 1) throw new Error('Text locator is ambiguous');
      if (actionable.length === 0)
        throw new Error('Text locator exact target is unavailable');
      return actionable[0];
    }
    const actionable = matches.filter(visible);
    if (actionable.length > 1) throw new Error('Text locator is ambiguous');
    return actionable[0] || null;
  };
  const interactive = pick(Array.from(document.querySelectorAll(selection)));
  if (interactive) return interactive;
  if (!['scroll','scroll_into_view'].includes(action))
    throw new Error('Text locator needs an exact visible interactive element');
  // Support read-only headings and generic scroll targets, without matching
  // every ancestor (html/body) containing that descendant's text.
  const leaves = Array.from(document.querySelectorAll('*')).filter(node => {
    if (!visible(node)) return false;
    if (!names(node).some(name => name.includes(wanted))) return false;
    return !Array.from(node.children || []).some(child =>
      names(child).some(name => name.includes(wanted)));
  });
  const match = pick(leaves);
  if (!match) throw new Error('Text locator did not match a visible element');
  return match;
}`;
