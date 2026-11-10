/**
 * S4 slice 4 (ADR concept-model-v2 D5): the one place that reads and writes the
 * environment variable naming the base Authority Role a process runs on.
 *
 * `KYBERION_BASE_ROLE` names it by its short name (`sovereign`,
 * `ecosystem_architect`, `worker`, `analyst`, `mission_owner`); `worker` runs
 * on the registry card `base_worker` (`foundation/base-authority-role.ts`). The
 * card name itself (`base_worker`) is accepted too and read as its short name.
 *
 * `KYBERION_PERSONA` is its retired name (Execution Persona is removed by D5).
 * For one release it is still read, with one diagnostic warning per process,
 * but only when `KYBERION_BASE_ROLE` is absent from the environment. A present
 * `KYBERION_BASE_ROLE` — even an empty one, which means "no base role" — always
 * wins, so a writer that clears the base role can never let an inherited
 * legacy value through. Writers set only `KYBERION_BASE_ROLE`; a child env
 * built here drops the legacy name.
 *
 * Every child-process env pass/strip key list names both variables
 * ({@link BASE_ROLE_ENV_NAMES}); `tests/base-role-env-key-list-boundary.test.ts`
 * fails when a list names one without the other. A list that strips only the
 * new name would let the child fall back to an inherited legacy value; a list
 * that passes only the new name would drop an operator's explicit legacy value
 * and the child would fall back to its role's default base role, which can be
 * wider.
 *
 * Foundation leaf: no secure-io / authority import.
 */
import { getRegisteredEnvText } from './env.js';
import { createLogger } from '../logger.js';
import { personaOfBaseAuthorityRole } from './base-authority-role.js';

export const BASE_ROLE_ENV = 'KYBERION_BASE_ROLE';
/** @deprecated retired by Concept Model v2 D5; read for one release only when {@link BASE_ROLE_ENV} is absent. */
export const LEGACY_PERSONA_ENV = 'KYBERION_PERSONA';
/** Both names, for child-process env pass / strip key lists. */
export const BASE_ROLE_ENV_NAMES = [BASE_ROLE_ENV, LEGACY_PERSONA_ENV] as const;

type EnvRecord = Record<string, string | undefined>;

const logger = createLogger('base-role-env');
let warnedLegacy = false;

/** `base_worker` → `worker`; every other value is returned unchanged. */
export function normalizeBaseRoleValue(value: string): string {
  return personaOfBaseAuthorityRole(value) ?? value;
}

/**
 * The base role named by the environment, or undefined. Not validated or
 * trimmed: callers normalise unknown values exactly as they did for the
 * legacy name. Only a `KYBERION_BASE_ROLE` card name (`base_worker`) is
 * rewritten to its short name; a legacy value is returned as it was read.
 */
export function baseRoleEnvText(env: EnvRecord = process.env): string | undefined {
  if (env[BASE_ROLE_ENV] !== undefined) {
    const current = getRegisteredEnvText(BASE_ROLE_ENV, { env });
    return current ? normalizeBaseRoleValue(current) : undefined;
  }
  const legacy = getRegisteredEnvText(LEGACY_PERSONA_ENV, { env });
  if (!legacy) return undefined;
  if (!warnedLegacy) {
    warnedLegacy = true;
    logger.warn(
      `${LEGACY_PERSONA_ENV} is retired — read once more as ${BASE_ROLE_ENV}=${legacy} because ${BASE_ROLE_ENV} is not set; it stops being read next release | next: set ${BASE_ROLE_ENV}=${legacy} (in .env.local, surface manifests, launch scripts and CI) and unset ${LEGACY_PERSONA_ENV} | evidence: docs/developer/improvement-plans-2026-11/SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md (S4)`
    );
  }
  return legacy;
}

/**
 * Write the base role into a child env: `value` sets it, `null` / `undefined`
 * / `''` clears it (written as '' so it also overrides an inherited value in a
 * secure-io env overlay). The legacy name is always dropped.
 */
export function writeBaseRoleEnv(env: EnvRecord, value: string | null | undefined): void {
  env[BASE_ROLE_ENV] = value ?? '';
  delete env[LEGACY_PERSONA_ENV];
}

/** Env overlay entries that clear the base role under both names ('' reads as unset). */
export function clearedBaseRoleEnv(): Record<(typeof BASE_ROLE_ENV_NAMES)[number], ''> {
  return { [BASE_ROLE_ENV]: '', [LEGACY_PERSONA_ENV]: '' } as Record<
    (typeof BASE_ROLE_ENV_NAMES)[number],
    ''
  >;
}

export const __baseRoleEnvTest__ = {
  resetLegacyWarning: (): void => {
    warnedLegacy = false;
  },
};
