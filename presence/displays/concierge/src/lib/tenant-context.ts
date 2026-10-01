/**
 * The rail's organization switcher announces an explicit switch so screens
 * that can narrow by organization follow it. It is a display preference only:
 * it narrows what is shown, never what the viewer is allowed to see (the server
 * resolves scope itself). Initial load never applies it, so nothing is hidden
 * until the viewer switches.
 */
export const TENANT_CHANGED_EVENT = 'front-desk:tenant-changed';

export function announceTenantChange(tenantSlug: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TENANT_CHANGED_EVENT, { detail: { tenant: tenantSlug } }));
}

export function tenantFromChangeEvent(event: Event): string | null {
  const detail = (event as CustomEvent<{ tenant?: unknown }>).detail;
  return typeof detail?.tenant === 'string' && detail.tenant ? detail.tenant : null;
}
