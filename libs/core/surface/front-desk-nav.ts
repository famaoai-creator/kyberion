/**
 * front-desk-nav.ts — FD-00: the shared front-desk navigation rail.
 *
 * Single definition of grouped, existing feature destinations that both surfaces (presence-studio's static
 * renderer and concierge's React components) read, so the rail never
 * drifts between the two Next.js/static-HTML implementations. See
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §2.1 / §2.5 / §3 FD-00.
 *
 * Pure and deterministic — the only I/O is the optional, best-effort
 * manifest read in `readFrontDeskSurfacePorts()`, which never throws.
 */
import { loadSurfaceManifest } from './surface-runtime.js';
import { resolveSurfaceBrowserUrl } from './surface-url.js';

export type FrontDeskRole = 'owner' | 'approver' | 'operator' | 'viewer';

export type FrontDeskPrimarySurfaceId = 'presence-studio' | 'concierge';
export type FrontDeskOptionalSurfaceId = 'chronos-mirror-v2' | 'operator-surface';
export type FrontDeskSurfaceId = FrontDeskPrimarySurfaceId | FrontDeskOptionalSurfaceId;
export type FrontDeskAvailableSurfaces = Partial<Record<FrontDeskOptionalSurfaceId, string>>;

/**
 * Where an item renders on the rail: `main` (top, in catalog order) or
 * `footer` (pinned at the rail bottom so it stays visible without scrolling,
 * MSN-SHELL-IA §1/§4: 設定 at 1440×1000).
 */
export type FrontDeskMenuPlacement = 'main' | 'footer';

export interface FrontDeskMenuItem {
  id: string;
  /** Optional rail group heading; the seven top-level destinations are ungrouped. */
  group_key?: string;
  icon: string;
  label_key: string;
  sublabel_key: string;
  surface: FrontDeskSurfaceId;
  path: string;
  min_role: FrontDeskRole;
  placement?: FrontDeskMenuPlacement;
}

/**
 * MSN-SHELL-IA-20261105 §1 — exactly seven top-level destinations. Every
 * other surface lives under one of them (tabs) or redirects to it
 * (`presence/displays/concierge/src/lib/ia-routes.ts`). Role gates are the
 * ones the folded-in destinations carried before.
 */
export const FRONT_DESK_MENU: readonly FrontDeskMenuItem[] = [
  {
    id: 'home',
    label_key: 'front_desk:ia_nav_home',
    sublabel_key: 'front_desk:ia_nav_home_sub',
    surface: 'concierge',
    path: '/',
    min_role: 'viewer',
    icon: 'home',
  },
  {
    id: 'inbox',
    label_key: 'front_desk:ia_nav_inbox',
    sublabel_key: 'front_desk:ia_nav_inbox_sub',
    surface: 'concierge',
    path: '/inbox',
    min_role: 'approver',
    icon: 'approval',
  },
  {
    id: 'work',
    label_key: 'front_desk:ia_nav_work',
    sublabel_key: 'front_desk:ia_nav_work_sub',
    surface: 'concierge',
    path: '/work',
    min_role: 'viewer',
    icon: 'mission',
  },
  {
    id: 'org',
    label_key: 'front_desk:ia_nav_org',
    sublabel_key: 'front_desk:ia_nav_org_sub',
    surface: 'concierge',
    path: '/org',
    min_role: 'viewer',
    icon: 'user',
  },
  {
    id: 'library',
    label_key: 'front_desk:ia_nav_library',
    sublabel_key: 'front_desk:ia_nav_library_sub',
    surface: 'concierge',
    path: '/library',
    min_role: 'viewer',
    icon: 'book',
  },
  {
    id: 'ops',
    label_key: 'front_desk:ia_nav_ops',
    sublabel_key: 'front_desk:ia_nav_ops_sub',
    surface: 'concierge',
    path: '/ops',
    min_role: 'owner',
    icon: 'chart',
  },
  {
    id: 'settings',
    label_key: 'front_desk:ia_nav_settings',
    sublabel_key: 'front_desk:ia_nav_settings_sub',
    surface: 'concierge',
    path: '/settings',
    min_role: 'owner',
    icon: 'settings',
    placement: 'footer',
  },
] as const;

/**
 * Destinations other screens still link to (hearing completion, component
 * groups, Studio pages) but that the rail does not list: the seven
 * top-level destinations replaced them as navigation entries.
 */
