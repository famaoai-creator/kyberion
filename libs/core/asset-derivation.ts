/**
 * P3 (information asset scope model): asset-level derivation lineage.
 *
 * One derivation-reference format (`asset:{tenant}:{id}@v{n}` /
 * `path:{repo-relative-posix}`) records that a file was derived from source
 * assets; each record carries the strictest combined taint of its sources
 * (R-06), and deletion follows the recorded graph instead of hand-written
 * target lists (R-09). The ledger is keyed on the SOURCE custodian — the
 * custodian of an asset owns the list of what its assets spawned, so any
 * custodian's deletion reaches every derivative, wherever it landed.
 *
 * Trust model: the ledger files are the trust root for deletion, so every
 * entry is treated as adversarial. Custody is inferred from ANCHORED
 * partition layouts (never path substrings — a `confidential/{slug}` segment
 * inside scratch does not make a tenant); recorded paths may only name
 * derivable data locations (custodian trees, tier knowledge trees,
 * mission/project trees, storage floors — never code, config, `.git`,
 * runtime state, or the ledgers themselves); and deletion only ever removes
 * regular files that satisfy the same ceiling the write path enforced.
 */
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeRmSync,
} from './secure-io.js';
import { logger } from './core.js';
import { appendJsonLine } from './foundation/json.js';
import { withExecutionContext } from './authority.js';
import { streamJsonLines } from './jsonl-read.js';
import { withLockSync } from './foundation/lock-utils.js';
import { nowIso } from './foundation/time.js';
import { KNOWLEDGE_TIER_RANK } from './foundation/knowledge-tier.js';
import type { KnowledgeTier } from './foundation/knowledge-tier.js';
import { detectTier } from './tier-guard.js';
import { isValidTenantSlug } from './entity-scope.js';
import { isValidMemberId } from './foundation/scope.js';
import { COMMON_TENANT_SLUG } from './ingest-asset-ledger.js';
import { tenantOfPath } from './path-tenant-attribution.js';
import {
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  PARTITIONED_RUNTIME_STATE_ROOTS,
  STORAGE_FLOOR_ROOTS,
} from './foundation/runtime-state-roots.js';
import { partitionedRuntimeTierInPath } from './storage-layout.js';
import type { MemoryProvenanceRecord } from './knowledge/memory-provenance.js';

/**
 * Store role that owns every partition of the derivation lineage ledgers
 * (`confidential/<tenant>`, member-keyed `personal/<ref>`, `system/` —
 * TENANT_STORE_LEDGER_ROOTS.asset_derivations). Ledger writes run as it so an
 * ambient runtime grant cannot append forged lineage; a tenant-custody write
 * binds the custodian's tenant so `${KYBERION_TENANT}` grants resolve to that
 * one partition, and person/system partitions admit the role's literal
 * `personal/` / `system/` grants. The inter-process lock stays under the
 * caller's role.
 */
const ASSET_DERIVATION_STORE_ROLE = 'asset_derivation_store';

function asAssetDerivationStore<T>(custody: DerivationCustody, fn: () => T): T {
  return withExecutionContext(
    ASSET_DERIVATION_STORE_ROLE,
    fn,
    undefined,
    // Member refs are not tenant slugs — for person and system custody the
    // ambient tenant binding must be explicitly cleared ('' marks
    // tenantCleared) or checkTenantScope would parse personal/<member> as a
    // foreign-tenant path and deny the store role's literal grant.
    custody.kind === 'tenant' ? custody.ref : ''
  );
}

// ---------------------------------------------------------------------------
// Derivation references
// ---------------------------------------------------------------------------

export type DerivationCustody =
  { kind: 'system' } | { kind: 'tenant'; ref: string } | { kind: 'person'; ref?: string };

const ASSET_REF_PATTERN = /^asset:([a-z][a-z0-9-]{1,30}):([A-Za-z0-9._-]+)@v(\d+)$/;
const PATH_REF_PATTERN = /^path:([A-Za-z0-9][A-Za-z0-9._\/-]*)$/;
const REPO_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

export type DerivationRef =
  | { kind: 'asset'; tenant: string; assetId: string; version: number }
  | { kind: 'path'; path: string };

export function formatDerivationRef(ref: DerivationRef): string {
  return ref.kind === 'asset'
    ? `asset:${ref.tenant}:${ref.assetId}@v${ref.version}`
    : `path:${normalizeRepoPath(ref.path)}`;
}

export function parseDerivationRef(value: string): DerivationRef {
  const asset = ASSET_REF_PATTERN.exec(value);
  if (asset)
    return { kind: 'asset', tenant: asset[1], assetId: asset[2], version: Number(asset[3]) };
  const pathRef = PATH_REF_PATTERN.exec(value);
  if (pathRef) return { kind: 'path', path: pathRef[1] };
  throw new Error(`[DERIVATION_REF_INVALID] malformed derivation ref '${value}'`);
}

/**
 * Bridge: a memory-provenance record connects through the file it describes.
 * Content-hash and external origins have no repository file and are not
 * silently claimed — only a repo-relative `document_path` yields a ref.
 */
export function memoryProvenanceRefs(record: MemoryProvenanceRecord): DerivationRef[] {
  const docPath = record.document_path;
  return REPO_PATH_PATTERN.test(docPath) ? [{ kind: 'path', path: docPath }] : [];
}

// ---------------------------------------------------------------------------
// Asset-level taint (R-06)
// ---------------------------------------------------------------------------

export interface AssetTaint {
  highestTier: KnowledgeTier;
  tenants: string[];
  prohibitExternal: boolean;
}

