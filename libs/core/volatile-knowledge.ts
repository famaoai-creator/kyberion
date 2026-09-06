import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/json.js';
import * as pathResolver from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';
import type { VolatileCadence, VolatileScope } from './path-resolver.js';

export type { VolatileCadence, VolatileScope } from './path-resolver.js';

export type VolatileStatus = 'active' | 'expired' | 'rolled-over' | 'promoted' | 'archived';
export type VolatileTier = 'personal' | 'confidential' | 'public';
export type VolatileLifetime =
  'session' | 'mission' | 'daily' | 'weekly' | 'ttl' | 'until-distilled' | 'sticky';

export interface VolatileSidecar {
  $schema: string;
  scope: VolatileScope;
  scope_ref: string | null;
  cadence: VolatileCadence;
  period_key: string | null;
  tier: VolatileTier;
  lifetime: VolatileLifetime;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  rollover_to: string | null;
  rollup_to: string | null;
  promote_target: string | null;
  promotion_candidate_id: string | null;
  status: VolatileStatus;
  pinned: boolean;
}

const VOLATILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/volatile-knowledge.schema.json'
);
const DEFAULT_SCHEMA_REF = '../../../schemas/volatile-knowledge.schema.json';

const VOLATILE_SCOPES = new Set<VolatileScope>([
  'session',
  'mission',
  'project',
  'personal',
  'tenant',
  'global',
]);
const VOLATILE_CADENCES = new Set<VolatileCadence>(['resident', 'daily', 'weekly', 'adhoc-ttl']);
const VOLATILE_TIERS = new Set<VolatileTier>(['personal', 'confidential', 'public']);
const VOLATILE_LIFETIMES = new Set<VolatileLifetime>([
  'session',
  'mission',
  'daily',
  'weekly',
  'ttl',
  'until-distilled',
  'sticky',
]);
const VOLATILE_STATUSES = new Set<VolatileStatus>([
  'active',
  'expired',
  'rolled-over',
  'promoted',
  'archived',
]);

function sidecarCatalog(filePath: string) {
  return defineCatalog<Record<string, unknown>>({
    id: 'volatile-knowledge-sidecar',
    path: filePath,
    schema: VOLATILE_SCHEMA_PATH,
  });
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNullableText(value: unknown): value is string | null {
  return value === null || nonEmptyText(value);
}

/** Parse and validate one volatile sidecar against the canonical schema. */
export function parseVolatileSidecar(
  value: unknown,
  sourcePath = 'volatile knowledge sidecar'
): VolatileSidecar | null {
  try {
    const original = parseSafeJsonObjectValue(value, sourcePath);
    const record = sidecarCatalog(VOLATILE_SCHEMA_PATH).validate(original, sourcePath);
    const scopeRef = record.scope_ref;
    const periodKey = record.period_key;
    const expiresAt = record.expires_at;
    const rolloverTo = record.rollover_to;
    const rollupTo = record.rollup_to;
    const promoteTarget = record.promote_target;
    const promotionCandidateId = record.promotion_candidate_id;
    if (
      !VOLATILE_SCOPES.has(record.scope as VolatileScope) ||
      !isNullableText(scopeRef) ||
      !VOLATILE_CADENCES.has(record.cadence as VolatileCadence) ||
      !isNullableText(periodKey) ||
      !VOLATILE_TIERS.has(record.tier as VolatileTier) ||
      !VOLATILE_LIFETIMES.has(record.lifetime as VolatileLifetime) ||
      !isNullableText(expiresAt) ||
      !isNullableText(rolloverTo) ||
      !isNullableText(rollupTo) ||
      !isNullableText(promoteTarget) ||
      !isNullableText(promotionCandidateId) ||
      !nonEmptyText(record.created_at) ||
      !nonEmptyText(record.updated_at) ||
      !isIsoDateTime(record.created_at) ||
      !isIsoDateTime(record.updated_at) ||
      !VOLATILE_STATUSES.has(record.status as VolatileStatus) ||
      (record.pinned !== undefined && typeof record.pinned !== 'boolean')
    ) {
      return null;
    }

    const lifetime = record.lifetime as VolatileLifetime;
    const cadence = record.cadence as VolatileCadence;
    if (
      ((cadence === 'daily' || cadence === 'weekly') &&
        (typeof periodKey !== 'string' || typeof expiresAt !== 'string')) ||
      (lifetime === 'ttl' && typeof expiresAt !== 'string') ||
      (typeof expiresAt === 'string' && !isIsoDateTime(expiresAt))
    ) {
      return null;
    }

    return {
      $schema: typeof original.$schema === 'string' ? original.$schema : DEFAULT_SCHEMA_REF,
      scope: record.scope as VolatileScope,
      scope_ref: scopeRef ?? null,
      cadence,
      period_key: periodKey ?? null,
      tier: record.tier as VolatileTier,
      lifetime,
      expires_at: expiresAt ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
      rollover_to: rolloverTo ?? null,
      rollup_to: rollupTo ?? null,
      promote_target: promoteTarget ?? null,
      promotion_candidate_id: promotionCandidateId ?? null,
      status: record.status as VolatileStatus,
      pinned: record.pinned === undefined ? false : (record.pinned as boolean),
    };
  } catch {
    return null;
  }
}

/** Load a regular repository sidecar; malformed input is treated as absent. */
export function loadVolatileSidecarAtPath(filePath: string): VolatileSidecar | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
  try {
    return parseVolatileSidecar(sidecarCatalog(safePath).load(), safePath);
  } catch {
    return null;
  }
}

/** Validate and persist a volatile sidecar through the canonical catalog. */
export function saveVolatileSidecarAtPath(
  filePath: string,
  sidecar: VolatileSidecar
): VolatileSidecar {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const parsed = parseVolatileSidecar(sidecar, safePath);
  if (!parsed) throw new Error(`Invalid volatile knowledge sidecar at ${safePath}`);
  const validated = sidecarCatalog(safePath).validate(parsed, safePath);
  safeWriteFile(safePath, JSON.stringify({ $schema: parsed.$schema, ...validated }, null, 2));
  return parsed;
}

export function volatileSidecarPath(mdPath: string): string {
  const candidate = mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.volatile.json'
    : `${mdPath}.volatile.json`;
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}