export const FRONT_DESK_LINKED_DESTINATIONS: readonly FrontDeskMenuItem[] = [
  {
    id: 'ask',
    label_key: 'front_desk:nav_ask',
    sublabel_key: 'front_desk:nav_ask_sub',
    surface: 'presence-studio',
    path: '/ask',
    min_role: 'approver',
    group_key: 'front_desk:nav_group_work',
    icon: 'chat',
  },
  {
    id: 'first-job',
    label_key: 'front_desk:nav_first_job',
    sublabel_key: 'front_desk:nav_first_job_sub',
    surface: 'presence-studio',
    path: '/first-job',
    min_role: 'approver',
    group_key: 'front_desk:nav_group_resources',
    icon: 'check',
  },
  {
    id: 'help',
    label_key: 'front_desk:nav_help',
    sublabel_key: 'front_desk:nav_help_sub',
    surface: 'concierge',
    path: '/help',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_resources',
    icon: 'help',
  },
  {
    id: 'home-studio',
    label_key: 'front_desk:nav_home',
    sublabel_key: 'front_desk:nav_home_sub',
    surface: 'presence-studio',
    path: '/home',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_work',
    icon: 'home',
  },
  {
    // 進み具合 is Concierge 仕事 › 依頼 (Kyberion server phase 2).
    id: 'progress',
    label_key: 'front_desk:nav_progress',
    sublabel_key: 'front_desk:nav_progress_sub',
    surface: 'concierge',
    path: '/work?tab=requests',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_work',
    icon: 'chart',
  },
] as const;

export const FRONT_DESK_HELP_LINK = {
  id: 'help',
  label_key: 'front_desk:nav_help',
  surface: 'concierge',
  path: '/help',
} as const;

export interface FrontDeskSurfacePorts {
  'presence-studio': number;
  concierge: number;
}

export const DEFAULT_FRONT_DESK_PORTS: FrontDeskSurfacePorts = {
  'presence-studio': 3031,
  concierge: 3050,
};

const FRONT_DESK_ROLE_RANK: Record<FrontDeskRole, number> = {
  viewer: 0,
  operator: 1,
  approver: 2,
  owner: 3,
};

/** Role ordering helper: owner >= approver >= operator >= viewer. */
export function frontDeskRoleAllows(role: FrontDeskRole, min: FrontDeskRole): boolean {
  return FRONT_DESK_ROLE_RANK[role] >= FRONT_DESK_ROLE_RANK[min];
}

/**
 * Map a server-resolved viewer role to the human role. `localadmin` ->
 * `owner`; `readonly` -> `viewer`.
 *
 * FD-07: when the caller has already resolved a member (member-registry.ts,
 * kept out of this fs-free module on purpose) and knows that member's role
 * for the tenant in view, it passes it as `memberRole` and that value wins
 * outright — this is the only way `approver` is ever produced. With no
 * `memberRole` (unregistered principal, back-compat), the legacy
 * localadmin/readonly mapping applies unchanged.
 */
export function frontDeskRoleFromViewer(input: {
  role: 'readonly' | 'localadmin';
  memberRole?: FrontDeskRole | null;
}): FrontDeskRole {
  if (input.memberRole) return input.memberRole;
  return input.role === 'localadmin' ? 'owner' : 'viewer';
}

/**
 * Resolve hrefs for rendering. An item hosted on `currentSurface` gets a
 * same-tab relative `path`; an item on the other surface gets a same-tab
 * absolute `http://127.0.0.1:<port><path>` (cross-surface navigation is
 * still a normal same-tab link — FD-00 retires `target="_blank"` rail
 * links). `role` gates `allowed` via `frontDeskRoleAllows`; when omitted it
 * defaults to the least-privileged `viewer` role so unknown-role rendering
 * never over-shows privileged items.
 */
export interface FrontDeskMenuResolveInput {
  /** The surface rendering the rail; its own items get same-origin relative paths. */
  currentSurface: FrontDeskSurfaceId;
  availableSurfaces?: FrontDeskAvailableSurfaces;
  ports?: Partial<FrontDeskSurfacePorts>;
  urls?: Partial<Record<FrontDeskSurfaceId, string>>;
  role?: FrontDeskRole;
}

export type ResolvedFrontDeskMenuItem = FrontDeskMenuItem & {
  href: string;
  external: boolean;
  allowed: boolean;
  scope_query_style: 'snake' | 'camel';
};

export function resolveFrontDeskMenu(
  input: FrontDeskMenuResolveInput
): ResolvedFrontDeskMenuItem[] {
  return resolveItems(FRONT_DESK_MENU, input);
}

/**
 * One destination by id — a rail item or a linked-only destination
 * (`FRONT_DESK_LINKED_DESTINATIONS`) — resolved exactly like the rail.
 */
export function resolveFrontDeskDestination(
  id: string,
  input: FrontDeskMenuResolveInput
): ResolvedFrontDeskMenuItem | undefined {
  return resolveItems([...FRONT_DESK_MENU, ...FRONT_DESK_LINKED_DESTINATIONS], input).find(
    (item) => item.id === id
  );
}

