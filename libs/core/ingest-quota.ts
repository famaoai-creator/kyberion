/**
 * ingest-quota.ts — DA-08: per-tenant daily ingest budget (取込クォータ).
 *
 * Mirrors OP-01's spend-guard shape (`./spend-guard.js`): governed limits in
 * `knowledge/product/governance/ingest-quota-policy.json` with per-tenant
 * overrides under `tenant_overrides` (keyed by tenant slug — the same
 * override pattern as spend-policy.json), staged warn→block enforcement, and
 * the same VITEST opt-in convention for the enforcement gate.
 *
 * Semantics (staged, per UTC day, per tenant):
 *  - `ok`    — the projected usage (recorded + incoming) stays under the
 *              warn threshold (`warn_ratio` × limit) on every dimension.
 *  - `warn`  — the projected usage crosses the warn threshold but stays
 *              within the limit: the caller logs + proceeds (audited).
 *  - `block` — the projected usage would exceed `max_files_per_day` or
 *              `max_bytes_per_day`: the caller must refuse (fail-closed).
 *
 * Counters persist at
 * `active/shared/runtime/ingest/quota/{tenant}/{YYYY-MM-DD}.json`
 * (retention-catalog governed, 30d TTL) — `rootDir` and `now` are injectable
 * so hermetic tests never touch the real runtime tree or the wall clock.
 * Usage is recorded ONLY by the caller after a successful commit
 * (`recordIngestUsage`), never inside `checkIngestQuota`.
 */

import * as path from 'node:path';
import { logger } from './core.js';
import { isValidTenantSlug } from './entity-scope.js';
import * as pathResolver from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

/** Governance policy file (same directory + override shape as spend-policy.json). */
export const INGEST_QUOTA_POLICY_REPO_PATH =
  'knowledge/product/governance/ingest-quota-policy.json';

/** Where the per-tenant daily counters live (retention catalog: 30d TTL). */
export const INGEST_QUOTA_COUNTER_REPO_SUBPATH = 'active/shared/runtime/ingest/quota';

export interface IngestQuotaLimits {
  max_files_per_day: number;
  max_bytes_per_day: number;
}

export interface IngestQuotaOverride extends Partial<IngestQuotaLimits> {
  warn_ratio?: number;
}

export interface IngestQuotaPolicy extends IngestQuotaLimits {
  /** Fraction of a limit at which the level becomes 'warn' (0 < ratio <= 1). */
  warn_ratio: number;
  /** Per-tenant overrides keyed by tenant slug (spend-policy.json pattern). */
  tenant_overrides?: Record<string, IngestQuotaOverride>;
}

export const DEFAULT_INGEST_QUOTA_POLICY: IngestQuotaPolicy = Object.freeze({
  max_files_per_day: 200,
  max_bytes_per_day: 50 * 1024 * 1024,
  warn_ratio: 0.8,
});

const INGEST_QUOTA_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/ingest-quota-policy.schema.json'
);
const INGEST_QUOTA_COUNTER_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/ingest-quota-counter.schema.json'
);

interface IngestQuotaCounterRecord {
  tenant_slug: string;
  date: string;
  files: number;
  bytes: number;
  updated_at: string;
}

function createIngestQuotaPolicyCatalog(rootDir: string) {
  return defineCatalog<IngestQuotaPolicy>({
    id: 'ingest-quota-policy',
    path: assertSafeRepositoryPath(
      path.join(rootDir, ...INGEST_QUOTA_POLICY_REPO_PATH.split('/')),
      { allowMissingLeaf: true, rootDir }
    ),
    schema: INGEST_QUOTA_POLICY_SCHEMA_PATH,
    fallback: DEFAULT_INGEST_QUOTA_POLICY,
    fallbackOnInvalid: true,
  });
}

const defaultIngestQuotaPolicyCatalog = createIngestQuotaPolicyCatalog(pathResolver.rootDir());

export type IngestQuotaLevel = 'ok' | 'warn' | 'block';
export type IngestQuotaDimension = 'files' | 'bytes';

export interface IngestQuotaUsage {
  files: number;
  bytes: number;
}

export interface IngestQuotaCheck {
  allowed: boolean;
  level: IngestQuotaLevel;
  tenant_slug: string;
  /** UTC day the counters belong to (YYYY-MM-DD). */
  date: string;
  /** Usage already recorded for the day (before this ingest). */
  usage: IngestQuotaUsage;
  /** Usage + the incoming ingest. */
  projected: IngestQuotaUsage;
  limit: IngestQuotaLimits;
  /** Dimensions whose projected usage exceeds the limit (block). */
  exceeded: IngestQuotaDimension[];
  /** Dimensions whose projected usage crossed the warn threshold. */
  warned: IngestQuotaDimension[];
}

/** Path/clock seam — hermetic tests pass a fixture rootDir and a fixed now. */
export interface IngestQuotaOptions {
  rootDir?: string;
  now?: string | Date;
  policy?: IngestQuotaPolicy;
  env?: NodeJS.ProcessEnv;
}

