import * as path from 'node:path';
import { rawExistsSync } from '../fs-primitives.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';

/**
 * The one place that reads the stance environment variables. It has no
 * secure-io dependency so `tier-guard.ts` can use it without an import cycle.
 *
 * `KYBERION_STANCE` names the active stance. `KYBERION_CUSTOMER` is retired
 * (Concept Model v2 D4). For one release it is still honoured as a migration
 * aid: when `KYBERION_STANCE` is unset and `knowledge/personal/stances/<slug>/`
 * exists, the legacy value maps to that stance — the only deterministic
 * mapping, because the old "customer overlay" directory became the stance
 * directory. Any other legacy value is ignored. Both cases log one diagnostic
 * warning per process.
 */

export const STANCE_ENV_VAR = 'KYBERION_STANCE';
/** @deprecated retired by Concept Model v2 D4; read only as a one-release migration aid. */
export const LEGACY_STANCE_ENV_VAR = 'KYBERION_CUSTOMER';
/** Repository-relative directory that holds one subdirectory per stance. */
export const STANCES_DIR = path.join('knowledge', 'personal', 'stances');
export const STANCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const logger = createLogger('stance-resolver');
let warnedLegacyEnv = false;

function warnLegacyOnce(message: string): void {
  if (warnedLegacyEnv) return;
  warnedLegacyEnv = true;
  logger.warn(message);
}

/**
 * Raw stance slug from the environment (not validated against the slug
 * grammar when it comes from `KYBERION_STANCE`; callers validate). Returns
 * null when no stance is selected.
 */
export function stanceSlugFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): string | null {
  const current = env[STANCE_ENV_VAR]?.trim();
  if (current) return current;
  const legacy = env[LEGACY_STANCE_ENV_VAR]?.trim();
  if (!legacy) return null;
  const mapped =
    STANCE_SLUG_PATTERN.test(legacy) && rawExistsSync(path.join(rootDir, STANCES_DIR, legacy));
  if (mapped) {
    warnLegacyOnce(
      `${LEGACY_STANCE_ENV_VAR} is retired — read once more as ${STANCE_ENV_VAR}=${legacy} because ${STANCES_DIR}/${legacy}/ exists; it stops being read next release | next: set ${STANCE_ENV_VAR}=${legacy} (pnpm stance:switch ${legacy}) and unset ${LEGACY_STANCE_ENV_VAR}; customer tone and contact belong to the tenant's channel bindings and customer records | evidence: knowledge/product/architecture/stance-tenant-customer-model.md`
    );
    return legacy;
  }
  warnLegacyOnce(
    `${LEGACY_STANCE_ENV_VAR} is retired — ignored because no stance ${STANCES_DIR}/${legacy}/ exists to map it to | next: unset ${LEGACY_STANCE_ENV_VAR}; select a stance with pnpm stance:switch <slug>, and keep customer tone and contact in the tenant's channel bindings and customer records | evidence: knowledge/product/architecture/stance-tenant-customer-model.md`
  );
  return null;
}

export const __stanceEnvTest__ = {
  resetLegacyEnvWarning: (): void => {
    warnedLegacyEnv = false;
  },
};