export function combineAssetTaint(taints: readonly AssetTaint[]): AssetTaint {
  const combined: AssetTaint = { highestTier: 'public', tenants: [], prohibitExternal: false };
  const seen = new Set<string>();
  for (const taint of taints) {
    if (KNOWLEDGE_TIER_RANK[taint.highestTier] > KNOWLEDGE_TIER_RANK[combined.highestTier])
      combined.highestTier = taint.highestTier;
    for (const tenant of taint.tenants) if (!seen.has(tenant)) seen.add(tenant);
    if (taint.prohibitExternal) combined.prohibitExternal = true;
  }
  combined.tenants = [...seen].sort();
  return combined;
}

/** Asset-typed analogue of assertProvenanceShareAllowed — deny-driven, same rules. */
export function assertAssetShareAllowed(check: {
  taint: AssetTaint;
  audienceFloor: KnowledgeTier;
  targetTenant?: string;
  external: boolean;
}): void {
  if (check.external && check.taint.prohibitExternal)
    throw new Error('[POLICY_VIOLATION] external sharing is prohibited for non-public provenance');
  if (
    check.taint.tenants.length > 0 &&
    (!check.targetTenant || !check.taint.tenants.includes(check.targetTenant))
  )
    throw new Error('[POLICY_VIOLATION] target tenant is outside asset provenance scope');
  if (KNOWLEDGE_TIER_RANK[check.audienceFloor] < KNOWLEDGE_TIER_RANK[check.taint.highestTier])
    throw new Error(
      `[POLICY_VIOLATION] audience floor ${check.audienceFloor} is broader than asset taint ${check.taint.highestTier}`
    );
}

// ---------------------------------------------------------------------------
// Paths, custody, ledger partitions
// ---------------------------------------------------------------------------

const DERIVATION_LEDGER_ROOT = PARTITIONED_RUNTIME_LEDGER_ROOTS.asset_derivations;
const DERIVATIONS_FILENAME = 'derivations.jsonl';
const DELETIONS_FILENAME = 'derivation-deletions.jsonl';

export interface DerivationPathOptions {
  rootDir?: string;
}

function rootOf(options: DerivationPathOptions): string {
  return options.rootDir ?? pathResolver.rootDir();
}

const FLOOR_ROOTS = Object.values(STORAGE_FLOOR_ROOTS);
const RUNTIME_ROOTS = [
  ...Object.values(PARTITIONED_RUNTIME_LEDGER_ROOTS),
  ...Object.values(PARTITIONED_RUNTIME_STATE_ROOTS),
];

/** Tenant-scoped trees: `{tree}/{tier}/{slug-or-shared}/…` (protected prefixes). */
const TENANT_TREE_PREFIXES = [
  'active/missions/',
  'active/archive/missions/',
  'active/projects/',
  'active/organizations/',
];
/** `knowledge/confidential/` segments that are shared prefixes, never tenants. */
const KNOWLEDGE_CONFIDENTIAL_SHARED = new Set(['tenant-groups', 'heuristics', 'relationships']);

/**
 * Tenant owning a repo-relative path, inferred from ANCHORED partition
 * layouts only — a `confidential/{slug}` segment floating inside scratch or
 * any other location does NOT confer tenant custody. Prefers the canonical
 * `tenantOfPath` attribution (symlink-resolved, mission-state aware) and
 * falls back to anchored prefix matching for paths that no longer exist or
 * live under floors / runtime partitions the attribution does not classify.
 */
export function tenantFromRepoPath(
  relativePath: string,
  rootDir: string = pathResolver.rootDir()
): string | undefined {
  try {
    const attributed = tenantOfPath(path.join(rootDir, relativePath));
    // The policy's shared prefixes are shared for EVERY lookup path — never
    // tenants, whatever the attribution layer knows about them.
    if (attributed && !KNOWLEDGE_CONFIDENTIAL_SHARED.has(attributed)) return attributed;
    if (attributed) return undefined;
  } catch {
    // Missing file or unresolvable — anchored matching below still applies.
  }
  const lower = relativePath.toLowerCase();
  const segmentAfter = (prefix: string): string | undefined => {
    if (!lower.startsWith(prefix)) return undefined;
    const rest = relativePath.slice(prefix.length);
    const seg = rest.split('/')[0] ?? '';
    if (!seg || !rest.includes('/')) return undefined;
    return seg;
  };
  const scopeSegment = (seg: string | undefined): string | undefined =>
    seg && (isValidTenantSlug(seg) || seg === COMMON_TENANT_SLUG) ? seg : undefined;
  const knowledge = segmentAfter('knowledge/confidential/');
  if (knowledge !== undefined) {
    if (KNOWLEDGE_CONFIDENTIAL_SHARED.has(knowledge)) return undefined;
    return scopeSegment(knowledge);
  }
  for (const tree of TENANT_TREE_PREFIXES) {
    for (const tier of ['confidential/', 'personal/', 'public/']) {
      const seg = segmentAfter(`${tree}${tier}`);
      if (seg !== undefined) return scopeSegment(seg);
    }
  }
  for (const root of FLOOR_ROOTS) {
    for (const tier of ['confidential/', 'personal/', 'public/']) {
      const seg = segmentAfter(`${root}/${tier}`);
      if (seg !== undefined) return scopeSegment(seg);
    }
  }
  // Runtime partitions name tenants under every storage tier — EXCEPT the
  // derivation ledger itself, whose `personal/` segment is a member ref and
  // whose only tenant partition is `confidential/`.
  for (const root of RUNTIME_ROOTS) {
    for (const tier of ['confidential/', 'personal/', 'public/']) {
      if (root === DERIVATION_LEDGER_ROOT && tier !== 'confidential/') continue;
      const seg = segmentAfter(`${root}/${tier}`);
      if (seg !== undefined) return scopeSegment(seg);
    }
  }
  return undefined;
}

