'use client';

import { useSettingsExitGuard } from '../lib/settings-exit-guard';
import { frontDeskFetch as fetch } from '../lib/front-desk-fetch';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { renderMessage } from '@agent/core/message-format';
import { A2UIActionProvider, Dialog, NavRail, useA2UIActions } from '@agent/shared-ui';
import {
  railSelectionValue,
  railSwitcherOptions,
  type RailSelection,
  type RailSwitcherPayload,
} from '../lib/rail-switcher';
import {
  WORKSPACE_DESTINATION_EVENT,
  TENANT_CHANGED_EVENT,
  needsWorkspaceSelection,
  workspaceDestinationHref,
  readTenantSelection,
  reflectResolvedSelection,
  switchTenantSelection,
  selectionSwitchHref,
  withSelectedTenant,
} from '../lib/tenant-context';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../lib/i18n';
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

/** `ui:nav-rail` context switcher action (payload `{ value: tenant_slug | 'personal' | 'shared' }`). */
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
  placement?: 'main' | 'footer';
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
  /** The server-validated selection for this request (URL/cookie are only hints). */
  selection?: RailSelection;
  switcher?: RailSwitcherPayload;
}

/**
 * UI-05: rail item id to shared-ui icon name (`KB_ICON_PATHS`). The
 * presence-studio rail (vanilla renderer) uses the same mapping, so both
 * front-desk surfaces render the same `.kb-nav-rail` markup.
 */

/**
 * The rail entry a route belongs to (MSN-SHELL-IA §1): each of the seven
 * destinations owns its own path and the detail pages folded under it.
 * Settings subpages share its marker; first-run bootstrap stays outside
 * feature navigation.
 */
export function currentItemId(
  pathname: string | null,
  _section?: string | null
): FrontDeskNavItemPayload['id'] | null {
  if (!pathname) return null;
  if (pathname === '/') return 'home';
  if (pathname === '/setup/first-run') return null;
  if (pathname === '/setup' || pathname.startsWith('/setup/') || pathname === '/settings')
    return 'settings';
  if (pathname === '/management' || pathname.startsWith('/management/')) return 'org';
  if (pathname === '/ingest') return 'library';
  for (const id of ['inbox', 'work', 'org', 'library', 'ops'] as const) {
    if (pathname === `/${id}` || pathname.startsWith(`/${id}/`)) return id;
  }
  return workspaceItemId(pathname);
}

/** `/w/<kind>/<id>` detail pages mark the destination their kind lives under. */
const WORKSPACE_RAIL_IDS: Record<string, string> = {
  tenant: 'org',
  organization: 'org',
  project: 'org',
  actor: 'org',
  mission: 'work',
  task: 'work',
  work_item: 'work',
  approval: 'inbox',
};
function workspaceItemId(pathname: string): string | null {
  if (pathname !== '/w' && !pathname.startsWith('/w/')) return null;
  const kind = pathname.split('/')[2];
  return kind ? (WORKSPACE_RAIL_IDS[kind] ?? 'home') : 'home';
}

/**
 * A label the server could not resolve comes back as its own key
 * (`front_desk:ia_nav_home`) — e.g. a runtime whose knowledge root predates
 * a new destination. Render it from the client-bundled catalog instead of
 * showing the raw key; anything else passes through unchanged.
 */
const RAIL_KEY = /^front_desk:([a-z0-9_]+)$/;
export function railLabel(text: string, locale: ConciergeLocale): string {
  const match = text.match(RAIL_KEY);
  if (!match) return text;
  const resolved = frontDeskText(match[1] as FrontDeskMessageKey, locale);
  return resolved && resolved !== text && resolved !== match[1] ? resolved : '';
}

/** Rail id that carries the needs-you count badge. */
export const NEEDS_YOU_RAIL_ID = 'inbox';

/**
 * `GET /api/v1/needs-you/summary` returns `total` (MSN-SHELL-IA §2). Anything but
 * an ok payload with a finite, non-negative `total` hides the badge — the
 * rail never shows a guessed or stale-looking count.
 */
export function needsYouBadgeTotal(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { ok?: unknown; total?: unknown };
  if (record.ok !== true) return null;
  const total = record.total;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : null;
}

