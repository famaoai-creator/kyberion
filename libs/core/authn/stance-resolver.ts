import * as path from 'node:path';
import { rawExistsSync } from '../fs-primitives.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath } from '../secure-io.js';

/**
 * Stance Resolver
 *
 * A stance is "which hat am I wearing": the identity, connections, policy,
 * voice and mission seeds Kyberion uses while acting as one of the entities the
 * operator belongs to or works for. It is configuration owned by the operator
 * (custody `person` in the information asset scope model), so it lives under
 * the operator's personal space and overlays `knowledge/personal/`:
 *
 *   knowledge/personal/stances/{slug}/{subPath}  →  knowledge/personal/{subPath}
 *
 * The active stance is named by `KYBERION_STANCE`. `KYBERION_CUSTOMER` is the
 * deprecated name and is still read (with a warning) so existing shells keep
 * working. A tenant's company assets and its customers' records are not part
 * of a stance; they live under `knowledge/confidential/{tenant}/`.
 */

export const STANCE_ENV_VAR = 'KYBERION_STANCE';
/** @deprecated read only as a fallback for STANCE_ENV_VAR. */
export const LEGACY_STANCE_ENV_VAR = 'KYBERION_CUSTOMER';
/** Repository-relative directory that holds one subdirectory per stance. */
export const STANCES_DIR = path.join('knowledge', 'personal', 'stances');
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const logger = createLogger('stance-resolver');
let warnedLegacyEnv = false;

export class InvalidStanceSlugError extends Error {
  constructor(slug: string) {
    super(
      `Invalid ${STANCE_ENV_VAR}: "${slug}". Must match ${SLUG_PATTERN.source} ` +
        `(lowercase ASCII, digits, hyphen, underscore; must start with letter or digit).`
    );
    this.name = 'InvalidStanceSlugError';
  }
}

/** The active stance slug, or null when Kyberion acts from `knowledge/personal/` alone. */
export function activeStance(env: NodeJS.ProcessEnv = process.env): string | null {
  let raw = env[STANCE_ENV_VAR];
  if ((!raw || raw.trim() === '') && env[LEGACY_STANCE_ENV_VAR]?.trim()) {
    raw = env[LEGACY_STANCE_ENV_VAR];
    if (!warnedLegacyEnv) {
      warnedLegacyEnv = true;
      logger.warn(
        `${LEGACY_STANCE_ENV_VAR} is deprecated — it names the active stance | next: set ${STANCE_ENV_VAR}=${raw?.trim()} instead`
      );
    }
  }
  if (!raw || raw.trim() === '') return null;
  const slug = raw.trim();
  if (!SLUG_PATTERN.test(slug)) throw new InvalidStanceSlugError(slug);
  return slug;
}

/** Directory of one stance (it may not exist yet). */
export function stanceDirForSlug(slug: string, rootDir: string = pathResolver.rootDir()): string {
  if (!SLUG_PATTERN.test(slug)) throw new InvalidStanceSlugError(slug);
  return assertSafeRepositoryPath(path.join(rootDir, STANCES_DIR, slug), {
    allowMissingLeaf: true,
    rootDir,
  });
}

/**
 * Path under the active stance, or null when no stance is active. Refuses a
 * subPath that escapes the stance directory.
 */
export function stanceRoot(
  subPath = '',
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): string | null {
  const slug = activeStance(env);
  if (!slug) return null;
  const base = path.join(rootDir, STANCES_DIR, slug);
  const candidate = subPath ? path.resolve(base, subPath) : base;
  if (!pathResolver.isPathInsideOrEqual(base, candidate)) {
    throw new Error(`[STANCE_SCOPE] stance overlay path escapes stance '${slug}': ${subPath}`);
  }
  return assertSafeRepositoryPath(candidate, {
    allowMissingLeaf: true,
    rootDir,
  });
}

/**
 * Top-level entries of a stance directory: the files and folders read through
 * the stance overlay. Anything else that legacy `customer/{slug}/` held (company
 * profile, vision, org chart, OKRs, decision rights, brand, design, deals, the
 * audit mirror, channel bindings) belongs to a tenant, not to a stance
 * (`organization/tenant-home.ts`).
 */
export const STANCE_ENTRIES: readonly string[] = [
  'identity.json',
  'my-identity.json',
  'agent-identity.json',
  'my-vision.md',
  'policy',
  'connections',
  'voice',
  'mission-seeds',
  'tenants',
  'onboarding',
];
/** Entries under a stance entry that belong to the tenant instead (relative paths). */
export const NON_STANCE_ENTRIES: readonly string[] = ['connections/channel-bindings.json'];

/** Whether a path relative to a legacy `customer/{slug}/` directory is stance configuration. */
export function isStanceEntry(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/').replace(/^\.\//u, '');
  if (NON_STANCE_ENTRIES.includes(normalized)) return false;
  return STANCE_ENTRIES.includes(normalized.split('/')[0]);
}

/** Repository-relative directory of logs written while acting under a stance. */
export const STANCE_LOGS_DIR = path.join('active', 'shared', 'logs', 'stances');

/**
 * Where run logs of the active stance go (`active/shared/logs/stances/{slug}/{kind}`),
 * or null when no stance is active. Logs are runtime output, not stance
 * configuration, so they stay out of `knowledge/`.
 */
export function stanceLogDir(
  kind: 'traces',
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): string | null {
  const slug = activeStance(env);
  if (!slug) return null;
  return assertSafeRepositoryPath(path.join(rootDir, STANCE_LOGS_DIR, slug, kind), {
    allowMissingLeaf: true,
    rootDir,
  });
}

/**
 * Resolve a config path with stance overlay precedence:
 * knowledge/personal/stances/{slug}/{subPath} → knowledge/personal/{subPath}.
 * Returns the first existing path; if neither exists, returns the stance path
 * (when a stance is active) or the personal path, so callers can use it for writes.
 */
export function resolveOverlay(subPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const stancePath = stanceRoot(subPath, env);
  if (stancePath && rawExistsSync(stancePath)) return stancePath;
  const personalPath = pathResolver.knowledge(path.join('personal', subPath));
  if (rawExistsSync(personalPath)) return personalPath;
  return stancePath ?? personalPath;
}

/** Both candidate paths (stance overlay + personal base) for callers that merge them. */
export function overlayCandidates(
  subPath: string,
  env: NodeJS.ProcessEnv = process.env
): { overlay: string | null; base: string } {
  return {
    overlay: stanceRoot(subPath, env),
    base: pathResolver.knowledge(path.join('personal', subPath)),
  };
}

/** True when a stance is active and its directory exists. */
export function stanceIsConfigured(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): boolean {
  const root = stanceRoot('', env, rootDir);
  return root != null && rawExistsSync(root);
}

export const __test__ = {
  SLUG_PATTERN,
  resetLegacyEnvWarning: (): void => {
    warnedLegacyEnv = false;
  },
};