/**
 * Member segment under an anchored `personal/` partition, if any. Only the
 * derivation ledger root carries member-keyed `personal/` partitions among
 * runtime roots — every other runtime `personal/` segment is a tenant tier
 * (handled by tenantFromRepoPath, not here).
 */
function personRefFromRepoPath(relativePath: string): string | undefined {
  const lower = relativePath.toLowerCase();
  const after = (prefix: string): string | undefined => {
    if (!lower.startsWith(prefix)) return undefined;
    const rest = relativePath.slice(prefix.length);
    const seg = rest.split('/')[0] ?? '';
    return seg && rest.includes('/') ? seg : undefined;
  };
  const candidates = [
    'knowledge/personal/',
    'active/personal/',
    'vault/',
    ...FLOOR_ROOTS.map((root) => `${root}/personal/`),
    `${DERIVATION_LEDGER_ROOT}/personal/`,
  ];
  for (const prefix of candidates) {
    const seg = after(prefix);
    if (seg !== undefined) return isValidMemberId(seg) ? seg : undefined;
  }
  return undefined;
}

/** Custodian of a repository-local path, inferred from its anchored partition. */
export function custodyFromRepoPath(
  relativePath: string,
  rootDir: string = pathResolver.rootDir()
): DerivationCustody {
  const tenant = tenantFromRepoPath(relativePath, rootDir);
  if (tenant) return { kind: 'tenant', ref: tenant };
  const person = personRefFromRepoPath(relativePath);
  if (person) return { kind: 'person', ref: person };
  return { kind: 'system' };
}

function personPartitionRef(ref: string | undefined): string {
  return ref ?? 'installation';
}

/**
 * May `derivedPath` land where it claims, given the custodians of its
 * sources? A derivative inherits its sources' custody (R-06): it may sit in
 * a source custodian's own partition or in a non-custodied (system)
 * location — never inside another tenant's tree and never inside a person
 * partition no source belongs to. Replayed at write, delete and collect
 * time so a forged record cannot widen the landing set.
 */
export function derivedLandingAllowed(
  derivedPath: string,
  sourceCustodies: readonly DerivationCustody[]
): boolean {
  const custody = custodyFromRepoPath(derivedPath);
  if (custody.kind === 'system') return true;
  return sourceCustodies.some((source) => {
    if (custody.kind === 'tenant') return source.kind === 'tenant' && source.ref === custody.ref;
    return (
      source.kind === 'person' && personPartitionRef(source.ref) === personPartitionRef(custody.ref)
    );
  });
}

/** Custodies a ledger record claims for its sources (malformed refs excluded). */
export function custodiesOfRecordSources(record: AssetDerivationRecord): DerivationCustody[] {
  const custodies: DerivationCustody[] = [];
  for (const source of record.sources) {
    try {
      const ref = parseDerivationRef(source);
      custodies.push(
        ref.kind === 'asset' ? { kind: 'tenant', ref: ref.tenant } : custodyFromRepoPath(ref.path)
      );
    } catch {
      // A malformed source ref contributes no custody.
    }
  }
  return custodies;
}

/** Custody equality — person refs compare at partition granularity. */
export function custodyEquals(a: DerivationCustody, b: DerivationCustody): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tenant') return a.ref === (b as { ref: string }).ref;
  if (a.kind === 'person')
    return personPartitionRef(a.ref) === personPartitionRef((b as { ref?: string }).ref);
  return true;
}

/** A source whose custody and taint were verified against real ledgers/layouts. */
export interface VerifiedSource {
  custody: DerivationCustody;
  taint: AssetTaint;
}

/**
 * Custody/taint a ledger record's sources ACTUALLY carry at replay time —
 * never what the line merely claims. `path:` refs confer custody from their
 * anchored layout (existence not required); `asset:` refs confer the
 * tenant's custody only when the claimed asset really exists in that
 * tenant's ingest ledger, so a forged line cannot invent foreign custody.
 */
export function verifiedRecordSources(
  record: AssetDerivationRecord,
  options: DerivationPathOptions = {}
): VerifiedSource[] {
  const root = rootOf(options);
  const sources: VerifiedSource[] = [];
  for (const source of record.sources) {
    let ref: DerivationRef;
    try {
      ref = parseDerivationRef(source);
    } catch {
      continue; // malformed ref confers nothing
    }
    if (ref.kind === 'path') {
      const rel = normalizeRepoPath(ref.path);
      const tier = tierFromRepoPath(rel, path.join(root, rel));
      const tenant = tenantFromRepoPath(rel, root);
      sources.push({
        custody: custodyFromRepoPath(rel, root),
        taint: {
          highestTier: tier,
          tenants: tenant ? [tenant] : [],
          prohibitExternal: tier !== 'public',
        },
      });
      continue;
    }
    // `asset:` claims verify against the claimed tenant's ingest ledger —
    // plus the same derivable/tenant-consistent ceiling resolveSource uses.
    // Shared `knowledge/confidential/` prefixes are never tenants — a
    // claimed `asset:heuristics:…` confers nothing, matching path custody.
    if (
      (!isValidTenantSlug(ref.tenant) && ref.tenant !== COMMON_TENANT_SLUG) ||
      KNOWLEDGE_CONFIDENTIAL_SHARED.has(ref.tenant)
    )
      continue;
    const line = [...tenantAssetLines(ref.tenant, options)].find(
      (entry) =>
        entry.asset_id === ref.assetId &&
        entry.version === ref.version &&
        typeof entry.target_path === 'string'
    );
    if (!line || typeof line.target_path !== 'string') continue;
    const rel = normalizeRepoPath(line.target_path);
    if (!isDerivableRepoPath(rel)) continue;
    const targetTenant = tenantFromRepoPath(rel, root);
    if (targetTenant !== undefined && targetTenant !== ref.tenant) continue;
    const tier = tierFromRepoPath(rel, path.join(root, rel));
    sources.push({
      custody: { kind: 'tenant', ref: ref.tenant },
      taint: {
        highestTier: tier,
        tenants: [ref.tenant],
        prohibitExternal: tier !== 'public',
      },
    });
  }
  return sources;
}

