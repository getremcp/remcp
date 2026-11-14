// A CDP discovery record can advertise a URL before the page's JS context
// commits navigation. Bind actions to the origin actually discovered, not a
// transient about:blank or an unrelated replacement page.
export function assertLiveTargetOrigin(discoveredUrl, liveUrl) {
  let expected;
  let actual;
  try {
    expected=new URL(discoveredUrl);
    actual=new URL(liveUrl);
  } catch {
    throw new Error('Browser target URL could not be verified before action');
  }
  if (expected.origin !== actual.origin ||
      (expected.protocol === 'about:' && discoveredUrl !== liveUrl)) {
    throw new Error('Browser target origin changed before action; refresh tabs');
  }
}