/** Badge text: hidden at zero, capped so the rail width never changes. */
export function needsYouBadgeText(total: number | null): string | undefined {
  if (total === null || total <= 0) return undefined;
  return total > 99 ? '99+' : String(total);
}

function useNeedsYouTotal(enabled: boolean, scopeKey: string | null): number | null {
  const [total, setTotal] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!enabled) {
      setTotal(null);
      return undefined;
    }
    const controller = new AbortController();
    const load = () =>
      fetch(withSelectedTenant('/api/v1/needs-you/summary', scopeKey), {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: unknown) => {
          if (!controller.signal.aborted) setTotal(needsYouBadgeTotal(data));
        })
        .catch(() => {
          if (!controller.signal.aborted) setTotal(null);
        });
    void load();
    // A decision elsewhere lowers the count; refresh when the tab returns.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, scopeKey]);
  return total;
}

export function FrontDeskRail() {
  return (
    <React.Suspense fallback={null}>
      <FrontDeskRailContent />
    </React.Suspense>
  );
}

function FrontDeskRailContent() {
  const { requestLeave } = useSettingsExitGuard();
  const { locale } = useConciergeI18n();
  const pathname = usePathname();
  // Management changes hierarchy with native replaceState on the same path.
  // Subscribe to Next's query context so rail hrefs follow those selections.
  const searchParams = useSearchParams();
  const [nav, setNav] = React.useState<FrontDeskNavResponse | null>(null);
  const [me, setMe] = React.useState<FrontDeskMeResponse | null>(null);
  const selectionGeneration = React.useRef(0);
  const [navigationUnavailable, setNavigationUnavailable] = React.useState(false);
  const [destinationId, setDestinationId] = React.useState<string | null>(null);
  const latestScope = React.useRef({ nav, me });
  latestScope.current = { nav, me };

  const fetchMe = React.useCallback(() => {
    const generation = ++selectionGeneration.current;
    setDestinationId(null);
    setNavigationUnavailable(false);
    setNav(null);
    setMe(null);
    return fetch('/api/me', { cache: 'no-store' })
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
        if (data?.ok) {
          setMe(data);
          // Show what the server actually resolved; a refused hint is replaced.
          if (data.selection) reflectResolvedSelection(railSelectionValue(data.selection));
        } else setNavigationUnavailable(true);
      })
      .catch(() => {
        if (generation === selectionGeneration.current) setNavigationUnavailable(true);
      });
  }, []);

  React.useEffect(() => {
    // A slower response for the previous locale must not overwrite the
    // current one after a language switch.
    let current = true;
    const generation = selectionGeneration.current;
    setNav(null);
    if (!me) return;
    setNavigationUnavailable(false);
    fetch(withSelectedTenant(`/api/front-desk/nav?locale=${locale}`, me.viewing?.tenant_slug), {})
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FrontDeskNavResponse | null) => {
        if (current && generation === selectionGeneration.current) {
          if (data?.ok) setNav(data);
          else setNavigationUnavailable(true);
        }
      })
      .catch(() => {
        if (current && generation === selectionGeneration.current) setNavigationUnavailable(true);
      });
    return () => {
      current = false;
    };
  }, [locale, me]);

  React.useEffect(() => {
    void fetchMe();
    const refresh = () => {
      void fetchMe();
    };
    window.addEventListener('popstate', refresh);
    window.addEventListener(TENANT_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('popstate', refresh);
      window.removeEventListener(TENANT_CHANGED_EVENT, refresh);
    };
  }, [fetchMe]);

  React.useEffect(() => {
    const request = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      // A palette request can arrive while /api/me is still loading. Keep only
      // its bounded catalog id; resolve the allowed destination before navigation.
      if (typeof id === 'string' && /^[a-z][a-z-]{0,63}$/.test(id)) setDestinationId(id);
    };
    window.addEventListener(WORKSPACE_DESTINATION_EVENT, request);
    return () => window.removeEventListener(WORKSPACE_DESTINATION_EVENT, request);
  }, []);

  // The shell's provider supplies `next/link`; keep it for the rail items.
  const outerActions = useA2UIActions();
  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId === 'workspace.cancel') {
        setDestinationId(null);
        return;
      }
      if (actionId === 'workspace.open' && typeof payload?.id === 'string') {
        const item = nav?.items.find(
          (candidate) => candidate.id === payload.id && candidate.allowed
        );
        if (
          item &&
          needsWorkspaceSelection(
            item.href,
            me?.selection ? railSelectionValue(me.selection) : (me?.viewing?.tenant_slug ?? null),
            item.external
          )
        )
          setDestinationId(item.id);
        return;
      }
      if (actionId === 'workspace.choose') {
        const choice = payload?.choice;
        if (choice === 'cancel') {
          setDestinationId(null);
          return;
        }
        const company = me?.switcher?.companies.find(
          (item) => 'tenant:' + item.tenant_slug === choice
        );
        const item = nav?.items.find(
          (candidate) => candidate.id === destinationId && candidate.allowed
        );
        // The choice is navigation, never authorization. The destination validates its viewer again.
        if (
          !company ||
          !item ||
          !me?.selection ||
          readTenantSelection() !== railSelectionValue(me.selection)
        ) {
          setDestinationId(null);
          return;
        }
        const sourceSelection = readTenantSelection();
        const intentGeneration = selectionGeneration.current;
        const target = workspaceDestinationHref(item.href, company.tenant_slug);
        setDestinationId(null);
        requestLeave(target, () => {
          const latest = latestScope.current;
          const latestItem = latest.nav?.items.find(
            (candidate) => candidate.id === item.id && candidate.allowed
          );
          if (
            selectionGeneration.current !== intentGeneration ||
            readTenantSelection() !== sourceSelection ||
            !latest.me?.selection ||
            railSelectionValue(latest.me.selection) !== sourceSelection ||
            !latest.me.switcher?.companies.some(
              (candidate) => candidate.tenant_slug === company.tenant_slug
            ) ||
            !latestItem
          )
            return;
          window.location.assign(workspaceDestinationHref(latestItem.href, company.tenant_slug));
        });
        return;
      }
      if (actionId === TENANT_SWITCH_ACTION && typeof payload?.value === 'string') {
        setDestinationId(null);
        const value = payload.value;
        const sourceSelection = readTenantSelection();
        const intentGeneration = selectionGeneration.current;
        requestLeave(selectionSwitchHref(window.location.href, value), () => {
          const latest = latestScope.current.me;
          if (
            selectionGeneration.current !== intentGeneration ||
            readTenantSelection() !== sourceSelection ||
            !latest?.selection ||
            railSelectionValue(latest.selection) !== sourceSelection ||
            !latest.switcher
          )
            return;
          const currentOptions = railSwitcherOptions(latest.selection, latest.switcher, {
            personal: '',
            system: '',
          });
          if (currentOptions.some((option) => option.value === value)) switchTenantSelection(value);
        });
      }
    },
    [nav, me, destinationId, requestLeave]
  );

  const current = currentItemId(pathname, searchParams?.get('section'));
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
  const scopeValue = me?.selection
    ? railSelectionValue(me.selection)
    : (me?.viewing?.tenant_slug ?? null);
  const badgeEnabled = Boolean(
    nav?.items.some((item) => item.id === NEEDS_YOU_RAIL_ID && item.allowed)
  );
  const needsYouTotal = useNeedsYouTotal(badgeEnabled, scopeValue);
  const badgeText = needsYouBadgeText(needsYouTotal);
  const railItems = (nav?.items || [])
    .filter((item) => item.allowed)
    .map((item) => ({
      ...item,
      label: railLabel(item.label, locale),
      sublabel: railLabel(item.sublabel, locale),
    }))
    .map((item) => ({
      placement: item.placement ?? 'main',
      ...(item.id === NEEDS_YOU_RAIL_ID && badgeText
        ? {
            badge: badgeText,
            badge_label: frontDeskText('ia_nav_badge_aria', locale, {
              count: needsYouTotal ?? 0,
            }),
          }
        : {}),
      id: item.id,
      label: item.label,
      hint: needsWorkspaceSelection(
        item.href,
        me?.selection ? railSelectionValue(me.selection) : (me?.viewing?.tenant_slug ?? null),
        item.external
      )
        ? frontDeskText('workspace_destination_hint', locale)
        : item.sublabel,
      ...(needsWorkspaceSelection(
        item.href,
        me?.selection ? railSelectionValue(me.selection) : (me?.viewing?.tenant_slug ?? null),
        item.external
      )
        ? { action: { id: 'workspace.open', payload: { id: item.id } } }
        : {
            href: withSelectedTenant(
              item.href,
              me?.selection ? railSelectionValue(me.selection) : (me?.viewing?.tenant_slug ?? null),
              item.scope_query_style
            ),
          }),
      icon: item.icon,
      group_label: item.group_label,
      active: item.id === current,
    }));
  const items = railItems
    .filter((item) => item.placement !== 'footer')
    .map(({ placement: _placement, ...item }) => item);
  const footerItems = railItems
    .filter((item) => item.placement === 'footer')
    .map(({ placement: _placement, ...item }) => item);

  // UI-05: the brand and tenant blocks are the shared `ui:nav-rail`
  // `brand` / `context` slots (same markup and CSS as the presence-studio
  // rail). The block appears whenever there is somewhere to switch to — even
  // when the selected company has no profile — or a single company is viewed.
  // Options are 個人, the viewer's allowed companies, and システム for
  // all-company viewers; `tenant.switch` carries the value.
  const personalLabel = frontDeskText('tenant_personal_label', locale);
  const systemLabel = frontDeskText('tenant_system_label', locale);
  const options =
    me?.selection && me.switcher
      ? railSwitcherOptions(me.selection, me.switcher, {
          personal: personalLabel,
          system: systemLabel,
        })
      : [];
  const selectedOption = options.find((option) => option.selected);
  const contextDetail = (): string | undefined => {
    if (!me || !nav) return undefined;
    if (me.viewing) {
      return options.length > 1
        ? renderMessage(nav.tenant_viewing_summary, {
            role: roleLabel(me.viewing.role),
            count: me.switcher?.companies.length ?? me.tenants.length,
          })
        : renderMessage(nav.tenant_viewing_single, { role: roleLabel(me.viewing.role) });
    }
    if (me.selection?.mode === 'personal') {
      return frontDeskText('tenant_personal_detail', locale, {
        count: me.switcher?.companies.length ?? me.tenants.length,
      });
    }
    if (me.selection?.mode === 'system') return frontDeskText('tenant_system_detail', locale);
    return undefined;
  };
  const context =
    nav && me && (me.viewing || options.length > 1)
      ? {
          label: me.viewing
            ? me.viewing.display_name || me.viewing.tenant_slug
            : selectedOption?.label || personalLabel,
          detail: contextDetail(),
          switch_label: nav.tenant_switch_aria,
          ...(options.length > 1 ? { action: { id: TENANT_SWITCH_ACTION }, options } : {}),
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
        {...(footerItems.length ? { footer_items: footerItems } : {})}
      />
      <Dialog
        id="workspace-destination"
        open={destinationId !== null}
        title={frontDeskText('workspace_destination_title', locale)}
        message={frontDeskText(
          navigationUnavailable
            ? 'workspace_destination_unavailable'
            : !nav || !me
              ? 'workspace_destination_loading'
              : !nav.items.some((item) => item.id === destinationId && item.allowed)
                ? 'workspace_destination_unavailable'
                : me.switcher?.companies.length
                  ? 'workspace_destination_message'
                  : 'workspace_destination_empty',
          locale,
          {
            destination: nav?.items.find((item) => item.id === destinationId)?.label || '',
          }
        )}
        choices={[
          ...(nav?.items.some((item) => item.id === destinationId && item.allowed)
            ? (me?.switcher?.companies ?? [])
            : []
          ).map((company) => ({
            id: 'tenant:' + company.tenant_slug,
            label: frontDeskText('workspace_destination_continue', locale, {
              workspace: company.display_name || company.tenant_slug,
            }),
          })),
          { id: 'cancel', label: frontDeskText('workspace_destination_cancel', locale) },
        ]}
        action={{ id: 'workspace.choose' }}
        cancel_action={{ id: 'workspace.cancel' }}
      />
    </A2UIActionProvider>
  );
}