/**
 * Partition-bounded honoring — the replay contract a forged ledger line
 * cannot widen: a record may only authorize the landing it names when
 * (a) the record sits in a partition whose custodian is among the record's
 * VERIFIED source custodies (that is exactly where recordDerivation would
 * have written it), and (b) the landing custodian is the partition's own
 * custodian or `system`, and (c) the landing tier clears the taint floor
 * recomputed from the verified sources (the record's claimed taint only
 * ever raises that floor), and (d) the write-time landing rule still holds
 * against the verified custodies. A line claiming foreign custody therefore
 * gains nothing beyond its own partition's reach.
 */
export function recordedLandingHonored(
  record: AssetDerivationRecord,
  partition: DerivationCustody,
  derivedPath: string,
  options: DerivationPathOptions = {}
): boolean {
  const rel = normalizeRepoPath(derivedPath);
  // A landing must be a derivable data location — keeps "seedable" and
  // "deletable" identical envelopes (a legit derived.path always is).
  if (!isDerivableRepoPath(rel)) return false;
  const verified = verifiedRecordSources(record, options);
  if (!verified.some((source) => custodyEquals(source.custody, partition))) return false;
  const landing = custodyFromRepoPath(rel, rootOf(options));
  if (landing.kind !== 'system' && !custodyEquals(landing, partition)) return false;
  if (
    !derivedLandingAllowed(
      rel,
      verified.map((source) => source.custody)
    )
  )
    return false;
  const floor = combineAssetTaint([record.taint, ...verified.map((source) => source.taint)]);
  if (
    KNOWLEDGE_TIER_RANK[tierFromRepoPath(rel, path.join(rootOf(options), rel))] <
    KNOWLEDGE_TIER_RANK[floor.highestTier]
  )
    return false;
  return true;
}

function custodyPartition(custody: DerivationCustody): string {
  if (custody.kind === 'tenant') {
    if (!isValidTenantSlug(custody.ref) && custody.ref !== COMMON_TENANT_SLUG)
      throw new Error(`[DERIVATION_CUSTODY_INVALID] bad tenant ref '${custody.ref}'`);
    return `${DERIVATION_LEDGER_ROOT}/confidential/${custody.ref}`;
  }
  if (custody.kind === 'person') {
    const ref = personPartitionRef(custody.ref);
    if (!isValidMemberId(ref))
      throw new Error(`[DERIVATION_CUSTODY_INVALID] bad person ref '${ref}'`);
    return `${DERIVATION_LEDGER_ROOT}/personal/${ref}`;
  }
  return `${DERIVATION_LEDGER_ROOT}/system`;
}

function ledgerPath(custody: DerivationCustody, options: DerivationPathOptions): string {
  return path.join(rootOf(options), custodyPartition(custody), DERIVATIONS_FILENAME);
}

function deletionsPath(custody: DerivationCustody, options: DerivationPathOptions): string {
  return path.join(rootOf(options), custodyPartition(custody), DELETIONS_FILENAME);
}

function normalizeRepoPath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/\\/g, '/')).replace(/\/+$/u, '');
}

function assertRepoRelative(relativePath: string, options: DerivationPathOptions): string {
  const normalized = normalizeRepoPath(relativePath);
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    normalized.split('/').includes('..') ||
    !REPO_PATH_PATTERN.test(normalized)
  )
    throw new Error(`[DERIVATION_INVALID] path '${relativePath}' is not repository-local`);
  return assertSafeRepositoryPath(path.join(rootOf(options), normalized), {
    allowMissingLeaf: true,
  });
}

/**
 * Derivable data locations: the only places a derived artifact may land and
 * the only places deletion may reach. Anchored layouts require a real file
 * below the custodian/tier segment — never code/config roots, `.git`,
 * runtime state, the lineage ledgers, or bare partition roots.
 */
export function isDerivableRepoPath(relativePath: string): boolean {
  const lower = normalizeRepoPath(relativePath).toLowerCase();
  if (/^\.git(?:\/|$)/u.test(lower)) return false;
  if (/\/_ledger(?:\/|$)/u.test(lower)) return false;
  if (lower === DERIVATION_LEDGER_ROOT || lower.startsWith(`${DERIVATION_LEDGER_ROOT}/`))
    return false;
  if (/^knowledge\/confidential\/[^/]+\/[^/]+/u.test(lower)) return true;
  if (/^knowledge\/(?:personal|public)\/[^/]+/u.test(lower)) return true;
  if (
    /^active\/(?:missions|archive\/missions|projects|organizations)\/(?:personal|confidential|public)\/[^/]+\/[^/]+/u.test(
      lower
    )
  )
    return true;
  if (/^active\/personal\/[^/]+/u.test(lower)) return true;
  for (const floor of FLOOR_ROOTS) {
    if (lower.startsWith(`${floor}/`)) return true;
  }
  return false;
}

function assertDerivablePath(relativePath: string): void {
  if (!isDerivableRepoPath(relativePath))
    throw new Error(`[DERIVATION_INVALID] '${relativePath}' is not a derivable data location`);
}

// ---------------------------------------------------------------------------
// Derivation records
// ---------------------------------------------------------------------------

