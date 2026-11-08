/**
 * Child-process environments for everything the Kyberion server (Concierge)
 * spawns. A child that runs without SYSTEM_ROLE is not bounded by the role
 * assumption policy, so a route could otherwise reach writer roles the
 * server itself must never hold (the dot lifecycle store roles
 * dot_charter_store / dot_lifecycle_runtime_store, generation_scheduler,
 * reconcile_config_fallbacks, operational_learning_writer) indirectly. Every
 * spawn therefore uses one of these builders (tests/… server-child-env
 * contract in lib/server-child-env.test.ts):
 *
 *   serverChildEnv()             — SYSTEM_ROLE=concierge, bounded by the concierge policy
 *   serverDelegatedChildEnv(r)   — the same, delegating role r (DR-01, still bounded)
 *   governedWorkerEnv(systemRole)— a governed worker under its own narrow system role
 *
 * Each clears the launcher's own identity (MISSION_ROLE, the delegated role,
 * KYBERION_PERSONA) and KYBERION_SUDO, which secure-io's allowlisted env would
 * otherwise pass through from the server process.
 */
import { buildExecutionEnv, buildSystemRoleLaunchEnv } from '@agent/core/authority';

export const SERVER_SYSTEM_ROLE = 'concierge';

type ChildEnv = Record<string, string | undefined>;

export function governedWorkerEnv(systemRole: string, base: ChildEnv = {}): ChildEnv {
  return {
    ...(buildSystemRoleLaunchEnv(base, systemRole, { persona: 'worker' }) as ChildEnv),
    KYBERION_SUDO: '',
  };
}

/** A child bounded by the server's own role assumption policy. */
export function serverChildEnv(base: ChildEnv = {}): ChildEnv {
  return governedWorkerEnv(SERVER_SYSTEM_ROLE, base);
}

/**
 * A child that continues as `role` (DR-01 delegation `role@concierge`), still
 * bounded by the concierge policy. `base` defaults to the server's env so the
 * existing call sites keep their tenant / root variables.
 */
export function serverDelegatedChildEnv(
  role: string,
  base: ChildEnv = process.env as ChildEnv
): ChildEnv {
  return {
    ...(buildExecutionEnv(serverChildEnv(base) as NodeJS.ProcessEnv, role) as ChildEnv),
    KYBERION_SUDO: '',
  };
}
