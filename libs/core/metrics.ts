import { appendJsonLine, readJsonLines } from './foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import chalk from 'chalk';
import { createLogger } from './logger.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { normalizeUsageCause, type UsageCause } from './usage-accounting.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { clamp } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import {
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  STORAGE_DATA_TIERS,
  SYSTEM_PARTITION,
  UNTENANTED_PARTITION_SEGMENT,
  metricsLedgerLockId,
  metricsRowTenant,
  partitionedLedgerProtectedPrefixes,
  storagePartitionSegments,
  type StorageDataTier,
  type StoragePartition,
} from './storage-layout.js';
import { validateReadPermission } from './tier-guard.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { withExecutionContext } from './authority.js';
import { withLockSync } from './foundation/lock-utils.js';
const logger = createLogger('metrics');

interface SloTarget {
  latency_ms: number;
  success_rate?: number;
}

interface SloTargets {
  _note?: string;
  default: SloTarget;
  critical_path?: Record<string, SloTarget>;
}

const SLO_TARGETS_SCHEMA_PATH = pathResolver.knowledge('product/schemas/slo-targets.schema.json');
const sloTargetsCatalogs = new Map<string, ReturnType<typeof defineCatalog<SloTargets>>>();

function sloTargetsCatalog(filePath: string): ReturnType<typeof defineCatalog<SloTargets>> {
  const existing = sloTargetsCatalogs.get(filePath);
  if (existing) return existing;
  const catalog = defineCatalog<SloTargets>({
    id: 'slo-targets',
    path: filePath,
    schema: SLO_TARGETS_SCHEMA_PATH,
  });
  sloTargetsCatalogs.set(filePath, catalog);
  return catalog;
}

/**
 * Lightweight metrics collection for Kyberion.
 * Standardized with Secure-IO.
 */

const DEFAULT_METRICS_DIR = pathResolver.resolve('work/metrics');
const DEFAULT_METRICS_FILE = 'execution-metrics.jsonl';
const DEFAULT_RESOURCE_USAGE_FILE = 'resource-usage.jsonl';
const DEFAULT_MEMORY_BUDGET_MB = 200;

/**
 * Metrics ledger partitioning (state purpose, runtime-storage-layout).
 *
 * Both ledgers the collector writes — execution metrics (`record`) and
 * resource usage (`recordResourceUsage`) — keep their repo-wide file under
 * `work/metrics/` as the SYSTEM partition: rows with no scope, or a public
 * scope without a tenant. A row whose scope carries a tenant, or is
 * personal / confidential, is durable tier data and lands in its own
 * partition below the ledger's root:
 * `<root>/<tier>/<tenant|shared>/<file>.jsonl`.
 * The personal / confidential subtrees are `tenant_scope.protected_prefixes`
 * in security-policy.json, so tier-guard denies a tenant-bound process another
 * tenant's partition on every read and write, and a persona reads a partition
 * only when it may read `knowledge/<tier>/`.
 */
export const RESOURCE_USAGE_LEDGER_ROOT = PARTITIONED_RUNTIME_LEDGER_ROOTS.resource_usage;
const RESOURCE_USAGE_PARTITION_FILE = 'resource-usage.jsonl';
export const EXECUTION_METRICS_LEDGER_ROOT = PARTITIONED_RUNTIME_LEDGER_ROOTS.execution_metrics;
const EXECUTION_METRICS_PARTITION_FILE = 'execution-metrics.jsonl';

/** Tenant-protected prefixes of the partitioned usage ledger (mirrored in security-policy.json). */
export function resourceUsageProtectedPrefixes(): string[] {
  return partitionedLedgerProtectedPrefixes(RESOURCE_USAGE_LEDGER_ROOT);
}

/** Tenant-protected prefixes of the partitioned execution-metrics ledger (mirrored in security-policy.json). */
export function executionMetricsProtectedPrefixes(): string[] {
  return partitionedLedgerProtectedPrefixes(EXECUTION_METRICS_LEDGER_ROOT);
}

/** `tenant_id` is the legacy alias some pre-canonical scopes still carry. */
type UsageScopeRef = { tier?: string; tenant_slug?: string; tenant_id?: string };

/** Partition a ledger row belongs to: system unless it carries a tenant or a non-public tier. */
export function metricsLedgerPartition(scope?: UsageScopeRef): StoragePartition {
  if (!scope) return SYSTEM_PARTITION;
  const tier = scope.tier ?? 'public';
  if (!STORAGE_DATA_TIERS.includes(tier as StorageDataTier)) {
    throw new Error(`[METRICS_LEDGER_SCOPE_INVALID] tier '${String(scope.tier)}'`);
  }
  const tenant = String(scope.tenant_slug ?? scope.tenant_id ?? '').trim();
  if (tenant) return { kind: 'tier', tier: tier as StorageDataTier, tenant };
  if (tier === 'public') return SYSTEM_PARTITION;
  return { kind: 'tier', tier: tier as StorageDataTier };
}

/** Partition of a resource-usage record (same rule for every metrics ledger). */
export const resourceUsagePartition = metricsLedgerPartition;

/**
 * A personal/confidential scope without a tenant, recorded by a tenant-bound
 * process, belongs to that tenant: its `<tier>/shared/` partition is denied to
 * a bound process (tier-guard scope_invalid_prefix), so the row would be lost.
 */
function withBoundTenant(scope: EventScopeInput): EventScopeInput {
  if (scope.tenant_slug || scope.tenant_id) return scope;
  if (scope.tier !== 'personal' && scope.tier !== 'confidential') return scope;
  const bound = resolvePolicyIdentityContext().tenantSlug;
  return bound ? { ...scope, tenant_slug: bound } : scope;
}

function partitionKey(partition: StoragePartition): string {
  return storagePartitionSegments(partition).join('/');
}

/** Partition of a stored or new row (scope tier + metricsRowTenant); throws when unplaceable. */
export function metricsRowPartition(row: { scope?: unknown }): StoragePartition {
  const scope = row.scope;
  if (scope !== undefined && (typeof scope !== 'object' || scope === null)) {
    throw new Error('[METRICS_LEDGER_SCOPE_INVALID] scope is not an object');
  }
  const tenant = metricsRowTenant(row);
  if (!scope && !tenant) return SYSTEM_PARTITION;
  const partition = metricsLedgerPartition({
    tier: (scope as UsageScopeRef | undefined)?.tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
  });
  storagePartitionSegments(partition); // throws on an invalid tenant slug
  return partition;
}

/** Partition key of a stored record; a malformed scope never matches a scoped reader. */
function recordPartitionKey(record: { scope?: unknown }): string {
  try {
    return partitionKey(metricsRowPartition(record));
  } catch {
    return '(invalid)';
  }
}

export { metricsLedgerLockId, metricsRowTenant };