export type DerivationKind = 'summary' | 'distillation' | 'cache' | 'delegation_result' | 'other';

export interface AssetDerivationRecord {
  derived: { ref: string; path: string; kind: DerivationKind };
  /** Every source ref of the derivation (all custodians, not just this ledger's). */
  sources: string[];
  taint: AssetTaint;
  recorded_at: string;
  recorded_by?: string;
}

const DERIVATION_KINDS = new Set<DerivationKind>([
  'summary',
  'distillation',
  'cache',
  'delegation_result',
  'other',
]);

/** Shape-validate one ledger line; a line failing it is forged or corrupt. */
function asDerivationRecord(value: unknown): AssetDerivationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const derived = record.derived;
  if (!derived || typeof derived !== 'object') return null;
  const d = derived as Record<string, unknown>;
  if (typeof d.path !== 'string' || typeof d.ref !== 'string') return null;
  // recordDerivation always writes `ref = 'path:' + path` — a stored ref in
  // any other spelling (e.g. an `asset:` ref pointing into a foreign graph)
  // is definitionally forged and never trusted for closure seeding.
  if (d.ref !== `path:${d.path}`) return null;
  if (typeof d.kind !== 'string' || !DERIVATION_KINDS.has(d.kind as DerivationKind)) return null;
  if (!Array.isArray(record.sources) || !record.sources.every((s) => typeof s === 'string'))
    return null;
  const taint = record.taint;
  if (!taint || typeof taint !== 'object') return null;
  const t = taint as Record<string, unknown>;
  if (typeof t.highestTier !== 'string' || !(t.highestTier in KNOWLEDGE_TIER_RANK)) return null;
  if (!Array.isArray(t.tenants) || !t.tenants.every((x) => typeof x === 'string')) return null;
  if (typeof t.prohibitExternal !== 'boolean') return null;
  return record as unknown as AssetDerivationRecord;
}

/**
 * Read one custodian ledger tolerantly — malformed JSON and wrong-shape
 * lines are skipped with a warning so one poisoned line can neither wedge
 * an offboarding nor smuggle a deletion target.
 */
function readLedger(
  custody: DerivationCustody,
  options: DerivationPathOptions
): AssetDerivationRecord[] {
  const file = ledgerPath(custody, options);
  if (!safeExistsSync(file)) return [];
  const records: AssetDerivationRecord[] = [];
  for (const line of streamJsonLines<unknown>(file, { onMalformed: 'skip' })) {
    const record = asDerivationRecord(line);
    if (record) records.push(record);
    else
      logger.warn(
        `[asset-derivation] skipped malformed derivation line in ${custodyPartition(custody)}/${DERIVATIONS_FILENAME} — ledger content failed shape validation`
      );
  }
  return records;
}

interface ResolvedSource {
  ref: DerivationRef;
  custody: DerivationCustody;
  taint: AssetTaint;
}

function tenantAssetLedgerPath(tenant: string, options: DerivationPathOptions): string {
  return path.join(rootOf(options), 'knowledge/confidential', tenant, '_ledger', 'assets.jsonl');
}

interface AssetLedgerLine {
  asset_id?: unknown;
  version?: unknown;
  target_path?: unknown;
}

function* tenantAssetLines(
  tenant: string,
  options: DerivationPathOptions
): Generator<AssetLedgerLine> {
  const ledger = tenantAssetLedgerPath(tenant, options);
  if (!safeExistsSync(ledger)) return;
  yield* streamJsonLines<AssetLedgerLine>(ledger, { onMalformed: 'skip' });
}

/**
 * Tier implied by where the path ANCHORS (knowledge trees, tenant trees,
 * floors, tier-partitioned runtime roots — case-folded), not by substring.
 */
function tierFromRepoPath(relativePath: string, absolutePath: string): KnowledgeTier {
  const lower = normalizeRepoPath(relativePath).toLowerCase();
  let match = /^knowledge\/(personal|confidential|public)(?:\/|$)/u.exec(lower);
  if (!match)
    match =
      /^active\/(?:missions|archive\/missions|projects|organizations)\/(personal|confidential|public)(?:\/|$)/u.exec(
        lower
      );
  if (match) return match[1] as KnowledgeTier;
  if (/^(?:active\/personal|vault)(?:\/|$)/u.test(lower)) return 'personal';
  for (const floor of FLOOR_ROOTS) {
    const floorMatch = new RegExp(`^${floor}/(personal|confidential|public)(?:/|$)`, 'u').exec(
      lower
    );
    if (floorMatch) return floorMatch[1] as KnowledgeTier;
  }
  const runtimeTier = partitionedRuntimeTierInPath(absolutePath);
  if (runtimeTier) return runtimeTier as KnowledgeTier;
  return detectTier(absolutePath);
}

function sourceTaintFromPath(relativePath: string, options: DerivationPathOptions): AssetTaint {
  const absolute = assertRepoRelative(relativePath, options);
  const tier = tierFromRepoPath(relativePath, absolute);
  const tenant = tenantFromRepoPath(relativePath);
  return {
    highestTier: tier,
    tenants: tenant ? [tenant] : [],
    prohibitExternal: tier !== 'public',
  };
}

