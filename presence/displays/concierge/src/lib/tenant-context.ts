/**
 * The rail's company switcher. The selection travels as the page URL's
 * `?tenant=` and the `kyberion_selected_tenant` cookie; both are hints only.
 * The server re-validates them against the viewer's allowed tenants on every
 * request (`selected-tenant.ts`) and narrows what each route reads — it never
 * widens what the viewer is allowed to see.
 */
export const TENANT_CHANGED_EVENT = 'front-desk:tenant-changed';

/** Query parameter carrying the selection (also each route's narrowing hint). */
export const SELECTED_TENANT_PARAM = 'tenant';
/** Cookie carrying the selection between page loads. Holds a slug or `personal`, nothing else. */
export const SELECTED_TENANT_COOKIE = 'kyberion_selected_tenant';
/**
 * The personal aggregate. `personal` is a reserved tier name, so it can never
 * collide with a tenant slug.
 */
export const PERSONAL_SELECTION = 'personal';
/**
 * Company-less (system-scope) items, for viewers whose scope is all
 * companies. `shared` is a reserved partition name, so it can never collide
 * with a tenant slug.
 */
export const SYSTEM_SELECTION = 'shared';

const SELECTION_VALUE = /^[a-z][a-z0-9-]{1,30}$/;
const SELECTION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

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

function readSelectionCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of String(document.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0 || part.slice(0, index).trim() !== SELECTED_TENANT_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return SELECTION_VALUE.test(value) ? value : null;
  }
  return null;
}

/** Writes the selection cookie (slug or `personal`). Malformed values are never written. */
export function writeSelectionCookie(value: string): void {
  if (typeof document === 'undefined' || !SELECTION_VALUE.test(value)) return;
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${SELECTED_TENANT_COOKIE}=${value}; Path=/; SameSite=Lax; ` +
    `Max-Age=${SELECTION_COOKIE_MAX_AGE_SECONDS}${secure}`;
}

/** The raw selection hint: the page URL first, then the cookie. May be `personal`. */
export function readTenantSelection(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get(SELECTED_TENANT_PARAM);
  if (fromUrl) return fromUrl;
  return readSelectionCookie();
}

/**
 * The selected company slug, or null in the personal or system view. Scope is
 * validated by every API.
 */
export function readSelectedTenant(): string | null {
  const selection = readTenantSelection();
  return selection && selection !== PERSONAL_SELECTION && selection !== SYSTEM_SELECTION
    ? selection
    : null;
}

/** The well-formed `?tenant=` of this page's own URL, ignoring the cookie. */
export function selectionFromPageUrl(): string | null {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  const fromUrl = new URLSearchParams(window.location.search).get(SELECTED_TENANT_PARAM);
  return fromUrl && SELECTION_VALUE.test(fromUrl) ? fromUrl : null;
}

/**
 * Makes the page URL win over a stale cookie before an API request, so the
 * server sees the selection the address bar shows. The cookie is shared by
 * every tab, so a long-lived request (the event stream) carries the page's
 * own `?tenant=` instead of relying on it.
 */
export function syncSelectionCookieFromUrl(): void {
  const fromUrl = selectionFromPageUrl();
  if (fromUrl && fromUrl !== readSelectionCookie()) {
    writeSelectionCookie(fromUrl);
  }
}

/** Shows the server-resolved selection in the address bar and cookie without reloading. */
export function reflectResolvedSelection(value: string): void {
  if (typeof window === 'undefined' || !SELECTION_VALUE.test(value)) return;
  writeSelectionCookie(value);
  const url = new URL(window.location.href);
  if (url.searchParams.get(SELECTED_TENANT_PARAM) === value) return;
  url.searchParams.set(SELECTED_TENANT_PARAM, value);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

/**
 * The URL a switch navigates to: the same page with the new selection and no
 * organization/project of the previous company.
 */
export function selectionSwitchHref(href: string, value: string): string {
  const url = new URL(href);
  for (const key of ['organizationId', 'projectId', 'organization_id', 'project_id']) {
    url.searchParams.delete(key);
  }
  url.searchParams.set(SELECTED_TENANT_PARAM, value);
  return url.pathname + url.search + url.hash;
}

/**
 * Switches company (or to the personal view). A full navigation makes every
 * screen fetch again under the new server-validated scope.
 */
export function switchTenantSelection(value: string): void {
  if (typeof window === 'undefined' || !SELECTION_VALUE.test(value)) return;
  writeSelectionCookie(value);
  window.location.assign(selectionSwitchHref(window.location.href, value));
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