/**
 * Which partitions a metrics-ledger reader sees (both ledgers).
 * - omitted: the system partition only (public, untenanted records).
 * - `scope`: the partition of one owner scope (e.g. a mission's tier/tenant),
 *   plus the system partition when `includeSystem` is set.
 * - `tenants`: every tier partition of the named tenants (tenant-scoped report),
 *   plus the system partition when `includeSystem` is set.
 * - `all`: operator aggregate — the system file plus every partition this
 *   process may read; tier-guard skips partitions of other tenants when the
 *   process is tenant-bound, and personal/confidential partitions whose
 *   `knowledge/<tier>/` the persona may not read.
 */
export type MetricsLedgerReadScope =
  | { scope: UsageScopeRef; includeSystem?: boolean }
  | { tenants: readonly string[]; includeSystem?: boolean }
  | { all: true };
export type ResourceUsageReadScope = MetricsLedgerReadScope;
export type ExecutionMetricsReadScope = MetricsLedgerReadScope;

/**
 * One metrics ledger split into its system file and tier/tenant partition
 * files. The single mechanism behind both ledgers: placement, partition
 * listing, reader scoping, legacy-row gating and the tier-guard read check.
 */
class PartitionedMetricsLedger {
  constructor(
    private readonly label: string,
    private readonly root: string,
    private readonly fileName: string
  ) {}

  partitionPath(partition: StoragePartition): string {
    return assertSafeRepositoryPath(
      path.join(this.root, ...storagePartitionSegments(partition), this.fileName),
      { allowMissingLeaf: true }
    );
  }