function assertTenantSlug(slug: string): void {
  if (!isValidTenantSlug(slug)) {
    throw new Error(`[ingest-quota] invalid tenant slug '${slug}'`);
  }
}

function resolveRootDir(options: IngestQuotaOptions): string {
  const candidate = path.resolve(options.rootDir ?? pathResolver.rootDir());
  const relative = path.relative(pathResolver.rootDir(), candidate).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[RESOURCE_PATH_SCOPE] ingest quota root is outside the repository: ${candidate}`
    );
  }
  assertSafeRepositoryPath(path.join(candidate, '.ingest-quota-root'), {
    allowMissingLeaf: true,
  });
  return candidate;
}

/** UTC calendar day for the injectable clock (spend-guard counts per UTC day too). */
export function ingestQuotaDateKey(now?: string | Date): string {
  const at = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`[ingest-quota] invalid now '${String(now)}'`);
  }
  return at.toISOString().slice(0, 10);
}

/** Absolute counter path for one tenant × UTC day. */
export function ingestQuotaCounterPath(
  tenantSlug: string,
  options: IngestQuotaOptions = {}
): string {
  assertTenantSlug(tenantSlug);
  const date = ingestQuotaDateKey(options.now);
  const root = resolveRootDir(options);
  return assertSafeRepositoryPath(
    path.join(root, ...INGEST_QUOTA_COUNTER_REPO_SUBPATH.split('/'), tenantSlug, `${date}.json`),
    { allowMissingLeaf: true }
  );
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Load the governed quota policy. A missing or broken policy file must not
 * silently disable the guard — it falls back to the defaults, exactly like
 * `loadSpendPolicy`.
 */
export function loadIngestQuotaPolicy(options: IngestQuotaOptions = {}): IngestQuotaPolicy {
  const catalog =
    options.rootDir === undefined
      ? defaultIngestQuotaPolicyCatalog
      : createIngestQuotaPolicyCatalog(resolveRootDir(options));
  const parsed = catalog.load();
  const tenantOverrides: Record<string, IngestQuotaOverride> = {};
  for (const [tenant, raw] of Object.entries(parsed.tenant_overrides ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const override: IngestQuotaOverride = {};
    if (isPositive(raw.max_files_per_day)) override.max_files_per_day = raw.max_files_per_day;
    if (isPositive(raw.max_bytes_per_day)) override.max_bytes_per_day = raw.max_bytes_per_day;
    if (isPositive(raw.warn_ratio) && raw.warn_ratio <= 1) override.warn_ratio = raw.warn_ratio;
    if (Object.keys(override).length > 0) tenantOverrides[tenant] = override;
  }
  return {
    max_files_per_day: isPositive(parsed.max_files_per_day)
      ? parsed.max_files_per_day
      : DEFAULT_INGEST_QUOTA_POLICY.max_files_per_day,
    max_bytes_per_day: isPositive(parsed.max_bytes_per_day)
      ? parsed.max_bytes_per_day
      : DEFAULT_INGEST_QUOTA_POLICY.max_bytes_per_day,
    warn_ratio:
      isPositive(parsed.warn_ratio) && parsed.warn_ratio <= 1
        ? parsed.warn_ratio
        : DEFAULT_INGEST_QUOTA_POLICY.warn_ratio,
    ...(Object.keys(tenantOverrides).length > 0 ? { tenant_overrides: tenantOverrides } : {}),
  };
}

/**
 * Effective policy for one tenant: base policy with that tenant's overrides
 * applied; unknown tenants keep the base (spend-guard
 * `resolveSpendPolicyForTenant` pattern).
 */
export function resolveIngestQuotaForTenant(
  policy: IngestQuotaPolicy,
  tenantSlug: string
): { limits: IngestQuotaLimits; warn_ratio: number } {
  const override = policy.tenant_overrides?.[tenantSlug];
  return {
    limits: {
      max_files_per_day: override?.max_files_per_day ?? policy.max_files_per_day,
      max_bytes_per_day: override?.max_bytes_per_day ?? policy.max_bytes_per_day,
    },
    warn_ratio: override?.warn_ratio ?? policy.warn_ratio,
  };
}

function readUsage(
  counterPath: string,
  expectedTenantSlug?: string,
  expectedDate?: string
): IngestQuotaUsage {
  if (!safeExistsSync(counterPath)) return { files: 0, bytes: 0 };
  try {
    const safeCounterPath = assertSafeRepositoryPath(counterPath, { allowMissingLeaf: true });
    if (!safeLstat(safeCounterPath).isFile()) return { files: 0, bytes: 0 };
    const parsed = defineCatalog<IngestQuotaCounterRecord>({
      id: 'ingest-quota-counter',
      path: safeCounterPath,
      schema: INGEST_QUOTA_COUNTER_SCHEMA_PATH,
    }).load();
    if (
      (expectedTenantSlug !== undefined && parsed.tenant_slug !== expectedTenantSlug) ||
      (expectedDate !== undefined && parsed.date !== expectedDate)
    ) {
      return { files: 0, bytes: 0 };
    }
    return {
      files: isPositive(parsed.files) ? Math.floor(parsed.files) : 0,
      bytes: isPositive(parsed.bytes) ? Math.floor(parsed.bytes) : 0,
    };
  } catch {
    // A corrupt counter must not open the gate wide OR wedge it shut: treat
    // the day as unrecorded (fresh counter) — the limits still apply to the
    // incoming ingest itself.
    return { files: 0, bytes: 0 };
  }
}

/**
 * Would this ingest fit today's budget? Pure read — records nothing (the
 * caller records with {@link recordIngestUsage} only after a successful
 * commit, so refused or failed ceremonies never consume quota).
 */
export function checkIngestQuota(
  tenantSlug: string,
  incoming: { bytes: number; files?: number },
  options: IngestQuotaOptions = {}
): IngestQuotaCheck {
  assertTenantSlug(tenantSlug);
  const incomingBytes = Math.max(0, Math.floor(Number(incoming?.bytes) || 0));
  const incomingFiles = Math.max(0, Math.floor(Number(incoming?.files ?? 1) || 0));
  const policy = options.policy ?? loadIngestQuotaPolicy(options);
  const { limits, warn_ratio: warnRatio } = resolveIngestQuotaForTenant(policy, tenantSlug);
  const date = ingestQuotaDateKey(options.now);
  const usage = readUsage(ingestQuotaCounterPath(tenantSlug, options), tenantSlug, date);
  const projected: IngestQuotaUsage = {
    files: usage.files + incomingFiles,
    bytes: usage.bytes + incomingBytes,
  };

  const exceeded: IngestQuotaDimension[] = [];
  if (projected.files > limits.max_files_per_day) exceeded.push('files');
  if (projected.bytes > limits.max_bytes_per_day) exceeded.push('bytes');

  const warned: IngestQuotaDimension[] = [];
  if (projected.files >= warnRatio * limits.max_files_per_day) warned.push('files');
  if (projected.bytes >= warnRatio * limits.max_bytes_per_day) warned.push('bytes');

  const level: IngestQuotaLevel = exceeded.length > 0 ? 'block' : warned.length > 0 ? 'warn' : 'ok';
  const result: IngestQuotaCheck = {
    allowed: level !== 'block',
    level,
    tenant_slug: tenantSlug,
    date,
    usage,
    projected,
    limit: limits,
    exceeded,
    warned,
  };
  if (level !== 'ok') {
    logger.warn(
      `[ingest-quota] ${level}: tenant '${tenantSlug}' ${date} — ` +
        `files ${projected.files}/${limits.max_files_per_day}, ` +
        `bytes ${projected.bytes}/${limits.max_bytes_per_day}` +
        (level === 'block'
          ? ' — refusing the ingest; raise the limit in ingest-quota-policy.json or retry tomorrow'
          : '')
    );
  }
  return result;
}

/**
 * Record one successful ingest against today's counter. Call ONLY after the
 * commit landed — a blocked or failed ceremony consumes no quota.
 */
export function recordIngestUsage(
  tenantSlug: string,
  bytes: number,
  files = 1,
  options: IngestQuotaOptions = {}
): IngestQuotaUsage {
  assertTenantSlug(tenantSlug);
  const counterPath = ingestQuotaCounterPath(tenantSlug, options);
  const date = ingestQuotaDateKey(options.now);
  const usage = readUsage(counterPath, tenantSlug, date);
  const next: IngestQuotaUsage = {
    files: usage.files + Math.max(0, Math.floor(Number(files) || 0)),
    bytes: usage.bytes + Math.max(0, Math.floor(Number(bytes) || 0)),
  };
  safeMkdir(path.dirname(counterPath), { recursive: true });
  const validated = defineCatalog<IngestQuotaCounterRecord>({
    id: 'ingest-quota-counter',
    path: counterPath,
    schema: INGEST_QUOTA_COUNTER_SCHEMA_PATH,
  }).validate(
    {
      tenant_slug: tenantSlug,
      date,
      ...next,
      updated_at: options.now === undefined ? nowIso() : nowIso(new Date(options.now)),
    },
    counterPath
  );
  safeWriteFile(counterPath, JSON.stringify(validated, null, 2));
  return next;
}

/**
 * Enforcement gate for callers (ingest:commit): same VITEST convention as
 * spend-guard's `enforceSpendGuardForReasoning` — unit tests must not read
 * the real policy/counters unless they opt in with
 * `KYBERION_INGEST_QUOTA_TEST=1`.
 */
export function shouldEnforceIngestQuota(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST && env.KYBERION_INGEST_QUOTA_TEST !== '1') return false;
  return true;
}
