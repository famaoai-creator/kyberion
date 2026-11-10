/**
 * S4 slice 4 of the scope/identity/grant consolidation (ADR concept-model-v2
 * D5/D6): the four Execution Persona permission bundles are base Authority
 * Roles in the one role registry (`knowledge/product/governance/authority-roles/
 * base_<persona>.json`, projected into security-policy.json
 * `authority_role_permissions` by `pnpm kyberion sync authority-roles`).
 *
 * Every principal runs on exactly one base role, the one its persona names
 * (KYBERION_BASE_ROLE, the assumed scope's persona, or the role's default); the
 * tier guard adds that base role's operations to the principal's own role and
 * authorities, exactly as `persona_permissions` did. A base role is never a
 * principal's own role: it cannot be assumed (`withExecutionContext` refuses
 * it), and a process running as the name through SYSTEM_ROLE / MISSION_ROLE
 * gets nothing from it (`rolePermissionRecord` resolves no record for it).
 * `mission_owner` and `unknown` have no base role (they had no bundle).
 */

/** A persona value that has a base Authority Role. */
export type BasePersona = 'sovereign' | 'ecosystem_architect' | 'worker' | 'analyst';

/** Persona value -> its base Authority Role. */
export const BASE_AUTHORITY_ROLES: Readonly<Record<BasePersona, string>> = Object.freeze({
  sovereign: 'base_sovereign',
  ecosystem_architect: 'base_ecosystem_architect',
  worker: 'base_worker',
  analyst: 'base_analyst',
});

const BASE_ROLE_NAMES: ReadonlySet<string> = new Set(Object.values(BASE_AUTHORITY_ROLES));

/** The base Authority Role a persona value runs on, if it has one. */
export function baseAuthorityRoleOf(persona: string | undefined): string | undefined {
  return typeof persona === 'string' && Object.hasOwn(BASE_AUTHORITY_ROLES, persona)
    ? BASE_AUTHORITY_ROLES[persona as BasePersona]
    : undefined;
}

/** True for the name of a base Authority Role (never a principal's own role). */
export function isBaseAuthorityRoleName(name: string | undefined): boolean {
  return typeof name === 'string' && BASE_ROLE_NAMES.has(name);
}

/** The persona value whose base Authority Role is `name`. */
export function personaOfBaseAuthorityRole(name: string | undefined): BasePersona | undefined {
  return (Object.keys(BASE_AUTHORITY_ROLES) as BasePersona[]).find(
    (persona) => BASE_AUTHORITY_ROLES[persona] === name
  );
}

type PermissionRecord = { allow_read?: string[]; allow_write?: string[]; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The permission record of the base Authority Role a persona runs on (its
 * `authority_role_permissions` projection), or undefined when the persona has
 * no base role or the policy has no record for it. An installation catalog that
 * predates base roles (no record for it, `persona_permissions` present) is read
 * from its `persona_permissions` entry for one release — the same bundle it
 * enforced before, so this never adds anything. Returns the raw (possibly
 * malformed) value so callers keep their own fail-closed checks.
 */
export function baseAuthorityRolePermissionRecord(
  policy: unknown,
  persona: string | undefined
): PermissionRecord | undefined {
  const base = baseAuthorityRoleOf(persona);
  if (!base || !isRecord(policy)) return undefined;
  const roles = policy.authority_role_permissions;
  if (isRecord(roles) && Object.hasOwn(roles, base)) return roles[base] as PermissionRecord;
  const legacy = policy.persona_permissions;
  return isRecord(legacy) && typeof persona === 'string' && Object.hasOwn(legacy, persona)
    ? (legacy[persona] as PermissionRecord | undefined)
    : undefined;
}