/** Resolve a source ref against its own system's record — never caller-declared. */
function resolveSource(ref: DerivationRef, options: DerivationPathOptions): ResolvedSource {
  if (ref.kind === 'path') {
    const absolute = assertRepoRelative(ref.path, options);
    assertDerivablePath(ref.path);
    if (!safeExistsSync(absolute))
      throw new Error(
        `[DERIVATION_INVALID] source path '${ref.path}' does not exist — a derivation cannot claim a phantom source`
      );
    return {
      ref,
      custody: custodyFromRepoPath(ref.path),
      taint: sourceTaintFromPath(ref.path, options),
    };
  }
  if (!isValidTenantSlug(ref.tenant) && ref.tenant !== COMMON_TENANT_SLUG)
    throw new Error(`[DERIVATION_INVALID] bad asset tenant '${ref.tenant}'`);
  const ledger = tenantAssetLedgerPath(ref.tenant, options);
  if (!safeExistsSync(ledger))
    throw new Error(
      `[DERIVATION_INVALID] no ingest ledger for tenant '${ref.tenant}' — source cannot be verified`
    );
  const record = [...tenantAssetLines(ref.tenant, options)].find(
    (line) => line.asset_id === ref.assetId && line.version === ref.version
  );
  if (!record || typeof record.target_path !== 'string')
    throw new Error(
      `[DERIVATION_INVALID] asset ${ref.assetId}@v${ref.version} not in tenant '${ref.tenant}' ledger`
    );
  assertRepoRelative(record.target_path, options);
  assertDerivablePath(record.target_path);
  // The ingest ledger lives in the LANDING tenant's tree — a recorded
  // target_path in another tenant's tree is malformed/forged; fail closed.
  const targetTenant = tenantFromRepoPath(record.target_path);
  if (targetTenant !== undefined && targetTenant !== ref.tenant)
    throw new Error(
      `[DERIVATION_INVALID] asset ${ref.assetId}@v${ref.version} targets a different tenant's tree — ledger line is anomalous`
    );
  return {
    ref,
    custody: { kind: 'tenant', ref: ref.tenant },
    taint: sourceTaintFromPath(record.target_path, options),
  };
}

/**
 * Record that `derived.path` was produced from `sources` (R-06 enforced: the
 * derived file may never sit in a partition less restrictive than the
 * strictest source taint). One ledger line is appended per source custodian;
 * every line carries the FULL source list so any surviving partition can
 * complete the closure (NB: per-custodian filtering would sever propagation
 * when one ledger is lost mid-write).
 */
