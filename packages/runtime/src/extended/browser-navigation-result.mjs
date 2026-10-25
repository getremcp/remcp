// Page.navigate may resolve successfully while Chrome explicitly reports a
// navigation error. Treat that as a failed tool call, without echoing CDP's
// errorText (which may contain user data) into diagnostics.
export function requireSuccessfulBrowserNavigation(result) {
  if (typeof result?.errorText === 'string' && result.errorText.trim()) {
    throw new Error('Browser navigation failed: Chrome reported an unsuccessful navigation');
  }
}
