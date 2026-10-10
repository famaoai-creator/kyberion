'use client';

import { frontDeskFetch as fetch } from '../lib/front-desk-fetch';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { renderMessage } from '@agent/core/message-format';
import { A2UIActionProvider, NavRail, useA2UIActions } from '@agent/shared-ui';
import {
  announceTenantChange,
  readSelectedTenant,
  withSelectedTenant,
} from '../lib/tenant-context';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText } from '../lib/i18n';
import { getStoredFrontDeskToken, isLoopbackHostname } from '../lib/front-desk-auth-token';

/**
 * FD-00c/FD-01c — the shared front-desk rail (plan §2.1/§2.2/§3 FD-00/FD-01).
 * Client-only: it fetches its own data (`/api/front-desk/nav`, `/api/me`)
 * so `layout.tsx` can mount it unconditionally without adding a server
 * round-trip to every concierge page.
 *
 * UI-05: rendered with the shared `NavRail` (`ui:nav-rail`). Every item is
 * a same-tab link — never a new-window/new-tab target, no popup window.
 * Links go through the shell's `next/link` adapter, so items hosted on
 * concierge itself (decide / settings) route client-side and cross-surface
 * items (home / ask / progress on presence-studio) are plain navigations.
 */

const TENANT_STORAGE_KEY = 'front-desk.tenant';
/** `ui:nav-rail` context switcher action (payload `{ value: tenant_slug }`). */
const TENANT_SWITCH_ACTION = 'tenant.switch';

interface FrontDeskNavItemPayload {
  id: string;
  group_label: string;
  icon: string;
  scope_query_style: 'snake' | 'camel';
  label: string;
  sublabel: string;
  href: string;
  external: boolean;
  allowed: boolean;
  min_role: 'owner' | 'approver' | 'operator' | 'viewer';
}

interface FrontDeskNavResponse {
  ok: true;
  locale: 'ja' | 'en';
  current_surface: 'concierge';
  items: FrontDeskNavItemPayload[];
  help: { label: string; href: string };
  brand_tagline: string;
  aria_label: string;
  tenant_switch_aria: string;
  role_labels: { owner: string; approver: string; operator: string; viewer: string };
  tenant_viewing_summary: string;
  tenant_viewing_single: string;
}

interface FrontDeskTenantView {
  tenant_slug: string;
  display_name: string;
  role: 'owner' | 'approver' | 'operator' | 'viewer';
  status: 'active' | 'suspended' | 'archived';
}

interface FrontDeskMeResponse {
  ok: true;
  viewing: FrontDeskTenantView | null;
  tenants: FrontDeskTenantView[];
  can_switch: boolean;
}

function readStoredTenant(): string | null {
  try {
    return readSelectedTenant();
  } catch {
    return null;
  }
}

function storeTenant(slug: string): void {
  try {
    window.localStorage.setItem(TENANT_STORAGE_KEY, slug);
  } catch {
    // best-effort only — a switch that cannot persist still redraws once.
  }
}

/**
 * UI-05: rail item id to shared-ui icon name (`KB_ICON_PATHS`). The
 * presence-studio rail (vanilla renderer) uses the same mapping, so both
 * front-desk surfaces render the same `.kb-nav-rail` markup.
 */

/** Settings subpages share its current marker; first-run bootstrap remains outside feature navigation. */
export function currentItemId(pathname: string | null): FrontDeskNavItemPayload['id'] | null {
  if (pathname === '/') return 'decide';
  if (pathname === '/ingest') return 'ingest';
  if (pathname === '/management') return 'organization';
  if (pathname === '/setup/first-run') return null;
  if (pathname === '/setup' || pathname?.startsWith('/setup/') || pathname === '/settings')
    return 'settings';
  return null;
}

export function FrontDeskRail() {
  return (
    <React.Suspense fallback={null}>
      <FrontDeskRailContent />
    </React.Suspense>
  );
}

