import type { SurfaceViewerRole } from '@agent/core/surface/surface-authorization';

/**
 * The authority role a viewer's request executes under, per route family.
 *
 * These are two different mappings on purpose, kept side by side so the
 * divergence is visible in one place:
 * - Concierge routes run as `concierge_localadmin` / `concierge_operator`.
 * - Operations console routes (`/api/ops/*`, the former Chronos API) run as
 *   `chronos_localadmin` / `chronos_operator`.
 * The role cards grant different paths, so the two families are not
 * interchangeable. Which authority role a route runs under is an authority
 * decision: do not merge the tables or move a route between them as a
 * refactoring.
 *
 * Every `withExecutionContext` call that picks its role from the viewer role
 * goes through the two functions below (`viewer-context.ts`,
 * `outcome-files.ts`, `ops/ops-viewer.ts`, `ops/information-assets.ts`).
 */
export const VIEWER_EXECUTION_ROLES = {
  concierge: { localadmin: 'concierge_localadmin', readonly: 'concierge_operator' },
  ops: { localadmin: 'chronos_localadmin', readonly: 'chronos_operator' },
} as const satisfies Record<string, Record<SurfaceViewerRole, string>>;

export type ConciergeExecutionRole = 'concierge_localadmin' | 'concierge_operator';
export type OpsExecutionRole = 'chronos_localadmin' | 'chronos_operator';

// One typed function per family (not one function over both): the role
// assumption analysis bounds each call site by its return type, so a
// Concierge route must never be typed as able to assume a console role.
export function conciergeExecutionRole(role: SurfaceViewerRole): ConciergeExecutionRole {
  return VIEWER_EXECUTION_ROLES.concierge[role];
}

export function opsExecutionRole(role: SurfaceViewerRole): OpsExecutionRole {
  return VIEWER_EXECUTION_ROLES.ops[role];
}
