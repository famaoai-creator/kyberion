'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { renderMessage } from '@agent/core/message-format';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText } from '../lib/i18n';
import { attachFrontDeskAuthHeaders, isLoopbackHostname } from '../lib/front-desk-auth-token';

/**
 * FD-00c/FD-01c — the shared front-desk rail (plan §2.1/§2.2/§3 FD-00/FD-01).
 * Client-only: it fetches its own data (`/api/front-desk/nav`, `/api/me`)
 * so `layout.tsx` can mount it unconditionally without adding a server
 * round-trip to every concierge page.
 *
 * Cross-surface items (home / ask / progress on presence-studio) render as
 * plain same-tab `<a>` links — never a new-window/new-tab target, no popup
 * window. Items hosted on concierge itself (decide / settings) use
 * `next/link` for client-side routing, matching the rest of this app.
 */

const TENANT_STORAGE_KEY = 'front-desk.tenant';

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

/** 24-viewBox stroke icons (1.8 stroke-width, round caps) — plan wireframes §2.1. */
function FrontDeskIcon({ id }: { id: FrontDeskNavItemPayload['id'] | 'help' }) {
  const props = {
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (id) {
    case 'home':
      return (
        <svg {...props}>
          <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
        </svg>
      );
    case 'ask':
      return (
        <svg {...props}>
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
      );
    case 'decide':
      return (
        <svg {...props}>
          <path d="M4 12l5 5L20 6" />
        </svg>
      );
    case 'progress':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
        </svg>
      );
    case 'help':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h0" />
        </svg>
      );
    default:
      return null;
  }
}

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
  const [tenantMenuOpen, setTenantMenuOpen] = React.useState(false);

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
    fetch(`/api/front-desk/nav?locale=${locale}`, { headers: attachFrontDeskAuthHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FrontDeskNavResponse | null) => {
        if (data?.ok) setNav(data);
      })
      .catch(() => {});
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

  const handleSelectTenant = React.useCallback(
    (slug: string) => {
      storeTenant(slug);
      setTenantMenuOpen(false);
      fetchMe(slug);
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

  return (
    <nav className="fd-rail" aria-label={ariaLabel}>
      <div className="fd-brand">
        <span className="fd-brand-mark" aria-hidden="true" />
        <div className="fd-brand-text">
          <strong>Kyberion</strong>
          <div className="fd-brand-tagline">{brandTagline}</div>
        </div>
      </div>

      {nav && me?.can_switch !== undefined ? (
        <div className="fd-tenant-block">
          <button
            type="button"
            className="fd-tenant-button"
            aria-label={nav.tenant_switch_aria}
            aria-haspopup={me?.can_switch ? 'listbox' : undefined}
            aria-expanded={me?.can_switch ? tenantMenuOpen : undefined}
            disabled={!me?.can_switch}
            onClick={() => {
              if (me?.can_switch) setTenantMenuOpen((prev) => !prev);
            }}
          >
            <span className="fd-tenant-name">{me?.viewing?.display_name || ''}</span>
            <span className="fd-tenant-summary">
              {me?.can_switch
                ? renderMessage(nav.tenant_viewing_summary, {
                    role: roleLabel(me.viewing?.role),
                    count: me.tenants.length,
                  })
                : renderMessage(nav.tenant_viewing_single, {
                    role: roleLabel(me?.viewing?.role),
                  })}
            </span>
          </button>
          {me?.can_switch && tenantMenuOpen ? (
            <ul className="fd-tenant-list" role="listbox" aria-label={nav.tenant_switch_aria}>
              {me.tenants.map((tenant) => (
                <li key={tenant.tenant_slug} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={tenant.tenant_slug === me.viewing?.tenant_slug}
                    className="fd-tenant-option"
                    onClick={() => handleSelectTenant(tenant.tenant_slug)}
                  >
                    {tenant.display_name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <ul className="fd-items">
        {(nav?.items || [])
          .filter((item) => item.allowed)
          .map((item) => {
            const isCurrent = item.id === current;
            const content = (
              <>
                <FrontDeskIcon id={item.id} />
                <span className="fd-item-text">
                  <span className="fd-item-label">{item.label}</span>
                  <span className="fd-item-sublabel">{item.sublabel}</span>
                </span>
              </>
            );
            return (
              <li key={item.id}>
                {item.external ? (
                  <a
                    href={item.href}
                    className="fd-item"
                    aria-current={isCurrent ? 'page' : undefined}
                  >
                    {content}
                  </a>
                ) : (
                  <Link
                    href={item.href}
                    className="fd-item"
                    aria-current={isCurrent ? 'page' : undefined}
                  >
                    {content}
                  </Link>
                )}
              </li>
            );
          })}
      </ul>

      {/* FD-03 will fold this into the 頼む (ask) request templates; until
          then, ingest keeps its own reachable entry point here. */}
      <Link href="/ingest" className="fd-secondary-link">
        {t('header.ingest')}
      </Link>

      {nav ? (
        <a href={nav.help.href} className="fd-help-link">
          <FrontDeskIcon id="help" />
          <span>{nav.help.label}</span>
        </a>
      ) : null}
    </nav>
  );
}