function FrontDeskRailContent() {
  const { locale } = useConciergeI18n();
  const pathname = usePathname();
  // Management changes hierarchy with native replaceState on the same path.
  // Subscribe to Next's query context so rail hrefs follow those selections.
  useSearchParams();
  const [nav, setNav] = React.useState<FrontDeskNavResponse | null>(null);
  const [me, setMe] = React.useState<FrontDeskMeResponse | null>(null);
  const selectionGeneration = React.useRef(0);

  const fetchMe = React.useCallback((tenant?: string | null) => {
    const generation = ++selectionGeneration.current;
    setNav(null);
    setMe(null);
    const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    return fetch(`/api/me${query}`, { cache: 'no-store' })
      .then((res) => {
        // A rejected bearer requires sign-in even on loopback. Never discard it
        // and retry as the anonymous local operator.
        if (
          res.status === 401 &&
          typeof window !== 'undefined' &&
          (getStoredFrontDeskToken() || !isLoopbackHostname(window.location.hostname)) &&
          window.location.pathname !== '/signin' &&
          window.location.pathname !== '/login' &&
          window.location.pathname !== '/setup/first-run'
        ) {
          const next = `${window.location.pathname}${window.location.search}`;
          const signin = getStoredFrontDeskToken() ? '/signin' : '/login';
          window.location.assign(
            next === '/' ? signin : `${signin}?next=${encodeURIComponent(next)}`
          );
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: FrontDeskMeResponse | null) => {
        if (generation !== selectionGeneration.current) return;
        if (data?.ok && (!tenant || data.viewing?.tenant_slug === tenant)) {
          setMe(data);
          if (data.viewing && (!tenant || tenant === data.viewing.tenant_slug)) {
            storeTenant(data.viewing.tenant_slug);
            announceTenantChange(data.viewing.tenant_slug);
          }
        }
      })
      .catch(() => {
        // The rail degrades to "no tenant block" — it must never block the
        // navigation from rendering.
      });
  }, []);

  React.useEffect(() => {
    // A slower response for the previous locale must not overwrite the
    // current one after a language switch.
    let current = true;
    const generation = selectionGeneration.current;
    setNav(null);
    if (!me) return;
    fetch(withSelectedTenant(`/api/front-desk/nav?locale=${locale}`, me.viewing?.tenant_slug), {})
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FrontDeskNavResponse | null) => {
        if (current && generation === selectionGeneration.current && data?.ok) setNav(data);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [locale, me]);

  React.useEffect(() => {
    let storedTenant: string | null = null;
    try {
      storedTenant = readStoredTenant();
    } catch {
      storedTenant = null;
    }
    fetchMe(storedTenant);
  }, [fetchMe]);

  // The shell's provider supplies `next/link`; keep it for the rail items.
  const outerActions = useA2UIActions();
  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId !== TENANT_SWITCH_ACTION || typeof payload?.value !== 'string') return;
      fetchMe(payload.value);
    },
    [fetchMe]
  );

  const current = currentItemId(pathname);
  const roleLabel = (role: FrontDeskTenantView['role'] | undefined) =>
    role && nav ? nav.role_labels[role] : '';

  // `frontDeskText` reads the same client-bundled vocabulary catalog `t()`
  // uses (no fetch) — an instant, synchronous fallback so the rail's brand
  // block and aria-label are never blank while `/api/front-desk/nav` is
  // still loading.
  const ariaLabel = nav?.aria_label || frontDeskText('nav_aria_label', locale);
  const brandTagline = nav?.brand_tagline || frontDeskText('brand_tagline', locale);

  // UI-05: `ui:nav-rail` — the grouped existing destinations (role-gated by
  // `allowed`, unchanged) with the current one marked `aria-current="page"`
  // by NavRail.
  const items = (nav?.items || [])
    .filter((item) => item.allowed)
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.sublabel,
      href: withSelectedTenant(item.href, me?.viewing?.tenant_slug, item.scope_query_style),
      icon: item.icon,
      group_label: item.group_label,
      active: item.id === current,
    }));

  // UI-05: the brand and tenant blocks are the shared `ui:nav-rail`
  // `brand` / `context` slots (same markup and CSS as the presence-studio
  // rail). The tenant block appears only once a tenant is actually being
  // viewed — an empty name/role block reads as broken. With more than one
  // tenant it is a switcher whose `tenant.switch` action carries the slug.
  const context =
    nav && me?.viewing
      ? {
          label: me.viewing.display_name || me.viewing.tenant_slug,
          detail: me.can_switch
            ? renderMessage(nav.tenant_viewing_summary, {
                role: roleLabel(me.viewing.role),
                count: me.tenants.length,
              })
            : renderMessage(nav.tenant_viewing_single, { role: roleLabel(me.viewing.role) }),
          switch_label: nav.tenant_switch_aria,
          ...(me.can_switch
            ? {
                action: { id: TENANT_SWITCH_ACTION },
                options: me.tenants.map((tenant) => ({
                  value: tenant.tenant_slug,
                  label: tenant.display_name,
                  selected: tenant.tenant_slug === me.viewing?.tenant_slug,
                })),
              }
            : {}),
        }
      : undefined;

  return (
    <A2UIActionProvider
      onAction={onAction}
      linkComponent={outerActions.linkComponent}
      navigate={outerActions.navigate}
    >
      <NavRail
        label={ariaLabel}
        brand={{ name: 'Kyberion', subtitle: brandTagline }}
        context={context}
        items={items}
      />
    </A2UIActionProvider>
  );
}
