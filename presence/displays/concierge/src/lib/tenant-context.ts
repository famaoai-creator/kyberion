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
  const url = new URL(window.location.href);
  if (url.searchParams.get('tenant') !== tenantSlug) {
    url.searchParams.delete('organizationId');
    url.searchParams.delete('projectId');
    url.searchParams.delete('organization_id');
    url.searchParams.delete('project_id');
  }
  url.searchParams.set('tenant', tenantSlug);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  window.dispatchEvent(new CustomEvent(TENANT_CHANGED_EVENT, { detail: { tenant: tenantSlug } }));
}

export function tenantFromChangeEvent(event: Event): string | null {
  const detail = (event as CustomEvent<{ tenant?: unknown }>).detail;
  return typeof detail?.tenant === 'string' && detail.tenant ? detail.tenant : null;
}

/** Scope is a display selection; every API must validate it against its viewer. */
export function readSelectedTenant(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get('tenant');
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem('front-desk.tenant');
  } catch {
    return null;
  }
}

export function withSelectedTenant(
  path: string,
  tenant = readSelectedTenant(),
  scopeQueryStyle: 'snake' | 'camel' = 'camel'
): string {
  if (typeof window === 'undefined') return path;
  const url = new URL(path, window.location.href);
  if (tenant) url.searchParams.set('tenant', tenant);
  const current = new URL(window.location.href);
  for (const [camel, snake] of [
    ['organizationId', 'organization_id'],
    ['projectId', 'project_id'],
  ]) {
    const selected = current.searchParams.get(camel) ?? current.searchParams.get(snake);
    const key = scopeQueryStyle === 'snake' ? snake : camel;
    url.searchParams.delete(scopeQueryStyle === 'snake' ? camel : snake);
    if (selected) url.searchParams.set(key, selected);
  }
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : url.href;
}
