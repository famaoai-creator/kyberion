/**
 * Opens the provider-consent popup. Passing `noopener` in the feature list of
 * `window.open` makes the call return null, which would lose the handle needed
 * to navigate the popup to the authorization URL or close it on failure;
 * clearing `opener` by hand keeps the same protection while keeping the handle.
 */
export function openServiceConsentWindow(): Window | null {
  const popup = window.open('', '_blank');
  if (popup) popup.opener = null;
  return popup;
}
