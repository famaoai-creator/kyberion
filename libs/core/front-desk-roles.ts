/**
 * front-desk-roles.ts — FD-07: the ONE place that maps a human front-desk
 * role (owner / approver / viewer, plan §2.3) to a server `ChronosAccessRole`
 * + `SurfacePermission` set.
 *
 * Plan §2.3 "役割" row: owner -> localadmin (full); viewer -> readonly;
 * approver -> localadmin as the server role (so tenant/tier scope stays the
 * localadmin policy), but with permissions narrowed to
 * `surface.headless.read` + `surface.decision.write` only — never the full
 * `surface.headless.write`. See `surface-authorization.ts`'s
 * `resolveSurfacePermissions`: an explicit `context.permissions` REPLACES the
 * role default, which is what makes this narrowing actually take effect.
 *
 * `ROLE_TIER_ACCESS` (surface-mutation-guard.ts) is untouched by this module
 * on purpose (plan §3 FD-07 item 3: "ROLE_TIER_ACCESS は変更しない").
 *
 * Local `FrontDeskRole` copy on purpose, same rationale as
 * front-desk-nav.ts / front-desk-identity.ts: this module must stay free of
 * any node:fs-touching import so it can be pulled into a client bundle.
 */
import type { ChronosAccessRole } from './chronos-access-registry.js';
import type { SurfacePermission } from './surface-authorization.js';

export type FrontDeskHumanRole = 'owner' | 'approver' | 'viewer';

export interface FrontDeskRoleAuthority {
  /** The server-side role this human role executes as. */
  serverRole: ChronosAccessRole;
  /** The exact permission set granted — never widened by role defaults (see surface-authorization.ts). */
  permissions: readonly SurfacePermission[];
}

const FRONT_DESK_ROLE_AUTHORITY: Record<FrontDeskHumanRole, FrontDeskRoleAuthority> = {
  owner: {
    serverRole: 'localadmin',
    permissions: ['surface.headless.read', 'surface.headless.write', 'surface.decision.write'],
  },
  approver: {
    serverRole: 'localadmin',
    permissions: ['surface.headless.read', 'surface.decision.write'],
  },
  viewer: {
    serverRole: 'readonly',
    permissions: ['surface.headless.read'],
  },
};

export function frontDeskRoleAuthority(role: FrontDeskHumanRole): FrontDeskRoleAuthority {
  return FRONT_DESK_ROLE_AUTHORITY[role];
}

/** Every human role, in ascending privilege order — same order as front-desk-nav.ts's rank table. */
export const FRONT_DESK_HUMAN_ROLES: readonly FrontDeskHumanRole[] = [
  'viewer',
  'approver',
  'owner',
];
