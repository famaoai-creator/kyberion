'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { renderMessage } from '@agent/core/message-format';
import { A2UIActionProvider, NavRail, useA2UIActions } from '@agent/shared-ui';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText } from '../lib/i18n';
import { attachFrontDeskAuthHeaders, isLoopbackHostname } from '../lib/front-desk-auth-token';

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
  id: 'home' | 'ask' | 'decide' | 'progress' | 'settings';
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
    return window.localStorage.getItem(TENANT_STORAGE_KEY);
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
const RAIL_ICONS: Record<FrontDeskNavItemPayload['id'], string> = {
  home: 'home',
  ask: 'chat',
  decide: 'approval',
  progress: 'chart',
  settings: 'settings',
};

/** `/` -> decide, `/setup` or `/settings` -> settings; every other path has no current rail item. */
function currentItemId(pathname: string | null): FrontDeskNavItemPayload['id'] | null {
  if (pathname === '/') return 'decide';
  if (pathname === '/setup' || pathname === '/settings') return 'settings';
  return null;
}

export function FrontDeskRail() {
  const { locale, t } = useConciergeI18n();
  const pathname = usePathname();
  const [nav, setNav] = React.useState<FrontDeskNavResponse | null>(null);
  const [me, setMe] = React.useState<FrontDeskMeResponse | null>(null);

  const fetchMe = React.useCallback((tenant?: string | null) => {
    const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    fetch(`/api/me${query}`, { headers: attachFrontDeskAuthHeaders() })
      .then((res) => {
        // FD-07 item 7: a remote (non-loopback) request with no/invalid
        // token gets 401 from /api/me — send it to the "どなたですか？"
        // sign-in screen. Loopback is server-bound and never 401s for a
        // missing token, so this branch never fires there.
        if (
          res.status === 401 &&
          typeof window !== 'undefined' &&
          !isLoopbackHostname(window.location.hostname) &&
          window.location.pathname !== '/signin'
        ) {
          window.location.assign('/signin');
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: FrontDeskMeResponse | null) => {
        if (data?.ok) setMe(data);
      })
      .catch(() => {
        // The rail degrades to "no tenant block" — it must never block the
        // 5-item menu from rendering.
      });
  }, []);

  React.useEffect(() => {
    // A slower response for the previous locale must not overwrite the
    // current one after a language switch.
    let current = true;
    fetch(`/api/front-desk/nav?locale=${locale}`, { headers: attachFrontDeskAuthHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FrontDeskNavResponse | null) => {
        if (current && data?.ok) setNav(data);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [locale]);

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
      storeTenant(payload.value);
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

  // UI-05: `ui:nav-rail` — the 5 human-verb items (role-gated by
  // `allowed`, unchanged) with the current one marked `aria-current="page"`
  // by NavRail, 資料の取込 + help in the footer.
  const items = (nav?.items || [])
    .filter((item) => item.allowed)
    .map((item) => ({
      id: item.id,
      label: item.label,
      hint: item.sublabel,
      href: item.href,
      icon: RAIL_ICONS[item.id],
      active: item.id === current,
    }));
  const footerItems = [
    // FD-03 will fold this into the 頼む (ask) request templates; until
    // then, ingest keeps its own reachable entry point here.
    { id: 'ingest', label: t('header.ingest'), href: '/ingest', icon: 'folder' },
    ...(nav ? [{ id: 'help', label: nav.help.label, href: nav.help.href, icon: 'help' }] : []),
  ];

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
        footer_items={footerItems}
      />
    </A2UIActionProvider>
  );
}