export function recordDerivation(input: {
  derived: { path: string; kind: DerivationKind };
  sources: readonly DerivationRef[];
  recorded_by?: string;
  options?: DerivationPathOptions;
}): AssetDerivationRecord[] {
  const options = input.options ?? {};
  if (input.sources.length === 0)
    throw new Error('[DERIVATION_INVALID] a derivation needs at least one source');
  const derivedAbs = assertRepoRelative(input.derived.path, options);
  assertDerivablePath(input.derived.path);
  const resolved = input.sources.map((ref) => resolveSource(ref, options));
  const taint = combineAssetTaint(resolved.map((source) => source.taint));
  if (
    KNOWLEDGE_TIER_RANK[tierFromRepoPath(input.derived.path, derivedAbs)] <
    KNOWLEDGE_TIER_RANK[taint.highestTier]
  )
    throw new Error(
      `[DERIVATION_TIER_VIOLATION] '${input.derived.path}' sits below its strictest source taint ${taint.highestTier}`
    );
  // A derivative inherits source custody: it may land in a source
  // custodian's own partition or a non-custodied (system) location — never
  // inside a DIFFERENT tenant's tree and never inside a person partition no
  // source belongs to (R-06/R-08; brokered access is the separate mechanism
  // for cross-custodian sharing).
  if (
    !derivedLandingAllowed(
      input.derived.path,
      resolved.map((s) => s.custody)
    )
  )
    throw new Error(
      `[DERIVATION_CUSTODY_INVALID] '${input.derived.path}' lands outside the source custodian set`
    );
  if (!safeExistsSync(derivedAbs))
    throw new Error(
      `[DERIVATION_INVALID] derived path '${input.derived.path}' does not exist — record after the artifact lands`
    );
  const custodians = new Map<string, DerivationCustody>();
  for (const source of resolved) custodians.set(custodyPartition(source.custody), source.custody);
  const allSources = resolved.map((source) => formatDerivationRef(source.ref)).sort();
  const recordedAt = nowIso();
  const records: AssetDerivationRecord[] = [];
  for (const custody of custodians.values()) {
    const record: AssetDerivationRecord = {
      derived: {
        ref: formatDerivationRef({ kind: 'path', path: input.derived.path }),
        path: normalizeRepoPath(input.derived.path),
        kind: input.derived.kind,
      },
      sources: allSources,
      taint,
      recorded_at: recordedAt,
      ...(input.recorded_by ? { recorded_by: input.recorded_by } : {}),
    };
    const file = ledgerPath(custody, options);
    withLockSync(`asset-derivation:${custodyPartition(custody)}`, () => {
      asAssetDerivationStore(custody, () => {
        safeMkdir(path.dirname(file), { recursive: true });
        appendJsonLine(file, record);
      });
    });
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Closure and deletion propagation (R-09)
// ---------------------------------------------------------------------------

/** A record together with the custodian partition it was read from. */
interface LedgerEntry {
  record: AssetDerivationRecord;
  /** Custodian the ledger partition belongs to — the honoring bound. */
  partition: DerivationCustody;
}

/**
 * Every ledger record with the custodian partition it lives in. Partition
 * enumeration is ANCHORED to the ledger layout — `system/`,
 * `confidential/{slug|common}`, `personal/{member}` — so a stray or forged
 * directory name never contributes a record, and an unreadable partition is
 * skipped with a warning instead of wedging the whole closure (fail-closed
 * under-delete, never delete-overreach).
 */
function recordsAllCustodians(options: DerivationPathOptions): LedgerEntry[] {
  const root = path.join(rootOf(options), DERIVATION_LEDGER_ROOT);
  if (!safeExistsSync(root)) return [];
  const partitions: DerivationCustody[] = [{ kind: 'system' }];
  const collect = (tier: 'confidential' | 'personal'): void => {
    const dir = path.join(root, tier);
    if (!safeExistsSync(dir)) return;
    let segments: string[];
    try {
      segments = safeReaddir(dir);
    } catch (error) {
      logger.warn(
        `[asset-derivation] skipped ledger tier dir '${tier}/' — unreadable (${(error as Error).message}); its records are not honored`
      );
      return;
    }
    for (const seg of segments) {
      const custody: DerivationCustody | null =
        tier === 'confidential'
          ? isValidTenantSlug(seg) || seg === COMMON_TENANT_SLUG
            ? { kind: 'tenant', ref: seg }
            : null
          : isValidMemberId(seg)
            ? { kind: 'person', ref: seg }
            : null;
      if (custody) {
        partitions.push(custody);
      } else {
        logger.warn(
          `[asset-derivation] skipped ledger partition '${tier}/${seg}' — segment is not a valid ${tier === 'confidential' ? 'tenant' : 'member'} ref`
        );
      }
    }
  };
  collect('confidential');
  collect('personal');
  const entries: LedgerEntry[] = [];
  for (const partition of partitions) {
    const file = ledgerPath(partition, options);
    if (!safeExistsSync(file)) continue;
    try {
      const stat = safeLstat(file);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    for (const record of readLedger(partition, options)) entries.push({ record, partition });
  }
  return entries;
}

/** Alternate ref spellings that name the same physical source (closure seed). */
function alternateSourceRefs(ref: DerivationRef, options: DerivationPathOptions): string[] {
  const alternates: string[] = [];
  if (ref.kind === 'asset') {
    try {
      alternates.push(`path:${normalizeRepoPath(sourcePathOfAsset(ref, options))}`);
    } catch {
      // unresolved asset — the asset: seed alone still applies
    }
    return alternates;
  }
  const tenant = tenantFromRepoPath(ref.path, rootOf(options));
  if (!tenant) return alternates;
  const normalizedSource = normalizeRepoPath(ref.path);
  for (const line of tenantAssetLines(tenant, options)) {
    if (
      typeof line.target_path === 'string' &&
      normalizeRepoPath(line.target_path) === normalizedSource &&
      typeof line.asset_id === 'string'
    )
      alternates.push(`asset:${tenant}:${line.asset_id}@v${Number(line.version)}`);
  }
  return alternates;
}

interface ClosureEntry {
  path: string;
  /** Every ledger record claiming this path — delete-time checks replay each claim. */
  claims: LedgerEntry[];
}

function derivationClosureEntries(
  ref: DerivationRef,
  options: DerivationPathOptions
): ClosureEntry[] {
  const entries = recordsAllCustodians(options);
  const deadRefs = new Set<string>([formatDerivationRef(ref)]);
  for (const alternate of alternateSourceRefs(ref, options)) deadRefs.add(alternate);
  const claims = new Map<string, LedgerEntry[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!entry.record.sources.some((source) => deadRefs.has(source))) continue;
      const derivedPath = normalizeRepoPath(entry.record.derived.path);
      // A record that FIRES still only propagates death within its own
      // partition's reach: deadRefs are seeded only when the record's
      // landing is honored — otherwise a forged line could mark a foreign
      // source dead and let the victim's own honored records do the
      // deleting. The claim is still recorded so the refusal is audited.
      const honored = recordedLandingHonored(entry.record, entry.partition, derivedPath, options);
      const derivedRef = `path:${derivedPath}`;
      if (honored && !deadRefs.has(derivedRef)) {
        deadRefs.add(derivedRef);
        // A freshly dead derived file may itself be a ledger-recorded asset —
        // seed its alternate spellings so deeper hops still propagate.
        for (const alternate of alternateSourceRefs({ kind: 'path', path: derivedPath }, options))
          deadRefs.add(alternate);
        changed = true;
      }
      if (!claims.has(derivedPath)) {
        claims.set(derivedPath, [entry]);
        changed = true;
      } else if (!claims.get(derivedPath)!.includes(entry)) {
        claims.get(derivedPath)!.push(entry);
      }
    }
  }
  return [...claims.entries()]
    .map(([entryPath, entryClaims]) => ({ path: entryPath, claims: entryClaims }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Transitive set of repo-relative derived paths CLAIMED reachable from
 * `ref` across every custodian ledger (a derivative dies when ANY source
 * dies — R-09). The seed includes every ref spelling that names the source.
 * Returns the claimed superset — including paths whose claiming records
 * fail partition-bounded honoring — so callers deleting on it must re-honor
 * each path (as `deleteAssetWithDerivations` does) rather than trusting
 * reachability alone.
 */
export function derivationClosure(
  ref: DerivationRef,
  options: DerivationPathOptions = {}
): string[] {
  return derivationClosureEntries(ref, options).map((entry) => entry.path);
}

/** Validated derivation records under one custodian's ledger. */
export function listDerivedRecordsForCustodian(
  custody: DerivationCustody,
  options: DerivationPathOptions = {}
): AssetDerivationRecord[] {
  return readLedger(custody, options);
}

/** Derived paths recorded under one custodian's ledger (janitor query surface). */
export function listDerivedPathsForCustodian(
  custody: DerivationCustody,
  options: DerivationPathOptions = {}
): string[] {
  return [
    ...new Set(
      readLedger(custody, options).map((record) => normalizeRepoPath(record.derived.path))
    ),
  ].sort();
}

export interface AssetDeletionResult {
  source: string;
  deleted: string[];
  skipped: string[];
}

/**
 * Delete a source asset and every transitively derived artifact (leaves
 * first). Deletion is bounded twice: the ledger may only claim derivable
 * data locations, and every candidate is re-checked against the same
 * ceiling — repository-relative, derivable, tenant-consistent, an existing
 * regular file — BEFORE anything is removed, so a poisoned line can never
 * reach code, config, runtime state, or another tenant.
 */
export function deleteAssetWithDerivations(input: {
  ref: DerivationRef;
  options?: DerivationPathOptions;
}): AssetDeletionResult {
  const options = input.options ?? {};
  const resolved = resolveSource(input.ref, options);
  const sourcePath =
    input.ref.kind === 'path' ? input.ref.path : sourcePathOfAsset(input.ref, options);
  const skipped: string[] = [];
  const candidates: { rel: string; abs: string }[] = [];
  const sourceRel = normalizeRepoPath(sourcePath);
  const consider = (entry: ClosureEntry): void => {
    const rel = normalizeRepoPath(entry.path);
    if (rel === sourceRel) return; // the source is appended below
    // Partition-bounded honoring: a claiming record only authorizes the
    // landing when its own partition's custodian is among the record's
    // VERIFIED source custodies and the landing sits in that custodian's
    // space (or system space) — a forged line claiming foreign sources can
    // never reach past its own partition's reach.
    if (
      !entry.claims.some((claim) =>
        recordedLandingHonored(claim.record, claim.partition, rel, options)
      )
    ) {
      skipped.push(rel);
      logger.warn(
        `[asset-derivation] refused derived path '${rel}' — recorded lineage fails partition-bounded replay`
      );
      return;
    }
    if (!isDerivableRepoPath(rel)) {
      skipped.push(rel);
      logger.warn(
        `[asset-derivation] refused derived path '${rel}' — recorded lineage reaches outside derivable data locations`
      );
      return;
    }
    let abs: string;
    try {
      abs = assertRepoRelative(rel, options);
    } catch {
      skipped.push(rel);
      logger.warn(`[asset-derivation] refused derived path '${rel}' — not a repository-local path`);
      return;
    }
    candidates.push({ rel, abs });
  };
  for (const entry of derivationClosureEntries(input.ref, options)) consider(entry);
  // The source itself is deletable by contract — resolveSource already
  // verified it is repository-local, derivable and tenant-consistent.
  try {
    candidates.push({ rel: sourceRel, abs: assertRepoRelative(sourceRel, options) });
  } catch {
    skipped.push(sourceRel);
    logger.warn(`[asset-derivation] refused source path '${sourceRel}' — not repository-local`);
  }
  // Deeper paths first so a derived tree's leaves are removed before its roots.
  const ordered = [...candidates].sort((a, b) => b.rel.split('/').length - a.rel.split('/').length);
  const deleted: string[] = [];
  for (const candidate of ordered) {
    if (!safeExistsSync(candidate.abs)) {
      skipped.push(candidate.rel); // vanished between validation and delete
      continue;
    }
    try {
      if (!safeLstat(candidate.abs).isFile()) {
        skipped.push(candidate.rel);
        logger.warn(
          `[asset-derivation] refused derived path '${candidate.rel}' — only regular files are deletable`
        );
        continue;
      }
    } catch {
      skipped.push(candidate.rel);
      continue;
    }
    try {
      safeRmSync(candidate.abs, { recursive: false, force: true });
      deleted.push(candidate.rel);
    } catch (error) {
      skipped.push(candidate.rel);
      logger.warn(
        `[asset-derivation] failed to delete '${candidate.rel}' — ${(error as Error).message}`
      );
    }
  }
  if (deleted.length > 0 || skipped.length > 0) {
    const file = deletionsPath(resolved.custody, options);
    withLockSync(`asset-derivation:${custodyPartition(resolved.custody)}:deletions`, () => {
      asAssetDerivationStore(resolved.custody, () => {
        safeMkdir(path.dirname(file), { recursive: true });
        appendJsonLine(file, {
          source_ref: formatDerivationRef(input.ref),
          source_path: normalizeRepoPath(sourcePath),
          deleted_paths: deleted,
          skipped_paths: skipped,
          deleted_at: nowIso(),
        });
      });
    });
  }
  return { source: normalizeRepoPath(sourcePath), deleted, skipped };
}

function sourcePathOfAsset(
  ref: Extract<DerivationRef, { kind: 'asset' }>,
  options: DerivationPathOptions
): string {
  const record = [...tenantAssetLines(ref.tenant, options)].find(
    (line) => line.asset_id === ref.assetId && line.version === ref.version
  );
  if (!record || typeof record.target_path !== 'string')
    throw new Error(`[DERIVATION_INVALID] asset ref unresolved at deletion`);
  assertRepoRelative(record.target_path, options);
  assertDerivablePath(record.target_path);
  const targetTenant = tenantFromRepoPath(record.target_path);
  if (targetTenant !== undefined && targetTenant !== ref.tenant)
    throw new Error(
      `[DERIVATION_INVALID] asset ${ref.assetId}@v${ref.version} targets a different tenant's tree — ledger line is anomalous`
    );
  return record.target_path;
}

/** Already-propagated derived paths (deletions ledger), for offboarding overlap checks. */
export function deletedDerivedPaths(
  custody: DerivationCustody,
  options: DerivationPathOptions = {}
): Set<string> {
  const file = deletionsPath(custody, options);
  if (!safeExistsSync(file)) return new Set();
  const deleted = new Set<string>();
  for (const line of streamJsonLines<{ deleted_paths?: unknown }>(file, { onMalformed: 'skip' })) {
    if (!Array.isArray(line.deleted_paths)) continue;
    for (const p of line.deleted_paths)
      if (typeof p === 'string') deleted.add(normalizeRepoPath(p));
  }
  return deleted;
}
