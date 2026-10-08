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
import { loadSurfaceManifest } from './surface/surface-runtime.js';
import { resolveSurfaceBrowserUrl } from './surface/surface-url.js';

export type FrontDeskRole = 'owner' | 'approver' | 'operator' | 'viewer';

export type FrontDeskPrimarySurfaceId = 'presence-studio' | 'concierge';
export type FrontDeskOptionalSurfaceId = 'chronos-mirror-v2' | 'operator-surface';
export type FrontDeskSurfaceId = FrontDeskPrimarySurfaceId | FrontDeskOptionalSurfaceId;
export type FrontDeskAvailableSurfaces = Partial<Record<FrontDeskOptionalSurfaceId, string>>;

export interface FrontDeskMenuItem {
  id: string;
  group_key: string;
  icon: string;
  label_key: string;
  sublabel_key: string;
  surface: FrontDeskSurfaceId;
  path: string;
  min_role: FrontDeskRole;
}

export const FRONT_DESK_MENU: readonly FrontDeskMenuItem[] = [
  {
    id: 'home',
    label_key: 'front_desk:nav_home',
    sublabel_key: 'front_desk:nav_home_sub',
    surface: 'presence-studio',
    path: '/',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_work',
    icon: 'home',
  },
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
    id: 'decide',
    label_key: 'front_desk:nav_decide',
    sublabel_key: 'front_desk:nav_decide_sub',
    surface: 'concierge',
    path: '/',
    min_role: 'approver',
    group_key: 'front_desk:nav_group_work',
    icon: 'approval',
  },
  {
    id: 'progress',
    label_key: 'front_desk:nav_progress',
    sublabel_key: 'front_desk:nav_progress_sub',
    surface: 'presence-studio',
    path: '/progress',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_work',
    icon: 'chart',
  },
  {
    id: 'workspace',
    label_key: 'front_desk:nav_workspace',
    sublabel_key: 'front_desk:nav_workspace_sub',
    surface: 'presence-studio',
    path: '/work',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_work',
    icon: 'chat',
  },
  {
    id: 'missions',
    label_key: 'front_desk:nav_missions',
    sublabel_key: 'front_desk:nav_missions_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=missions',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_work',
    icon: 'mission',
  },
  {
    id: 'work-items',
    label_key: 'front_desk:nav_work_items',
    sublabel_key: 'front_desk:nav_work_items_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=work-items',
    min_role: 'operator',
    group_key: 'front_desk:nav_group_work',
    icon: 'check',
  },
  {
    id: 'deliverables',
    label_key: 'front_desk:nav_deliverables',
    sublabel_key: 'front_desk:nav_deliverables_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=deliverables',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_resources',
    icon: 'folder',
  },
  {
    id: 'ingest',
    label_key: 'front_desk:nav_ingest',
    sublabel_key: 'front_desk:nav_ingest_sub',
    surface: 'concierge',
    path: '/ingest',
    min_role: 'operator',
    group_key: 'front_desk:nav_group_resources',
    icon: 'folder',
  },
  {
    id: 'knowledge',
    label_key: 'front_desk:nav_knowledge',
    sublabel_key: 'front_desk:nav_knowledge_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=knowledge',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_resources',
    icon: 'book',
  },
  {
    id: 'discussion',
    label_key: 'front_desk:nav_discussion',
    sublabel_key: 'front_desk:nav_discussion_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=discussion',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_resources',
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
    surface: 'presence-studio',
    path: '/help',
    min_role: 'viewer',
    group_key: 'front_desk:nav_group_resources',
    icon: 'help',
  },
  {
    id: 'organization',
    label_key: 'front_desk:nav_organization',
    sublabel_key: 'front_desk:nav_organization_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=organization',
    min_role: 'owner',
    group_key: 'front_desk:nav_group_manage',
    icon: 'user',
  },
  {
    id: 'operations',
    label_key: 'front_desk:nav_operations',
    sublabel_key: 'front_desk:nav_operations_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=operations',
    min_role: 'owner',
    group_key: 'front_desk:nav_group_manage',
    icon: 'settings',
  },
  {
    id: 'surface-control',
    label_key: 'front_desk:nav_surfaces',
    sublabel_key: 'front_desk:nav_surfaces_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=surface-control',
    min_role: 'owner',
    group_key: 'front_desk:nav_group_manage',
    icon: 'settings',
  },
  {
    id: 'diagnostics',
    label_key: 'front_desk:nav_diagnostics',
    sublabel_key: 'front_desk:nav_diagnostics_sub',
    surface: 'chronos-mirror-v2',
    path: '/?section=diagnostics',
    min_role: 'owner',
    group_key: 'front_desk:nav_group_manage',
    icon: 'chart',
  },
  {
    id: 'settings',
    label_key: 'front_desk:nav_settings',
    sublabel_key: 'front_desk:nav_settings_sub',
    surface: 'concierge',
    path: '/settings',
    min_role: 'owner',
    group_key: 'front_desk:nav_group_manage',
    icon: 'settings',
  },
] as const;

export const FRONT_DESK_HELP_LINK = {
  id: 'help',
  label_key: 'front_desk:nav_help',
  surface: 'presence-studio',
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
export function resolveFrontDeskMenu(input: {
  currentSurface: FrontDeskPrimarySurfaceId;
  availableSurfaces?: FrontDeskAvailableSurfaces;
  ports?: Partial<FrontDeskSurfacePorts>;
  urls?: Partial<Record<FrontDeskSurfaceId, string>>;
  role?: FrontDeskRole;
}): Array<
  FrontDeskMenuItem & {
    href: string;
    external: boolean;
    allowed: boolean;
    scope_query_style: 'snake' | 'camel';
  }
> {
  const ports: FrontDeskSurfacePorts = { ...DEFAULT_FRONT_DESK_PORTS, ...input.ports };
  const role = input.role ?? 'viewer';
  return FRONT_DESK_MENU.filter(
    (item) => !isOptionalSurface(item.surface) || Boolean(input.availableSurfaces?.[item.surface])
  ).map((item) => {
    const external = item.surface !== input.currentSurface;
    const base = isOptionalSurface(item.surface)
      ? input.availableSurfaces![item.surface]!
      : (input.urls?.[item.surface] ?? `http://127.0.0.1:${ports[item.surface]}`);
    const href = external ? base.replace(/\/+$/, '') + item.path : item.path;
    return {
      ...item,
      scope_query_style:
        item.surface === 'chronos-mirror-v2' ? ('snake' as const) : ('camel' as const),
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
