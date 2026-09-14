/**
 * front-desk-nav.ts — FD-00: the shared front-desk navigation rail.
 *
 * Single definition of the "human verbs" menu (home / ask / decide /
 * progress / settings) that both surfaces (presence-studio's static
 * renderer and concierge's React components) read, so the rail never
 * drifts between the two Next.js/static-HTML implementations. See
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §2.1 / §2.5 / §3 FD-00.
 *
 * Pure and deterministic — the only I/O is the optional, best-effort
 * manifest read in `readFrontDeskSurfacePorts()`, which never throws.
 */
import { loadSurfaceManifest } from './surface-runtime.js';

export type FrontDeskRole = 'owner' | 'approver' | 'viewer';

export type FrontDeskSurfaceId = 'presence-studio' | 'concierge';

export interface FrontDeskMenuItem {
  id: 'home' | 'ask' | 'decide' | 'progress' | 'settings';
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
  },
  {
    id: 'ask',
    label_key: 'front_desk:nav_ask',
    sublabel_key: 'front_desk:nav_ask_sub',
    surface: 'presence-studio',
    path: '/ask',
    min_role: 'approver',
  },
  {
    id: 'decide',
    label_key: 'front_desk:nav_decide',
    sublabel_key: 'front_desk:nav_decide_sub',
    surface: 'concierge',
    path: '/',
    min_role: 'approver',
  },
  {
    id: 'progress',
    label_key: 'front_desk:nav_progress',
    sublabel_key: 'front_desk:nav_progress_sub',
    surface: 'presence-studio',
    path: '/progress',
    min_role: 'viewer',
  },
  {
    id: 'settings',
    label_key: 'front_desk:nav_settings',
    sublabel_key: 'front_desk:nav_settings_sub',
    surface: 'concierge',
    path: '/settings',
    min_role: 'owner',
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
  approver: 1,
  owner: 2,
};

/** Role ordering helper: owner >= approver >= viewer. */
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
  currentSurface: FrontDeskSurfaceId;
  ports?: Partial<FrontDeskSurfacePorts>;
  role?: FrontDeskRole;
}): Array<FrontDeskMenuItem & { href: string; external: boolean; allowed: boolean }> {
  const ports: FrontDeskSurfacePorts = { ...DEFAULT_FRONT_DESK_PORTS, ...input.ports };
  const role = input.role ?? 'viewer';
  return FRONT_DESK_MENU.map((item) => {
    const external = item.surface !== input.currentSurface;
    const href = external ? `http://127.0.0.1:${ports[item.surface]}${item.path}` : item.path;
    return {
      ...item,
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
    for (const surfaceId of Object.keys(ports) as FrontDeskSurfaceId[]) {
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