function resolveItems(
  catalog: readonly FrontDeskMenuItem[],
  input: FrontDeskMenuResolveInput
): ResolvedFrontDeskMenuItem[] {
  const ports: FrontDeskSurfacePorts = { ...DEFAULT_FRONT_DESK_PORTS, ...input.ports };
  const role = input.role ?? 'viewer';
  return catalog
    .filter(
      (item) =>
        !isOptionalSurface(item.surface) ||
        item.surface === input.currentSurface ||
        Boolean(input.availableSurfaces?.[item.surface])
    )
    .map((item) => {
      const external = item.surface !== input.currentSurface;
      const base = !external
        ? ''
        : isOptionalSurface(item.surface)
          ? input.availableSurfaces![item.surface]!
          : (input.urls?.[item.surface] ?? `http://127.0.0.1:${ports[item.surface]}`);
      const href = external ? base.replace(/\/+$/, '') + item.path : item.path;
      return {
        ...item,
        // The operations console (Concierge `/ops`, formerly Chronos) reads
        // snake_case scope queries (`tenant_slug`, `organization_id`, …).
        scope_query_style: usesSnakeScopeQuery(item) ? ('snake' as const) : ('camel' as const),
        href,
        external,
        allowed: frontDeskRoleAllows(role, item.min_role),
      };
    });
}

/**
 * Read ports from the surface manifest (`loadSurfaceManifest()`), falling
 * back to `DEFAULT_FRONT_DESK_PORTS` for any surface that is missing or has
 * an invalid port. Never throws — the manifest may not exist yet (first
 * boot) or may be unreadable in the current execution context, and the
 * rail must still render with sane defaults.
 */
export function readFrontDeskSurfacePorts(): FrontDeskSurfacePorts {
  const ports: FrontDeskSurfacePorts = { ...DEFAULT_FRONT_DESK_PORTS };
  try {
    const manifest = loadSurfaceManifest();
    for (const surfaceId of Object.keys(ports) as FrontDeskPrimarySurfaceId[]) {
      const definition = manifest.surfaces.find((surface) => surface.id === surfaceId);
      if (
        definition &&
        typeof definition.port === 'number' &&
        Number.isFinite(definition.port) &&
        definition.port > 0
      ) {
        ports[surfaceId] = definition.port;
      }
    }
  } catch {
    // Manifest absent/invalid — keep defaults. Rendering the rail must
    // never fail because the runtime manifest hasn't been reconciled yet.
  }
  return ports;
}

/** Configured deployment bases use the same manifest urlEnv contract as all
 * runtime clients. Local ports are fallback only; this never changes auth. */
export function readFrontDeskSurfaceUrls(): Record<FrontDeskPrimarySurfaceId, string> {
  const ports = readFrontDeskSurfacePorts();
  const urls = {} as Record<FrontDeskPrimarySurfaceId, string>;
  for (const id of Object.keys(ports) as FrontDeskPrimarySurfaceId[]) {
    try {
      urls[id] = resolveSurfaceBrowserUrl(id);
    } catch {
      urls[id] = `http://127.0.0.1:${ports[id]}`;
    }
  }
  return urls;
}

/** Path of the operations console inside Concierge (the former Chronos surface). */
export const FRONT_DESK_OPS_CONSOLE_PATH = '/ops';

function usesSnakeScopeQuery(item: FrontDeskMenuItem): boolean {
  return (
    item.surface === 'chronos-mirror-v2' ||
    item.path === FRONT_DESK_OPS_CONSOLE_PATH ||
    item.path.startsWith(FRONT_DESK_OPS_CONSOLE_PATH + '?') ||
    item.path.startsWith(FRONT_DESK_OPS_CONSOLE_PATH + '/')
  );
}

function isOptionalSurface(id: FrontDeskSurfaceId): id is FrontDeskOptionalSurfaceId {
  return id === 'chronos-mirror-v2' || id === 'operator-surface';
}

/** Read-only conservative availability: never start a surface or probe a remote
 * deployment using a misleading localhost health result. Unknown means omitted. */
export async function readAvailableFrontDeskSurfaces(): Promise<FrontDeskAvailableSurfaces> {
  const available: FrontDeskAvailableSurfaces = {};
  try {
    const manifest = loadSurfaceManifest();
    await Promise.all(
      manifest.surfaces
        .filter((surface) => surface.id === 'chronos-mirror-v2' && surface.enabled === true)
        .map(async (surface) => {
          try {
            const browserUrl = resolveSurfaceBrowserUrl(surface.id);
            const url = new URL(browserUrl);
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return;
            if (
              url.protocol !== 'http:' ||
              Number(url.port || 80) !== surface.port ||
              !surface.healthPath ||
              url.pathname !== '/' ||
              url.search ||
              url.hash
            )
              return;
            const healthUrl = new URL(surface.healthPath, url);
            if (healthUrl.origin !== url.origin) return;
            const response = await fetch(healthUrl, {
              signal: AbortSignal.timeout(1500),
              redirect: 'error',
            });
            if (response.ok) available[surface.id as FrontDeskOptionalSurfaceId] = browserUrl;
          } catch {
            /* A broken optional destination must not break the primary menu. */
          }
        })
    );
  } catch {
    /* First boot or unavailable manifest: primary destinations still work. */
  }
  return available;
}