  /**
   * Append one row to its partition (created on demand) or, under the ledger
   * lock, to the system file. A row whose scope cannot be placed (unknown
   * tier, invalid tenant slug) is still counted, never downgraded: it keeps
   * its tier (an unknown tier fails closed to confidential; a public one goes
   * to the system file), takes the bound tenant or the `shared` segment,
   * drops its tenant fields, is flagged `scope_invalid: true`, and a warn
   * line names the producer's error.
   */
  append(row: Record<string, unknown>, systemFile: () => string): void {
    let placed = row;
    let partition: StoragePartition;
    try {
      partition = metricsRowPartition(row);
    } catch (err) {
      const {
        scope: rawScope,
        tenant_slug: _tenantSlug,
        tenant: _tenant,
        tenant_id: _tenantId,
        ...rest
      } = row;
      const rawTier =
        rawScope && typeof rawScope === 'object'
          ? (rawScope as { tier?: unknown }).tier
          : undefined;
      const tier: StorageDataTier =
        rawTier === 'public' || rawTier === 'personal' ? rawTier : 'confidential';
      const bound = resolvePolicyIdentityContext().tenantSlug;
      partition =
        tier === 'public'
          ? SYSTEM_PARTITION
          : { kind: 'tier', tier, ...(bound ? { tenant: bound } : {}) };
      placed = {
        ...rest,
        ...(tier === 'public' ? {} : { scope: { tier, ...(bound ? { tenant_slug: bound } : {}) } }),
        scope_invalid: true,
      };
      logger.warn(
        `${this.label} row scope cannot be placed — recorded in ${partitionKey(partition)} with scope_invalid (tier kept, never downgraded) | next: fix the producer's scope (tier personal/confidential/public, valid tenant slug) | evidence: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (partition.kind === 'system') {
      const filePath = systemFile();
      withLockSync(metricsLedgerLockId(filePath), () => {
        ensureRegularFile(filePath);
        appendJsonLine(filePath, placed);
      });
      return;
    }
    const filePath = this.partitionPath(partition);
    const dir = path.dirname(filePath);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    ensureRegularFile(filePath);
    appendJsonLine(filePath, placed);
  }

  /**
   * Rows for one reader scope: the system file's rows (`legacy`, already read
   * by the caller) filtered by their own scope, plus the wanted partitions.
   * Legacy rows that predate partitioning stay in the system file; in every
   * mode a legacy tier row is visible only where its partition would be (it
   * inherits tier-guard's read decision for that partition's path).
   */
  select<T extends { scope?: unknown }>(
    legacy: T[],
    read: MetricsLedgerReadScope | undefined,
    readFile: (filePath: string) => T[],
    onWithheld?: (partitions: number) => void
  ): T[] {
    let rows: T[];
    let files: string[];
    // Partitions (keyed `<tier>/<tenant|shared>`) tier-guard withheld from this reader.
    const withheld = new Set<string>();
    if (read && 'all' in read && read.all) {
      rows = this.visibleLegacyRows(legacy, withheld);
      files = this.partitionFiles();
    } else {
      const wanted = new Map<string, StoragePartition>();
      const want = (partition: StoragePartition) => wanted.set(partitionKey(partition), partition);
      try {
        if (!read || ('includeSystem' in read && read.includeSystem)) want(SYSTEM_PARTITION);
        if (read && 'scope' in read) {
          want(metricsLedgerPartition(withBoundTenant(read.scope as EventScopeInput)));
        } else if (read && 'tenants' in read) {
          for (const tenant of read.tenants) {
            for (const tier of STORAGE_DATA_TIERS) want({ kind: 'tier', tier, tenant });
          }
        }
        files = [...wanted.values()]
          .filter((partition) => partition.kind !== 'system')
          .map((partition) => this.partitionPath(partition));
      } catch (err) {
        logger.warn(
          `${this.label} read refused — invalid reader scope | next: pass a valid tier/tenant | evidence: ${err}`
        );
        return [];
      }
      rows = this.visibleLegacyRows(
        legacy.filter((row) => wanted.has(recordPartitionKey(row))),
        withheld
      );
    }
    for (const filePath of files) {
      if (this.readable(filePath, withheld)) rows.push(...readFile(filePath));
    }
    if (onWithheld && withheld.size > 0) onWithheld(withheld.size);
    return rows;
  }

  /** Legacy rows this process may see: system rows, plus tier rows whose partition it may read. */
  private visibleLegacyRows<T extends { scope?: unknown }>(rows: T[], withheld: Set<string>): T[] {
    const readable = new Map<string, boolean>();
    return rows.filter((row) => {
      const key = recordPartitionKey(row);
      if (key === partitionKey(SYSTEM_PARTITION)) return true;
      if (!readable.has(key)) {
        let allowed = false;
        try {
          const partitionPath = this.partitionPath(metricsRowPartition(row));
          allowed = this.permitted(partitionPath, 'legacy rows');
        } catch {
          allowed = false;
        }
        if (!allowed) withheld.add(key);
        readable.set(key, allowed);
      }
      return readable.get(key) === true;
    });
  }

  /** An existing partition file this process may read (tier-guard: tenant + persona). */
  private readable(filePath: string, withheld: Set<string>): boolean {
    try {
      if (!safeExistsSync(filePath)) return false;
    } catch {
      return false;
    }
    const allowed = this.permitted(filePath, 'partition');
    if (!allowed)
      withheld.add(path.relative(this.root, path.dirname(filePath)).split(path.sep).join('/'));
    return allowed;
  }

  private permitted(filePath: string, what: string): boolean {
    const decision = validateReadPermission(filePath);
    if (!decision.allowed) {
      logger.debug(
        `${this.label} ${what} skipped — tier-guard denies this reader | next: read as a persona and tenant binding allowed for this tier | evidence: ${path.relative(pathResolver.rootDir(), filePath)}: ${decision.reason ?? 'denied'}`
      );
    }
    return decision.allowed;
  }

  /** Every partition file under the root (`<tier>/<tenant|shared>/<file>`). */
  partitionFiles(): string[] {
    const list = (dir: string): string[] => {
      try {
        return safeExistsSync(dir) ? safeReaddir(dir).sort() : [];
      } catch (err) {
        logger.debug(
          `${this.label} partition listing skipped — unreadable directory | next: check the ledger root | evidence: ${dir}: ${err}`
        );
        return [];
      }
    };
    const files: string[] = [];
    for (const tier of list(this.root)) {
      if (!STORAGE_DATA_TIERS.includes(tier as StorageDataTier)) continue;
      for (const tenant of list(path.join(this.root, tier))) {
        try {
          files.push(
            this.partitionPath({
              kind: 'tier',
              tier: tier as StorageDataTier,
              tenant: tenant === UNTENANTED_PARTITION_SEGMENT ? undefined : tenant,
            })
          );
        } catch {
          // Not a partition directory (invalid tenant segment): ignore.
        }
      }
    }
    return files;
  }
}

export interface CostRate {
  prompt: number;
  completion: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
}
export interface CostTier extends CostRate {
  /** Inclusive input-token threshold for this rate, stored per 1k tokens. */
  input_tokens_above: number;
}
export interface ModelCostEntry extends CostRate {
  tiers?: CostTier[];
}
export interface ModelCostRegistry {
  models: Record<string, ModelCostEntry>;
  aliases?: Record<string, string>;
  default: ModelCostEntry;
}

interface ModelCostRegistryFile extends ModelCostRegistry {
  version: string;
  currency: string;
  unit: string;
  note?: string;
}

// Model pricing is data, not code: it lives in a knowledge-tier registry so models
// can be added / repriced without a source change or redeploy. The file is the
// source of truth; an empty zero-rate registry keeps observability available when
// the primary registry is missing or malformed without maintaining a second copy
// of governance data. All rates are per-1k tokens.
const COST_REGISTRY_PATH = pathResolver.resolve(
  'knowledge/product/governance/model-cost-registry.json'
);
const COST_REGISTRY_SCHEMA_PATH = pathResolver.resolve(
  'knowledge/product/schemas/model-cost-registry.schema.json'
);
const EMPTY_COST_REGISTRY: ModelCostRegistry = {
  models: {},
  aliases: {},
  default: { prompt: 0, completion: 0 },
};

let _cachedCostRegistry: ModelCostRegistry | null = null;

const primaryCostRegistryCatalog = defineCatalog<ModelCostRegistryFile>({
  id: 'model-cost-registry',
  path: COST_REGISTRY_PATH,
  schema: COST_REGISTRY_SCHEMA_PATH,
});

function readCostRegistry(): ModelCostRegistry | null {
  try {
    if (!safeExistsSync(COST_REGISTRY_PATH)) return null;
    const parsed = primaryCostRegistryCatalog.load();
    return { models: parsed.models, aliases: parsed.aliases ?? {}, default: parsed.default };
  } catch {
    /* ignore */
  }
  return null;
}

/** Load (and cache) the single model-cost registry from the knowledge tier. */
export function loadModelCostRegistry(): ModelCostRegistry {
  if (_cachedCostRegistry) return _cachedCostRegistry;
  const primary = readCostRegistry();
  if (primary) {
    _cachedCostRegistry = {
      models: {
        ...(primary?.models ?? {}),
      },
      aliases: {
        ...(primary?.aliases ?? {}),
      },
      default: primary.default,
    };
    return _cachedCostRegistry;
  }
  _cachedCostRegistry = EMPTY_COST_REGISTRY;
  return _cachedCostRegistry;
}

/** Test/hot-reload hook: drop the cached registry so the next call re-reads the file. */
export function _resetModelCostRegistryCacheForTests(): void {
  _cachedCostRegistry = null;
  primaryCostRegistryCatalog.reset();
}

function selectTier(entry: ModelCostEntry, inputTokens: number): CostRate {
  if (!entry.tiers?.length) return entry;
  const threshold = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  return (
    [...entry.tiers]
      .filter((tier) => tier.input_tokens_above <= threshold)
      .sort((left, right) => right.input_tokens_above - left.input_tokens_above)[0] ?? entry
  );
}

/**
 * Compare model ids by their alphanumeric skeleton.
 *
 * Providers report display names ("Gemini 3.6 Flash (Medium)", "Claude Opus
 * 5") while the registry is keyed by model ids ("gemini-3.6-flash"). A plain
 * substring match never connects the two, so every such actor silently
 * resolved to the default rate. Stripping separators makes
 * "gemini36flashmedium" contain "gemini36flash" without loosening what counts
 * as a match: candidates are still tried longest-first, so a more specific id
 * (gpt-4o-mini) still wins over a shorter one it contains (gpt-4o).
 */
function costModelSkeleton(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolvePer1kRate(reg: ModelCostRegistry, model: string, inputTokens: number): CostRate {
  const id = (model || '').trim();
  if (!id) return selectTier(reg.default, inputTokens);
  if (reg.models[id]) return selectTier(reg.models[id], inputTokens);
  if (reg.aliases?.[id] && reg.models[reg.aliases[id]])
    return selectTier(reg.models[reg.aliases[id]], inputTokens);
  // Versioned ids and provider display names never exact-match; take the
  // longest model-id or alias contained in the given id.
  const skeleton = costModelSkeleton(id);
  const candidates = [...Object.keys(reg.models), ...Object.keys(reg.aliases ?? {})].sort(
    (a, b) => b.length - a.length
  );
  for (const key of candidates) {
    if (skeleton.includes(costModelSkeleton(key))) {
      const target = reg.models[key] ? key : reg.aliases?.[key];
      if (target && reg.models[target]) return selectTier(reg.models[target], inputTokens);
    }
  }
  return selectTier(reg.default, inputTokens);
}

/**
 * Which registry entry a model id resolved to, or `null` when nothing matched
 * and the registry default was used.
 *
 * `resolveCostRates` silently falls back to the default rate, which is right
 * for best-effort usage accounting but misleading anywhere the rate is
 * presented as *this actor's* price: a display name such as
 * "Gemini 3.6 Flash (Medium)" matches no registry key and would be reported
 * at the default rate as if it were measured. Callers that persist a price
 * record which one they got.
 */
export function resolveCostRateModelKey(model: string): string | null {
  const reg = loadModelCostRegistry();
  const id = (model || '').trim();
  if (!id) return null;
  if (reg.models[id]) return id;
  if (reg.aliases?.[id] && reg.models[reg.aliases[id]]) return reg.aliases[id];
  const skeleton = costModelSkeleton(id);
  const candidates = [...Object.keys(reg.models), ...Object.keys(reg.aliases ?? {})].sort(
    (a, b) => b.length - a.length
  );
  for (const key of candidates) {
    if (skeleton.includes(costModelSkeleton(key))) {
      const target = reg.models[key] ? key : reg.aliases?.[key];
      if (target && reg.models[target]) return target;
    }
  }
  return null;
}

/**
 * Resolve per-TOKEN rates for a model id from the knowledge-tier cost registry.
 * Registry stores per-1k rates; returned rates are per-token (÷1000) for direct
 * multiplication by token counts in `record()`.
 */
export function resolveCostRatesFromRegistry(
  registry: ModelCostRegistry,
  model: string,
  inputTokens = 0
): CostRate {
  const perK = resolvePer1kRate(registry, model, inputTokens);
  return {
    prompt: perK.prompt / 1000,
    completion: perK.completion / 1000,
    ...(perK.cache_read === undefined ? {} : { cache_read: perK.cache_read / 1000 }),
    ...(perK.cache_write === undefined ? {} : { cache_write: perK.cache_write / 1000 }),
    ...(perK.cache_write_1h === undefined ? {} : { cache_write_1h: perK.cache_write_1h / 1000 }),
  };
}

export function resolveCostRates(model: string, inputTokens = 0): CostRate {
  return resolveCostRatesFromRegistry(loadModelCostRegistry(), model, inputTokens);
}

export interface MetricsOptions {
  metricsDir?: string;
  metricsFile?: string;
  persist?: boolean;
  memoryBudgetMB?: number;
  resourceUsageFile?: string;
  /**
   * Root of the tier/tenant-partitioned resource-usage ledgers. Defaults to
   * `<metricsDir>/usage-partitions` for an isolated collector (explicit
   * `metricsDir`), else `active/shared/runtime/usage-ledger`.
   */
  resourceUsageRoot?: string;
  /**
   * Root of the tier/tenant-partitioned execution-metrics ledgers. Defaults to
   * `<metricsDir>/execution-partitions` for an isolated collector (explicit
   * `metricsDir`), else `active/shared/runtime/execution-metrics`.
   */
  executionMetricsRoot?: string;
  /** Optional injected registry for deterministic tests or an isolated runtime. */
  costRegistry?: ModelCostRegistry;
}

export type ResourceUsageKind = 'llm' | 'api' | 'compute' | 'saas' | 'human_time' | 'other';
export type ResourceUsageStatus = 'actual' | 'estimated' | 'committed';

export interface ResourceUsageRecord {
  type: 'resource_usage';
  usage_id: string;
  timestamp: string;
  resource_kind: ResourceUsageKind;
  actor_id?: string;
  mission_id?: string;
  customer_id?: string;
  cost_center?: string;
  quantity: number;
  unit: string;
  unit_cost_usd?: number;
  cost_usd: number;
  status: ResourceUsageStatus;
  source: string;
  /** Canonical containment scope; legacy records may omit it. */
  scope?: EventScope;
  /** Set when the producer's scope could not be placed; the row lives in the system partition. */
  scope_invalid?: true;
  metadata?: Record<string, unknown>;
  cause?: UsageCause;
}

export class MetricsCollector {
  private _metricsDir: string;
  private _metricsFile: string;
  private _persist: boolean;
  private _memoryBudgetMB: number;
  private _resourceUsageFile: string;
  private _usageLedger: PartitionedMetricsLedger;
  private _executionLedger: PartitionedMetricsLedger;
  private _costRegistry?: ModelCostRegistry;
  private _aggregates: Map<string, any>;

  constructor(options: MetricsOptions = {}) {
    this._metricsDir = assertSafeRepositoryPath(options.metricsDir || DEFAULT_METRICS_DIR, {
      allowMissingLeaf: true,
    });
    this._metricsFile = options.metricsFile || DEFAULT_METRICS_FILE;
    this._persist = options.persist !== false;
    this._memoryBudgetMB = options.memoryBudgetMB || DEFAULT_MEMORY_BUDGET_MB;
    this._resourceUsageFile = options.resourceUsageFile || DEFAULT_RESOURCE_USAGE_FILE;
    // Not asserted here: the shared collector is built at import time, and
    // every partition path is asserted when it is read or written.
    this._usageLedger = new PartitionedMetricsLedger(
      'resource usage',
      options.resourceUsageRoot ||
        (options.metricsDir
          ? path.join(this._metricsDir, 'usage-partitions')
          : pathResolver.shared('runtime/usage-ledger')),
      RESOURCE_USAGE_PARTITION_FILE
    );
    this._executionLedger = new PartitionedMetricsLedger(
      'execution metrics',
      options.executionMetricsRoot ||
        (options.metricsDir
          ? path.join(this._metricsDir, 'execution-partitions')
          : pathResolver.shared('runtime/execution-metrics')),
      EXECUTION_METRICS_PARTITION_FILE
    );
    this._costRegistry = options.costRegistry;
    this._aggregates = new Map();
  }

  private _metricsPath(fileName: string): string {
    return assertSafeRepositoryPath(path.join(this._metricsDir, fileName), {
      allowMissingLeaf: true,
    });
  }

  private _ensureRegularMetricsFile(filePath: string): void {
    if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
      throw new Error(`metrics file must be a regular file: ${filePath}`);
    }
  }

  /** Append a normalized, actor-neutral resource usage ledger entry. */
  recordResourceUsage(
    input: Omit<ResourceUsageRecord, 'type' | 'usage_id' | 'timestamp' | 'cost_usd' | 'scope'> & {
      usage_id?: string;
      timestamp?: string;
      cost_usd?: number;
      scope?: EventScopeInput;
    }
  ): ResourceUsageRecord {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error('resource usage quantity must be a finite non-negative number');
    }
    const unitCost = input.unit_cost_usd === undefined ? undefined : Number(input.unit_cost_usd);
    if (unitCost !== undefined && (!Number.isFinite(unitCost) || unitCost < 0)) {
      throw new Error('resource usage unit_cost_usd must be a finite non-negative number');
    }
    const explicitCost = input.cost_usd === undefined ? undefined : Number(input.cost_usd);
    const cost = explicitCost ?? (unitCost === undefined ? 0 : quantity * unitCost);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error('resource usage cost_usd must be a finite non-negative number');
    }
    const missionId = input.mission_id || getRegisteredEnvText('MISSION_ID') || undefined;
    // An invalid scope throws to the caller (its contract: e.g. direct-CLI
    // usage warns and records nothing rather than downgrading a tier).
    const scope = input.scope ? normalizeEventScope(withBoundTenant(input.scope)) : undefined;
    const record: ResourceUsageRecord = {
      type: 'resource_usage',
      usage_id:
        input.usage_id || `${input.resource_kind}:${input.actor_id || 'unknown'}:${Date.now()}`,
      timestamp: input.timestamp || nowIso(),
      resource_kind: input.resource_kind,
      actor_id: input.actor_id,
      mission_id: missionId,
      customer_id: input.customer_id,
      cost_center: input.cost_center,
      quantity,
      unit: input.unit,
      unit_cost_usd: unitCost,
      cost_usd: Math.round(cost * 100000) / 100000,
      status: input.status,
      source: input.source,
      cause: normalizeUsageCause(input.cause),
      ...(scope ? { scope } : {}),
      metadata: input.metadata,
    };
    if (this._persist) this._appendResourceUsage(record);
    return record;
  }

  record(componentName: string, durationMs: number, status: 'success' | 'error', extra: any = {}) {
    const mem = process.memoryUsage();
    const memory = {
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    };

    if (memory.heapUsedMB > this._memoryBudgetMB) {
      logger.warn(
        chalk.yellow(
          `[${componentName}] Memory budget exceeded: ${memory.heapUsedMB}MB (Budget: ${this._memoryBudgetMB}MB)`
        )
      );
    }

    let agg = this._aggregates.get(componentName);
    if (!agg) {
      agg = {
        count: 0,
        errors: 0,
        totalMs: 0,
        minMs: Infinity,
        maxMs: 0,
        lastRun: '',
        peakHeapMB: 0,
        peakRssMB: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cachePurges: 0,
        recoveries: 0,
        interventions: 0,
        totalCostUSD: 0,
        cacheIntegrityFailures: 0,
        outputSizeKB: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
      };
      this._aggregates.set(componentName, agg);
    }
    agg.count++;
    if (status === 'error') agg.errors++;
    if (extra.recovered) agg.recoveries++;
    if (extra.intervention) agg.interventions++;

    agg.totalMs += durationMs;
    agg.minMs = Math.min(agg.minMs, durationMs);
    agg.maxMs = Math.max(agg.maxMs, durationMs);
    agg.lastRun = nowIso();
    agg.peakHeapMB = Math.max(agg.peakHeapMB, memory.heapUsedMB);
    agg.peakRssMB = Math.max(agg.peakRssMB, memory.rssMB);

    if (extra.usage) {
      const pTokens = extra.usage.prompt_tokens || 0;
      const cTokens = extra.usage.completion_tokens || 0;
      const cacheReadTokens =
        extra.usage.cache_read_tokens ?? extra.usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens =
        extra.usage.cache_write_tokens ?? extra.usage.cache_creation_input_tokens ?? 0;
      const cacheWrite1hTokens = extra.usage.cache_write_1h_tokens ?? 0;
      const inputTokens = pTokens + cacheReadTokens + cacheWriteTokens + cacheWrite1hTokens;
      agg.promptTokens += pTokens;
      agg.completionTokens += cTokens;
      agg.cacheReadTokens += cacheReadTokens;
      agg.cacheWriteTokens += cacheWriteTokens;
      agg.cacheWrite1hTokens += cacheWrite1hTokens;
      agg.totalTokens += inputTokens + cTokens;

      const model = extra.model || 'default';
      const rates = resolveCostRatesFromRegistry(
        this._costRegistry ?? loadModelCostRegistry(),
        model,
        inputTokens
      );
      const cost =
        pTokens * rates.prompt +
        cTokens * rates.completion +
        cacheReadTokens * (rates.cache_read ?? 0) +
        cacheWriteTokens * (rates.cache_write ?? 0) +
        cacheWrite1hTokens * (rates.cache_write_1h ?? 0);
      agg.totalCostUSD += cost;
      extra.cost_usd = Math.round(cost * 100000) / 100000;
    }

    if (extra.outputSize) {
      agg.outputSizeKB = Math.max(agg.outputSizeKB, Math.round(extra.outputSize / 1024));
    }

    if (extra.cacheStats) {
      agg.cacheHits += extra.cacheStats.hits || 0;
      agg.cacheMisses += extra.cacheStats.misses || 0;
      agg.cachePurges += extra.cacheStats.purges || 0;
      agg.cacheIntegrityFailures += extra.cacheStats.integrityFailures || 0;
    }

    const missionId = extra.mission_id || getRegisteredEnvText('MISSION_ID') || undefined;
    const scope = executionRowScope(extra.scope);
    const persistedExtra = {
      ...extra,
      cause: normalizeUsageCause(extra.cause),
      ...(missionId ? { mission_id: missionId } : {}),
      ...(scope === undefined ? {} : { scope }),
    };

    if (this._persist) {
      this._appendToFile({
        component: componentName,
        duration_ms: durationMs,
        status,
        timestamp: agg.lastRun,
        memory,
        ...persistedExtra,
      });
    }
  }

  recordIntervention(context: string, decisionId: string) {
    this._appendToFile({
      type: 'intervention',
      context,
      decision: decisionId,
      timestamp: nowIso(),
    });
  }

  summarize() {
    const summaries: any[] = [];
    const TIME_BASE = 5000;
    const MEM_BASE = 200;

    for (const [name, agg] of this._aggregates) {
      const avgMs = agg.count > 0 ? Math.round(agg.totalMs / agg.count) : 0;
      const totalCache = agg.cacheHits + agg.cacheMisses;
      const cacheRatio = totalCache > 0 ? agg.cacheHits / totalCache : 0;

      const timeImpact = Math.min(40, (avgMs / TIME_BASE) * 40);
      const memImpact = Math.min(40, (agg.peakHeapMB / MEM_BASE) * 40);
      const cacheBonus = Math.round(cacheRatio * 20);
      const purgePenalty = Math.min(20, (agg.cachePurges || 0) * 5);

      const efficiencyScore = Math.max(
        0,
        Math.min(100, Math.round(100 - (timeImpact + memImpact) + cacheBonus - purgePenalty))
      );

      summaries.push({
        component: name,
        executions: agg.count,
        errors: agg.errors,
        errorRate: agg.count > 0 ? Math.round((agg.errors / agg.count) * 1000) / 10 : 0,
        avgMs,
        minMs: agg.minMs === Infinity ? 0 : agg.minMs,
        maxMs: agg.maxMs,
        lastRun: agg.lastRun,
        peakHeapMB: agg.peakHeapMB,
        peakRssMB: agg.peakRssMB,
        efficiencyScore,
        cacheHitRatio: Math.round(cacheRatio * 100),
        cachePurges: agg.cachePurges || 0,
        recoveries: agg.recoveries || 0,
        recoveryRate: agg.count > 0 ? Math.round((agg.recoveries / agg.count) * 1000) / 10 : 0,
        cacheIntegrityFailures: agg.cacheIntegrityFailures || 0,
        outputSizeKB: agg.outputSizeKB || 0,
        avgTokens: agg.count > 0 ? Math.round(agg.totalTokens / agg.count) : 0,
        totalTokens: agg.totalTokens,
        cacheReadTokens: agg.cacheReadTokens,
        cacheWriteTokens: agg.cacheWriteTokens,
        cacheWrite1hTokens: agg.cacheWrite1hTokens,
        totalCostUSD: Math.round(agg.totalCostUSD * 1000) / 1000,
        interventions: agg.interventions || 0,
        interventionRate: agg.count > 0 ? Math.round((agg.interventions / agg.count) * 100) : 0,
      });
    }
    return summaries.sort((a, b) => b.executions - a.executions);
  }

  getSkillMetrics(skillName: string) {
    return this._aggregates.get(skillName) || null;
  }

  getCapabilityMetrics(capabilityName: string) {
    return this._aggregates.get(capabilityName) || null;
  }

  /**
   * Read the execution-metrics ledger for one reader scope (see
   * MetricsLedgerReadScope; omitted = the system partition only).
   * Strict consumers distinguish missing history from unreadable/corrupt evidence.
   * With `onMalformed`, strict reads skip torn lines and report them instead of
   * throwing, so the caller can judge whether they matter (e.g. only today's).
   * Rows come back in file order (system file, then partitions), and line
   * numbers count through them as one concatenated file. A partition the
   * process may not read (tier-guard: tenant binding, persona tier rules) is
   * skipped, never an error.
   */
  loadHistory(
    options: {
      strict?: boolean;
      onMalformed?: (lineNumber: number, rawLine: string) => void;
      read?: ExecutionMetricsReadScope;
      /** Called with the number of partitions tier-guard withheld from this reader (if any). */
      onWithheld?: (partitions: number) => void;
    } = {}
  ) {
    let lineOffset = 0;
    const readFile = (filePath: string, optional: boolean): Record<string, any>[] => {
      if (options.strict) {
        try {
          safeLstat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      } else if (!safeExistsSync(filePath)) return [];
      this._ensureRegularMetricsFile(filePath);
      const onMalformed = options.onMalformed;
      const offset = lineOffset;
      let lastLine = 0;
      const rows = readJsonLines<Record<string, any>>(
        assertSafeRepositoryPath(filePath, { allowMissingLeaf: optional }),
        options.strict && onMalformed
          ? {
              map: (value, lineNumber) => {
                lastLine = lineNumber;
                return value as Record<string, any>;
              },
              onMalformed: (_error, lineNumber, rawLine) => {
                lastLine = lineNumber;
                onMalformed(offset + lineNumber, rawLine);
              },
            }
          : {}
      );
      lineOffset += lastLine;
      return rows;
    };
    try {
      const system = readFile(this._metricsPath(this._metricsFile), false);
      return this._executionLedger.select(
        system,
        options.read,
        (filePath) => {
          if (options.strict) return readFile(filePath, true);
          try {
            return readFile(filePath, true);
          } catch (err) {
            // Lenient readers lose one unreadable partition, not the whole history.
            logger.debug(
              `execution metrics partition skipped — unreadable file | next: repair or remove it | evidence: ${filePath}: ${err}`
            );
            return [];
          }
        },
        options.onWithheld
      );
    } catch (error) {
      if (options.strict) throw error;
      return [];
    }
  }

  /**
   * Read the resource-usage ledger for one reader scope (see
   * MetricsLedgerReadScope). Legacy records in the system file that predate
   * partitioning are filtered by their own scope, so a scoped reader still
   * sees its legacy entries and a system reader never sees tenant entries.
   * In every mode a legacy tier row is visible only where its partition would
   * be: it inherits tier-guard's read decision for that partition's path.
   */
  loadResourceUsageHistory(
    read?: ResourceUsageReadScope,
    options: { onWithheld?: (partitions: number) => void } = {}
  ): ResourceUsageRecord[] {
    return this._usageLedger.select(
      this._readUsageFile(this._metricsPath(this._resourceUsageFile)),
      read,
      (filePath) => this._readUsageFile(filePath),
      options.onWithheld
    );
  }

  private _readUsageFile(filePath: string): ResourceUsageRecord[] {
    try {
      if (!safeExistsSync(filePath)) return [];
      this._ensureRegularMetricsFile(filePath);
      return readJsonLines<ResourceUsageRecord>(
        assertSafeRepositoryPath(filePath, { allowMissingLeaf: true })
      );
    } catch (err) {
      logger.debug(
        `resource usage ledger skipped — unreadable file | next: check the file | evidence: ${filePath}: ${err}`
      );
      return [];
    }
  }

  /**
   * Per-component report over the execution-metrics history. `read` picks the
   * partitions (default: the system partition); operator surfaces pass
   * `{ all: true }`. Rows are ordered by timestamp across partitions.
   */
  reportFromHistory(
    read?: ExecutionMetricsReadScope,
    options: { onWithheld?: (partitions: number) => void } = {}
  ) {
    const entries = chronological(this.loadHistory({ read, onWithheld: options.onWithheld }));
    const bySkill: Record<string, any> = {};
    const sloPathCandidates = [
      pathResolver.resolve('knowledge/product/orchestration/slo-targets.json'),
      pathResolver.resolve('knowledge/orchestration/slo-targets.json'),
    ];
    let sloTargets: SloTargets = { default: { latency_ms: 5000 } };
    for (const candidate of sloPathCandidates) {
      try {
        const safeCandidate = assertSafeRepositoryPath(candidate);
        if (!safeExistsSync(safeCandidate)) continue;
        sloTargets = sloTargetsCatalog(safeCandidate).load();
        break;
      } catch {
        // A malformed or symlinked optional SLO registry must not escape its scope.
      }
    }

    for (const entry of entries) {
      const componentName = entry.component || entry.skill || entry.capability;
      if (!componentName) continue;
      if (!bySkill[componentName]) {
        bySkill[componentName] = {
          count: 0,
          errors: 0,
          totalMs: 0,
          minMs: Infinity,
          maxMs: 0,
          cacheHits: 0,
          cacheMisses: 0,
          sloPasses: 0,
        };
      }
      const s = bySkill[componentName];
      s.count++;
      if (entry.status === 'error') s.errors++;
      s.totalMs += entry.duration_ms || 0;
      s.minMs = Math.min(s.minMs, entry.duration_ms || 0);
      s.maxMs = Math.max(s.maxMs, entry.duration_ms || 0);

      const target =
        (sloTargets.critical_path && sloTargets.critical_path[componentName]) || sloTargets.default;
      const isLatencyOk = (entry.duration_ms || 0) <= target.latency_ms;
      if (isLatencyOk && entry.status !== 'error') s.sloPasses++;

      if (entry.cacheStats) {
        s.cacheHits += entry.cacheStats.hits || 0;
        s.cacheMisses += entry.cacheStats.misses || 0;
      }
    }

    const skills = Object.entries(bySkill).map(([name, s]) => {
      const avgMs = s.count > 0 ? Math.round(s.totalMs / s.count) : 0;
      const totalCache = s.cacheHits + s.cacheMisses;
      const cacheHitRatio = totalCache > 0 ? Math.round((s.cacheHits / totalCache) * 100) : 0;
      const sloCompliance = s.count > 0 ? Math.round((s.sloPasses / s.count) * 100) : 0;

      let manualMs = 300000;
      if (name.includes('audit') || name.includes('scan') || name.includes('check'))
        manualMs = 900000;
      else if (name.includes('generate') || name.includes('create') || name.includes('artisan'))
        manualMs = 1800000;
      else if (name.includes('analyze') || name.includes('optimize')) manualMs = 3600000;

      const savedMs = Math.max(0, manualMs * s.count - s.totalMs);
      const savedCost = Math.round((savedMs / 3600000) * 100);

      const TIME_BASE = 5000;
      const timeImpact = Math.min(50, (avgMs / TIME_BASE) * 50);
      const cacheBonus = Math.round((cacheHitRatio / 100) * 20);
      const efficiencyScore = clamp(Math.round(100 - timeImpact + cacheBonus), 0, 100);

      return {
        component: name,
        skill: name,
        executions: s.count,
        errors: s.errors,
        errorRate: s.count > 0 ? Math.round((s.errors / s.count) * 1000) / 10 : 0,
        avgMs,
        minMs: s.minMs === Infinity ? 0 : s.minMs,
        maxMs: s.maxMs,
        cacheHitRatio,
        sloCompliance,
        efficiencyScore,
        manualMs,
        savedMs,
        savedCost,
      };
    });

    return {
      totalEntries: entries.length,
      uniqueSkills: skills.length,
      dateRange:
        entries.length > 0
          ? { from: entries[0].timestamp, to: entries[entries.length - 1].timestamp }
          : null,
      skills: skills.sort((a, b) => b.executions - a.executions),
    };
  }

  /** Latency regressions per skill; `read` as in reportFromHistory. */
  detectRegressions(
    thresholdMultiplier = 1.5,
    read?: ExecutionMetricsReadScope,
    options: { onWithheld?: (partitions: number) => void } = {}
  ) {
    const entries = chronological(this.loadHistory({ read, onWithheld: options.onWithheld }));
    const bySkill: Record<string, any[]> = {};
    for (const entry of entries) {
      if (!bySkill[entry.skill]) bySkill[entry.skill] = [];
      bySkill[entry.skill].push(entry);
    }

    const regressions: any[] = [];
    for (const [name, runs] of Object.entries(bySkill)) {
      if (runs.length < 5) continue;
      const lastRun = runs[runs.length - 1];
      const history = runs.slice(0, -1);
      const avgMs = history.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / history.length;

      if (lastRun.duration_ms > avgMs * thresholdMultiplier) {
        regressions.push({
          skill: name,
          lastDuration: lastRun.duration_ms,
          historicalAvg: Math.round(avgMs),
          increaseRate: Math.round((lastRun.duration_ms / avgMs) * 10) / 10,
          timestamp: lastRun.timestamp,
        });
      }
    }
    return regressions;
  }

  reset() {
    this._aggregates.clear();
  }

  private _appendToFile(entry: any) {
    try {
      this._executionLedger.append(entry, () => this._systemFilePath(this._metricsFile));
      executionMetricsGenerationCounter += 1;
    } catch (err) {
      // Best-effort: never block the operation, but never drop a row silently.
      logger.warn(
        `execution metrics entry not recorded — ${err instanceof Error ? err.message : String(err)} | next: record with a scope this process may write (a tenant-bound process writes only its own tenant partition) | evidence: component=${String(entry.component ?? entry.type ?? 'unknown')}`
      );
    }
  }

  private _appendResourceUsage(entry: ResourceUsageRecord) {
    try {
      this._usageLedger.append(entry as unknown as Record<string, unknown>, () =>
        this._systemFilePath(this._resourceUsageFile)
      );
    } catch (err) {
      // Best-effort: never block the operation, but never drop a row silently.
      logger.warn(
        `resource usage entry not recorded — ${err instanceof Error ? err.message : String(err)} | next: record with a scope this process may write (a tenant-bound process writes only its own tenant partition) | evidence: usage_id=${entry.usage_id}`
      );
    }
  }

  /** A system-partition file under `metricsDir` (created on demand). */
  private _systemFilePath(fileName: string): string {
    const metricsDir = assertSafeRepositoryPath(this._metricsDir, { allowMissingLeaf: true });
    if (!safeExistsSync(metricsDir)) safeMkdir(metricsDir, { recursive: true });
    return this._metricsPath(fileName);
  }
}

/** Rows merged from several partitions, ordered by timestamp (stable; undated rows first). */
function chronological<T extends { timestamp?: unknown }>(rows: T[]): T[] {
  const at = (row: T) => (typeof row.timestamp === 'string' ? row.timestamp : '');
  return [...rows].sort((left, right) =>
    at(left) < at(right) ? -1 : at(left) > at(right) ? 1 : 0
  );
}

/**
 * The scope an execution-metrics row is partitioned by. A tenant-less
 * personal/confidential scope recorded by a tenant-bound process gets its
 * bound tenant stamped on (as for usage rows); anything else is kept as given
 * and validated when the row is placed.
 */
function executionRowScope(scope: unknown): unknown {
  if (!scope || typeof scope !== 'object') return scope;
  const stamped = withBoundTenant(scope as EventScopeInput);
  if (stamped === scope) return scope;
  try {
    return normalizeEventScope(stamped);
  } catch {
    return stamped;
  }
}

function ensureRegularFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`metrics file must be a regular file: ${filePath}`);
  }
}

let executionMetricsGenerationCounter = 0;

/**
 * In-process generation of the execution-metrics ledgers: bumped on every
 * row this process appends, so cached enforcement totals are invalidated by
 * the process's own spend instead of lagging a burst by the cache TTL.
 */
export function executionMetricsGeneration(): number {
  return executionMetricsGenerationCounter;
}

export const metrics = new MetricsCollector();

/**
 * User-facing notice for a report or summary built from a partial metrics
 * read: logs ONE warn line in the diagnostic format and returns the sentence
 * the report shows, or undefined when nothing was withheld.
 */
export function metricsWithheldNotice(reader: string, partitions: number): string | undefined {
  if (!(partitions > 0)) return undefined;
  const notice = `${partitions} metrics partition(s) withheld for this persona — totals are partial`;
  logger.warn(
    `${reader}: ${notice} | next: run as a persona/role allowed to read knowledge/<tier>/ (or the tenant) for full totals | evidence: ${partitions} personal/confidential ledger partition(s) denied by tier-guard`
  );
  return notice;
}

/**
 * Governed system-scope reader of the partitioned metrics ledgers, assumed only
 * inside aggregateMetricsForEnforcement (security-policy.json
 * authority_role_permissions: read-only grant on the two ledger roots).
 */
export const METRICS_CAP_READER_ROLE = 'metrics_cap_reader';

/** Cap / limit enforcers allowed to use the enforcement aggregate (checked at runtime). */
export const METRICS_ENFORCERS = [
  'spend_guard',
  'org_budget_governor',
  'generation_cost_dedup',
] as const;
export type MetricsEnforcer = (typeof METRICS_ENFORCERS)[number];

/**
 * Interactive operator CLI producers (front-CLI session hooks such as
 * recordCliUsage): their unattributed rows are reported, never a cap input.
 */
export const INTERACTIVE_CLI_PRODUCERS: ReadonlySet<string> = new Set(['claude-code-cli']);

/**
 * The whitelisted projection of a ledger row an enforcement classifier sees.
 * Never task text, prompts, metadata or free-form fields — only what a cap
 * needs: time, cost, token counts, mission / usage / accounting ids, the
 * tier/tenant/organization scope and the dot actor.
 */
export interface EnforcementRowView {
  readonly timestamp?: string;
  /** Number when finite; null when present but not a finite number; undefined when absent. */
  readonly cost_usd?: number | null;
  readonly usage?: Readonly<{
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cache_write_1h_tokens: number;
  }>;
  readonly mission_id?: string;
  readonly usage_id?: string;
  readonly accounting_id?: string;
  readonly dot_id?: string;
  /** actor_id / agent / component when it names a dot (`dot:<id>`). */
  readonly dot_actor?: string;
  /** agent / component is an interactive operator CLI producer. */
  readonly interactive_cli: boolean;
  readonly scope?: Readonly<{
    tier?: string;
    tenant_slug?: string;
    organization_id?: string;
    scope_kind?: string;
  }>;
  /** metricsRowTenant(row), or undefined. */
  readonly tenant_slug?: string;
  /** scope.organization_id, else the legacy top-level organization_id. */
  readonly organization_id?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;
const tokenCount = (value: unknown): number => (Number(value) > 0 ? Number(value) : 0);

/** Project a raw ledger row onto the enforcement whitelist. */
export function projectEnforcementRow(row: unknown): EnforcementRowView {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const scope =
    r.scope && typeof r.scope === 'object' ? (r.scope as Record<string, unknown>) : null;
  const u = r.usage && typeof r.usage === 'object' ? (r.usage as Record<string, unknown>) : null;
  const cost = r.cost_usd;
  const dotActor = [r.actor_id, r.agent, r.component].find(
    (value): value is string => typeof value === 'string' && value.startsWith('dot:')
  );
  const tenant = metricsRowTenant(r);
  const organization = text(scope?.organization_id) ?? text(r.organization_id);
  return Object.freeze({
    ...(typeof r.timestamp === 'string' ? { timestamp: r.timestamp } : {}),
    ...(cost === undefined
      ? {}
      : { cost_usd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null }),
    ...(u
      ? {
          usage: Object.freeze({
            prompt_tokens: tokenCount(u.prompt_tokens ?? u.input_tokens),
            completion_tokens: tokenCount(u.completion_tokens ?? u.output_tokens),
            cache_read_tokens: tokenCount(u.cache_read_tokens ?? u.cache_read_input_tokens),
            cache_write_tokens: tokenCount(u.cache_write_tokens ?? u.cache_creation_input_tokens),
            cache_write_1h_tokens: tokenCount(u.cache_write_1h_tokens),
          }),
        }
      : {}),
    ...(text(r.mission_id) ? { mission_id: text(r.mission_id) } : {}),
    ...(text(r.usage_id) ? { usage_id: text(r.usage_id) } : {}),
    ...(text(r.accounting_id) ? { accounting_id: text(r.accounting_id) } : {}),
    ...(text(r.dot_id) ? { dot_id: text(r.dot_id) } : {}),
    ...(dotActor ? { dot_actor: dotActor } : {}),
    interactive_cli: [r.agent, r.component].some(
      (value) => typeof value === 'string' && INTERACTIVE_CLI_PRODUCERS.has(value)
    ),
    ...(scope
      ? {
          scope: Object.freeze({
            ...(text(scope.tier) ? { tier: text(scope.tier) } : {}),
            ...(text(scope.tenant_slug) ? { tenant_slug: text(scope.tenant_slug) } : {}),
            ...(text(scope.organization_id)
              ? { organization_id: text(scope.organization_id) }
              : {}),
            ...(text(scope.scope_kind) ? { scope_kind: text(scope.scope_kind) } : {}),
          }),
        }
      : {}),
    ...(tenant ? { tenant_slug: tenant } : {}),
    ...(organization ? { organization_id: organization } : {}),
  });
}

export interface MetricsEnforcementTotals<M extends string> {
  /** Sums of the caller's pre-declared measures. */
  measures: Record<M, number>;
  /** Rows the accumulator was given. */
  rows: number;
  /** Partitions still withheld (e.g. another tenant's, for a tenant-bound caller). */
  withheld_partitions: number;
}

/**
 * Totals for a cap or limit enforcer, over EVERY tier of the requested scope,
 * whatever the caller's persona. The read runs as METRICS_CAP_READER_ROLE,
 * bound to the caller's tenant (tier-guard still denies other tenants'
 * partitions), so a persona that may not read knowledge/<tier>/ still has its
 * own personal/confidential spend counted — without being granted row access.
 *
 * Only numbers leave this call: the measure names are declared before any row
 * is read, `add` accepts only those names and finite numbers, and the result
 * carries no row, id, scope or text. The `accumulate` classifier runs inside
 * the governed read and must not retain rows (enforcers keep only numeric,
 * caller-derived state).
 *
 * Logged at debug per call (diagnostic format), not audited: enforcers run on
 * every reasoning call, the output is numbers only, and the role's grant is
 * read-only on two roots (see runtime-storage-layout "Metrics ledgers").
 */
export function aggregateMetricsForEnforcement<M extends string>(input: {
  enforcer: MetricsEnforcer;
  ledger: 'execution_metrics' | 'resource_usage';
  read: MetricsLedgerReadScope;
  measures: readonly M[];
  accumulate: (row: EnforcementRowView, add: (measure: M, value: number) => void) => void;
  /** Execution metrics only: strict read with torn-line reporting (line number + day only). */
  strict?: boolean;
  onMalformed?: (lineNumber: number, day: string | undefined) => void;
  collector?: MetricsCollector;
}): MetricsEnforcementTotals<M> {
  if (!(METRICS_ENFORCERS as readonly string[]).includes(input.enforcer)) {
    throw new Error(
      `[METRICS_ENFORCEMENT_ENFORCER] '${String(input.enforcer)}' is not an allowlisted enforcer`
    );
  }
  const declared = new Set<string>(input.measures);
  const measures = Object.fromEntries(input.measures.map((m) => [m, 0])) as Record<M, number>;
  const add = (measure: M, value: number) => {
    if (!declared.has(measure)) {
      throw new Error(`[METRICS_ENFORCEMENT_MEASURE] undeclared measure '${String(measure)}'`);
    }
    if (Number.isFinite(value)) measures[measure] += value;
  };
  const collector = input.collector ?? metrics;
  let withheld = 0;
  const onWithheld = (partitions: number) => {
    withheld = partitions;
  };
  const tenant = resolvePolicyIdentityContext().tenantSlug;
  const rows = withExecutionContext(
    METRICS_CAP_READER_ROLE,
    (): Array<Record<string, unknown>> =>
      input.ledger === 'execution_metrics'
        ? collector.loadHistory({
            read: input.read,
            strict: input.strict,
            onWithheld,
            ...(input.onMalformed
              ? {
                  onMalformed: (line: number, raw: string) =>
                    input.onMalformed?.(line, MALFORMED_DAY.exec(raw)?.[1]),
                }
              : {}),
          })
        : (collector.loadResourceUsageHistory(input.read, { onWithheld }) as unknown as Array<
            Record<string, unknown>
          >),
    undefined,
    tenant
  );
  // The classifier sees the whitelisted projection only, never the raw row.
  for (const row of rows) input.accumulate(projectEnforcementRow(row), add);
  logger.debug(
    `metrics enforcement aggregate — ${input.enforcer} read ${input.ledger} as ${METRICS_CAP_READER_ROLE} | next: none | evidence: rows=${rows.length} withheld=${withheld} tenant=${tenant ?? '(unbound)'}`
  );
  return { measures, rows: rows.length, withheld_partitions: withheld };
}

const MALFORMED_DAY = /"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2})/;
