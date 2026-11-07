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
import { createHash } from 'node:crypto';
import { resolveRole } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeRmSync,
  safeReadFileSnapshot,
} from '../secure-io.js';
import { logger } from '../core.js';
import { appendJsonLine } from '../foundation/json.js';
import { streamJsonLines } from '../storage/jsonl-read.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { nowIso } from '../foundation/time.js';
import { KNOWLEDGE_TIER_RANK } from '../foundation/knowledge-tier.js';
import type { KnowledgeTier } from '../foundation/knowledge-tier.js';
import { detectTier, validateReadPermission } from '../tier-guard.js';
import {
  currentAssetDerivationReceiptSnapshot,
  withAssetDerivationReceiptSnapshot,
} from './asset-derivation-read-capability.js';
import { isValidTenantSlug, isValidMemberId } from '../foundation/scope.js';
import { COMMON_TENANT_SLUG } from './ingest-asset-ledger.js';
import { tenantOfPath } from '../governance/path-tenant-attribution.js';
import {
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  PARTITIONED_RUNTIME_STATE_ROOTS,
  STORAGE_FLOOR_ROOTS,
} from '../foundation/runtime-state-roots.js';
import { partitionedRuntimeTierInPath } from '../storage-layout.js';
import type { MemoryProvenanceRecord } from '../knowledge/memory-provenance.js';

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
  /** Offboarding must not mistake unreadable/corrupt lineage for an empty graph. */
  strictLineage?: boolean;
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
  sourceCustodies: readonly DerivationCustody[],
  rootDir: string = pathResolver.rootDir()
): boolean {
  const custody = custodyFromRepoPath(derivedPath, rootDir);
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

/** Resolve physical source custody with immutable producer snapshots when
 * available; mutable ingest rows alone never grant foreign custody.
 */
function directVerifiedRecordSources(
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
      if (!sourceSnapshotMatches(record, source, rel, options)) continue;
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
    const binding = record.proof?.sources.find((proof) => proof.ref === source);
    // Issuance binds historical asset identity to its original path. A mutable
    // ingest index is only consulted when there is no producer snapshot.
    const line = binding
      ? { target_path: binding.path }
      : [...tenantAssetLines(ref.tenant, options)].find(
          (entry) =>
            entry.asset_id === ref.assetId &&
            entry.version === ref.version &&
            typeof entry.target_path === 'string'
        );
    if (!line || typeof line.target_path !== 'string') continue;
    const rel = normalizeRepoPath(line.target_path);
    if (!sourceSnapshotMatches(record, source, rel, options)) continue;
    if (!isDerivableRepoPath(rel)) continue;
    const targetTenant = tenantFromRepoPath(rel, root);
    if (targetTenant !== undefined && targetTenant !== ref.tenant) continue;
    assertAssetSourceCustody(ref, rel, options);
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

/** Include verified upstream lineage without losing tenant labels at a system hop. */
function inheritedRecordSources(
  record: AssetDerivationRecord,
  options: DerivationPathOptions,
  entries: LedgerEntry[],
  visiting: Set<string>,
  memo = new Map<string, VerifiedSource[]>()
): VerifiedSource[] {
  const key = JSON.stringify(record);
  const cached = memo.get(key);
  if (cached) return cached;
  const sources = directVerifiedRecordSources(record, options);
  if (visiting.has(key)) return sources;
  const next = new Set(visiting).add(key);
  for (const source of record.sources) {
    let sourcePath: string;
    try {
      const ref = parseDerivationRef(source);
      sourcePath = normalizeRepoPath(
        record.proof?.sources.find((proof) => proof.ref === source)?.path ??
          (ref.kind === 'path' ? ref.path : sourcePathOfAsset(ref, options))
      );
    } catch {
      continue;
    }
    const sourceAbsolute = assertRepoRelative(sourcePath, options);
    const currentHash = safeExistsSync(sourceAbsolute) ? fileDigest(sourceAbsolute) : undefined;
    const hasCurrentReceipt =
      currentHash !== undefined &&
      entries.some(
        (entry) =>
          entry.partition.kind === 'system' &&
          entry.record.derived.path === sourcePath &&
          entry.record.proof?.derivedSha256 === currentHash
      );
    const visitedPrior = new Set<string>();
    for (const prior of entries) {
      const priorKey = JSON.stringify(prior.record);
      if (
        normalizeRepoPath(prior.record.derived.path) !== sourcePath ||
        next.has(priorKey) ||
        visitedPrior.has(priorKey)
      )
        continue;
      if (hasCurrentReceipt && prior.record.proof?.derivedSha256 !== currentHash) continue;
      if (!landingHonored(prior.record, prior.partition, sourcePath, options, entries, next, memo))
        continue;
      visitedPrior.add(priorKey);
      for (const inherited of inheritedRecordSources(prior.record, options, entries, next, memo)) {
        sources.push({
          custody: inherited.custody,
          taint: combineAssetTaint([prior.record.taint, inherited.taint]),
        });
      }
    }
  }
  const merged = new Map<string, VerifiedSource>();
  for (const source of sources) {
    const partition = custodyPartition(source.custody);
    const previous = merged.get(partition);
    merged.set(
      partition,
      previous
        ? { custody: source.custody, taint: combineAssetTaint([previous.taint, source.taint]) }
        : source
    );
  }
  const result = [...merged.values()];
  memo.set(key, result);
  return result;
}

export function verifiedRecordSources(
  record: AssetDerivationRecord,
  options: DerivationPathOptions = {}
): VerifiedSource[] {
  if (options.strictLineage) readLedger({ kind: 'system' }, options);
  return inheritedRecordSources(
    record,
    options,
    recordsAllCustodians({ ...options, strictLineage: false }),
    new Set()
  );
}

/** Honor only producer-attested, unchanged output with verified source
 * snapshots and inherited custody/taint. Tenant copies cannot widen the
 * protected receipt's authority; legacy unattested lineage blocks strict replay.
 */
export function recordedLandingHonored(
  record: AssetDerivationRecord,
  partition: DerivationCustody,
  derivedPath: string,
  options: DerivationPathOptions = {}
): boolean {
  return landingHonored(
    record,
    partition,
    derivedPath,
    options,
    recordsAllCustodians(options),
    new Set()
  );
}

function landingHonored(
  record: AssetDerivationRecord,
  partition: DerivationCustody,
  derivedPath: string,
  options: DerivationPathOptions,
  entries: LedgerEntry[],
  visiting: Set<string>,
  memo = new Map<string, VerifiedSource[]>()
): boolean {
  const receipt = JSON.stringify(record);
  if (
    !record.proof ||
    !entries.some(
      (entry) => entry.partition.kind === 'system' && JSON.stringify(entry.record) === receipt
    )
  ) {
    if (options.strictLineage)
      throw new Error('[DERIVATION_UNATTESTED] lineage has no trusted system issuance receipt');
    return false;
  }
  const current = path.join(rootOf(options), normalizeRepoPath(derivedPath));
  if (safeExistsSync(current) && fileDigest(current) !== record.proof.derivedSha256) {
    if (options.strictLineage)
      throw new Error('[DERIVATION_CHANGED] derived bytes differ from the issued lineage receipt');
    return false;
  }
  const rel = normalizeRepoPath(derivedPath);
  // A landing must be a derivable data location — keeps "seedable" and
  // "deletable" identical envelopes (a legit derived.path always is).
  if (!isDerivableRepoPath(rel)) return false;
  const verified = inheritedRecordSources(record, options, entries, visiting, memo);
  // A protected system row is also the producer's issuance receipt. It can
  // attest any source custodian; an untrusted custodian copy cannot do so.
  if (
    partition.kind !== 'system' &&
    !verified.some((source) => custodyEquals(source.custody, partition))
  )
    return false;
  const landing = custodyFromRepoPath(rel, rootOf(options));
  if (
    landing.kind !== 'system' &&
    !(partition.kind === 'system'
      ? verified.some((source) => custodyEquals(source.custody, landing))
      : custodyEquals(landing, partition))
  )
    return false;
  if (
    !derivedLandingAllowed(
      rel,
      verified.map((source) => source.custody),
      rootOf(options)
    )
  )
    return false;
  const floor = combineAssetTaint([record.taint, ...verified.map((source) => source.taint)]);
  if (landing.kind === 'tenant' && floor.tenants.some((tenant) => tenant !== landing.ref))
    return false;
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
  proof?: {
    derivedSha256: string;
    sources: { ref: string; path: string; sha256: string }[];
  };
}

function fileDigest(file: string): string {
  const stat = safeLstat(file);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error('[DERIVATION_FILE_INVALID] lineage requires a single-link regular file');
  const bytes = safeReadFileSnapshot(file, 64 * 1024 * 1024);
  const after = safeLstat(file);
  if (
    !after.isFile() ||
    after.nlink !== 1 ||
    stat.dev !== after.dev ||
    stat.ino !== after.ino ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ctimeMs !== after.ctimeMs
  )
    throw new Error('[DERIVATION_CHANGED] source or output changed during receipt verification');
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceSnapshotMatches(
  record: AssetDerivationRecord,
  source: string,
  rel: string,
  options: DerivationPathOptions
): boolean {
  if (!record.proof) return true;
  const binding = record.proof.sources.find((proof) => proof.ref === source);
  const absolute = assertRepoRelative(rel, options);
  let missing = false;
  try {
    safeLstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    missing = true;
  }
  if (!binding || binding.path !== rel || (!missing && fileDigest(absolute) !== binding.sha256)) {
    if (options.strictLineage)
      throw new Error(
        '[DERIVATION_SOURCE_CHANGED] source path or bytes differ from the protected receipt'
      );
    return false;
  }
  return true;
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
  if (typeof t.highestTier !== 'string' || !Object.hasOwn(KNOWLEDGE_TIER_RANK, t.highestTier))
    return null;
  if (!Array.isArray(t.tenants) || !t.tenants.every((x) => typeof x === 'string')) return null;
  if (typeof t.prohibitExternal !== 'boolean') return null;
  const sources = record.sources as string[];
  if (record.proof !== undefined) {
    const proof = record.proof as AssetDerivationRecord['proof'];
    if (
      !proof ||
      typeof proof !== 'object' ||
      !/^[a-f0-9]{64}$/.test(proof.derivedSha256) ||
      !Array.isArray(proof.sources) ||
      proof.sources.length !== record.sources.length ||
      !proof.sources.every(
        (source) =>
          source &&
          typeof source.ref === 'string' &&
          sources.includes(source.ref) &&
          typeof source.path === 'string' &&
          typeof source.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(source.sha256)
      )
    )
      return null;
  }
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
  const snapshot = currentAssetDerivationReceiptSnapshot(rootOf(options));
  if (snapshot)
    return snapshot
      .filter((entry) => custodyEquals(entry.partition, custody))
      .map((entry) => entry.record);
  const file = ledgerPath(custody, options);
  if (options.strictLineage) {
    assertRepoRelative(`${custodyPartition(custody)}/${DERIVATIONS_FILENAME}`, options);
    try {
      if (!safeLstat(file).isFile())
        throw new Error('[DERIVATION_LEDGER_INVALID] ledger is not a regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  if (!safeExistsSync(file)) return [];
  const records: AssetDerivationRecord[] = [];
  for (const line of streamJsonLines<unknown>(file, {
    onMalformed: options.strictLineage ? 'throw' : 'skip',
  })) {
    const record = asDerivationRecord(line);
    if (record) records.push(record);
    else if (options.strictLineage)
      throw new Error(
        '[DERIVATION_LEDGER_INVALID] malformed derivation record prevents complete lineage verification'
      );
    else
      logger.warn(
        `[asset-derivation] skipped malformed derivation line in ${custodyPartition(custody)}/${DERIVATIONS_FILENAME} — ledger content failed shape validation`
      );
  }
  return records;
}

interface ResolvedSource {
  ref: DerivationRef;
  path: string;
  custody: DerivationCustody;
  taint: AssetTaint;
  custodies?: DerivationCustody[];
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
  const tenant = tenantFromRepoPath(relativePath, rootOf(options));
  return {
    highestTier: tier,
    tenants: tenant ? [tenant] : [],
    prohibitExternal: tier !== 'public',
  };
}

/** Resolve a source ref against its own system's record — never caller-declared. */
function resolveDirectSource(ref: DerivationRef, options: DerivationPathOptions): ResolvedSource {
  if (ref.kind === 'path') {
    const absolute = assertRepoRelative(ref.path, options);
    assertDerivablePath(ref.path);
    if (!safeExistsSync(absolute))
      throw new Error(
        `[DERIVATION_INVALID] source path '${ref.path}' does not exist — a derivation cannot claim a phantom source`
      );
    return {
      ref,
      path: normalizeRepoPath(ref.path),
      custody: custodyFromRepoPath(ref.path, rootOf(options)),
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
  const targetTenant = tenantFromRepoPath(record.target_path, rootOf(options));
  if (targetTenant !== undefined && targetTenant !== ref.tenant)
    throw new Error(
      `[DERIVATION_INVALID] asset ${ref.assetId}@v${ref.version} targets a different tenant's tree — ledger line is anomalous`
    );
  assertAssetSourceCustody(ref, record.target_path, options);
  return {
    ref,
    path: normalizeRepoPath(record.target_path),
    custody: { kind: 'tenant', ref: ref.tenant },
    taint: { ...sourceTaintFromPath(record.target_path, options), tenants: [ref.tenant] },
  };
}

function resolveSource(ref: DerivationRef, options: DerivationPathOptions): ResolvedSource {
  const direct = resolveDirectSource(ref, options);
  const inherited = verifiedRecordSources(
    {
      derived: { ref: 'path:unused', path: 'unused', kind: 'other' },
      sources: [formatDerivationRef(ref)],
      taint: direct.taint,
      recorded_at: '',
    },
    { ...options, strictLineage: true }
  );
  return {
    ...direct,
    taint: combineAssetTaint([direct.taint, ...inherited.map((source) => source.taint)]),
    custodies: [direct.custody, ...inherited.map((source) => source.custody)],
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
  if (!['mission_controller', 'knowledge_steward', 'chronos_gateway'].includes(resolveRole() ?? ''))
    throw new Error(
      '[DERIVATION_ISSUER_REQUIRED] recording lineage requires a governed producer role'
    );
  const options = input.options ?? {};
  if (input.sources.length === 0)
    throw new Error('[DERIVATION_INVALID] a derivation needs at least one source');
  const derivedAbs = assertRepoRelative(input.derived.path, options);
  assertDerivablePath(input.derived.path);
  const resolved = input.sources.map((ref) => resolveSource(ref, options));
  const taint = combineAssetTaint(resolved.map((source) => source.taint));
  const landingCustody = custodyFromRepoPath(input.derived.path, rootOf(options));
  if (
    landingCustody.kind === 'tenant' &&
    taint.tenants.some((tenant) => tenant !== landingCustody.ref)
  )
    throw new Error(
      '[DERIVATION_CUSTODY_INVALID] tenant landing would disclose another tenant provenance'
    );
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
      resolved.flatMap((s) => s.custodies ?? [s.custody]),
      rootOf(options)
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
  for (const source of resolved)
    for (const custody of source.custodies ?? [source.custody])
      custodians.set(custodyPartition(custody), custody);
  const allSources = resolved.map((source) => formatDerivationRef(source.ref)).sort();
  const recordedAt = nowIso();
  const proof = {
    derivedSha256: fileDigest(derivedAbs),
    sources: resolved
      .map((source) => {
        const sourcePath = source.path;
        return {
          ref: formatDerivationRef(source.ref),
          path: normalizeRepoPath(sourcePath),
          sha256: fileDigest(assertRepoRelative(sourcePath, options)),
        };
      })
      .sort((a, b) => a.ref.localeCompare(b.ref)),
  };
  const records: AssetDerivationRecord[] = [];
  let receiptWritten = false;
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
      proof,
    };
    if (!receiptWritten) {
      const receiptFile = ledgerPath({ kind: 'system' }, options);
      withLockSync(`asset-derivation:${custodyPartition({ kind: 'system' })}`, () => {
        safeMkdir(path.dirname(receiptFile), { recursive: true });
        appendJsonLine(receiptFile, record);
      });
      receiptWritten = true;
    }
    const file = ledgerPath(custody, options);
    withLockSync(`asset-derivation:${custodyPartition(custody)}`, () => {
      safeMkdir(path.dirname(file), { recursive: true });
      if (custody.kind !== 'system') appendJsonLine(file, record);
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
  const snapshot = currentAssetDerivationReceiptSnapshot(rootOf(options));
  if (snapshot) return snapshot;
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
      if (options.strictLineage) throw error;
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
    } catch (error) {
      if (options.strictLineage) throw error;
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
  const normalizedSource = normalizeRepoPath(ref.path);
  // Query the asset refs actually used by lineage, rather than assuming the
  // physical landing partition identifies the ingest ledger's custodian.
  for (const entry of recordsAllCustodians(options)) {
    if (entry.partition.kind !== 'system' || !entry.record.proof) continue;
    for (const source of entry.record.sources) {
      try {
        const candidate = parseDerivationRef(source);
        if (candidate.kind !== 'asset') continue;
        const binding = entry.record.proof?.sources.find((proof) => proof.ref === source);
        const originalPath = binding?.path ?? sourcePathOfAsset(candidate, options);
        if (normalizeRepoPath(originalPath) === normalizedSource)
          alternates.push(formatDerivationRef(candidate));
      } catch (error) {
        if (options.strictLineage) throw error;
      }
    }
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

/** Proven transitive targets for offboarding; inability to prove completeness blocks it. */
export function listHonoredDerivedPathsForCustodian(
  custody: DerivationCustody,
  options: DerivationPathOptions = {}
): string[] {
  const root = path.resolve(rootOf(options));
  const canonical = root === path.resolve(pathResolver.rootDir());
  const producer = ['mission_controller', 'knowledge_steward', 'chronos_gateway'].includes(
    resolveRole() ?? ''
  );
  if ((!canonical || custody.kind !== 'tenant') && !producer)
    throw new Error(
      '[DERIVATION_READ_SCOPE] noncanonical, personal and system lineage queries require producer authority'
    );
  const bound =
    custody.kind === 'system'
      ? { kind: 'system' as const }
      : custody.kind === 'tenant'
        ? { kind: 'tenant' as const, ref: custody.ref }
        : { kind: 'person' as const, ...(custody.ref ? { ref: custody.ref } : {}) };
  const strict = { rootDir: root, strictLineage: true };
  const permission = validateReadPermission(ledgerPath(bound, strict));
  if (!permission.allowed)
    throw new Error(`[DERIVATION_READ_SCOPE] own lineage index denied: ${permission.reason}`);
  const own = readLedger(bound, strict);
  return withAssetDerivationReceiptSnapshot(
    root,
    bound,
    own,
    () => readLedger({ kind: 'system' }, strict),
    () => listHonoredDerivedPathsInSnapshot(bound, strict),
    canonical
  );
}

function listHonoredDerivedPathsInSnapshot(
  custody: DerivationCustody,
  options: DerivationPathOptions
): string[] {
  const strict = { ...options, strictLineage: true };
  const entries = recordsAllCustodians(strict);
  const targets = new Set<string>();
  const pending: DerivationRef[] = [];
  for (const entry of entries) {
    if (
      !custodyEquals(entry.partition, custody) &&
      !(
        entry.partition.kind === 'system' &&
        (custody.kind === 'tenant'
          ? entry.record.taint.tenants.includes(custody.ref)
          : inheritedRecordSources(entry.record, strict, entries, new Set()).some((source) =>
              custodyEquals(source.custody, custody)
            ))
      )
    )
      continue;
    const rel = normalizeRepoPath(entry.record.derived.path);
    if (!landingHonored(entry.record, entry.partition, rel, strict, entries, new Set()))
      throw new Error(
        '[DERIVATION_LINEAGE_UNPROVEN] custodian lineage cannot authorize its recorded landing'
      );
    targets.add(rel);
    pending.push({ kind: 'path', path: rel });
  }
  const visited = new Set<string>();
  while (pending.length > 0) {
    const ref = pending.pop()!;
    const key = formatDerivationRef(ref);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const entry of derivationClosureEntries(ref, strict)) {
      const honored = entry.claims.some((claim) =>
        landingHonored(claim.record, claim.partition, entry.path, strict, entries, new Set())
      );
      if (!honored)
        throw new Error(
          '[DERIVATION_LINEAGE_UNPROVEN] reachable lineage cannot authorize its recorded landing'
        );
      targets.add(entry.path);
      pending.push({ kind: 'path', path: entry.path });
    }
  }
  return [...targets].sort();
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
  const sourcePath = resolved.path;
  const sourceKey = formatDerivationRef(input.ref);
  const sourceDigest = fileDigest(assertRepoRelative(sourcePath, options));
  const bindings = readLedger({ kind: 'system' }, { ...options, strictLineage: true })
    .flatMap((receipt) => receipt.proof?.sources ?? [])
    .filter(
      (binding) =>
        binding.ref === sourceKey || (input.ref.kind === 'path' && binding.path === sourcePath)
    );
  if (
    bindings.length > 0 &&
    !bindings.some((binding) => binding.path === sourcePath && binding.sha256 === sourceDigest)
  )
    throw new Error(
      '[DERIVATION_SOURCE_CHANGED] requested source no longer matches its issued version'
    );
  const skipped: string[] = [];
  const candidates: { rel: string; abs: string; digest: string; identity: string }[] = [];
  const identityOf = (file: string): string => {
    const stat = safeLstat(file);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error('[DERIVATION_FILE_INVALID] deletion requires a single-link regular file');
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  };
  const capture = (rel: string, abs: string): void => {
    const identity = identityOf(abs);
    const digest = fileDigest(abs);
    if (identity !== identityOf(abs))
      throw new Error('[DERIVATION_CHANGED] deletion target changed during capture');
    candidates.push({ rel, abs, digest, identity });
  };
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
    try {
      capture(rel, abs);
    } catch {
      skipped.push(rel);
    }
  };
  for (const entry of derivationClosureEntries(input.ref, options)) consider(entry);
  // The source itself is deletable by contract — resolveSource already
  // verified it is repository-local, derivable and tenant-consistent.
  try {
    capture(sourceRel, assertRepoRelative(sourceRel, options));
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
      withLockSync(`asset-derivation-delete:${candidate.rel}`, () => {
        const current = assertRepoRelative(candidate.rel, options);
        if (
          identityOf(current) !== candidate.identity ||
          fileDigest(current) !== candidate.digest ||
          identityOf(current) !== candidate.identity
        )
          throw new Error(
            '[DERIVATION_CHANGED] deletion target no longer matches its captured identity'
          );
        safeRmSync(current, { recursive: false, force: true });
        deleted.push(candidate.rel);
      });
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
      safeMkdir(path.dirname(file), { recursive: true });
      appendJsonLine(file, {
        source_ref: formatDerivationRef(input.ref),
        source_path: normalizeRepoPath(sourcePath),
        deleted_paths: deleted,
        skipped_paths: skipped,
        deleted_at: nowIso(),
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
  const targetTenant = tenantFromRepoPath(record.target_path, rootOf(options));
  if (targetTenant !== undefined && targetTenant !== ref.tenant)
    throw new Error(
      `[DERIVATION_INVALID] asset ${ref.assetId}@v${ref.version} targets a different tenant's tree — ledger line is anomalous`
    );
  assertAssetSourceCustody(ref, record.target_path, options);
  return record.target_path;
}

/** Tenant-editable ingest rows do not grant custody of arbitrary system/person files. */
function assertAssetSourceCustody(
  ref: Extract<DerivationRef, { kind: 'asset' }>,
  relativePath: string,
  options: DerivationPathOptions
): void {
  const custody = custodyFromRepoPath(relativePath, rootOf(options));
  if (custody.kind === 'tenant' && custody.ref === ref.tenant) return;
  if (custody.kind === 'person')
    throw new Error(
      '[DERIVATION_INVALID] tenant ingest cannot confer custody of personal material'
    );
  const rel = normalizeRepoPath(relativePath);
  const currentHash = safeExistsSync(path.join(rootOf(options), rel))
    ? fileDigest(assertRepoRelative(rel, options))
    : undefined;
  const proof = readLedger({ kind: 'system' }, { ...options, strictLineage: true }).find(
    (record) =>
      record.derived.path === rel &&
      record.proof &&
      record.taint.tenants.length === 1 &&
      record.taint.tenants[0] === ref.tenant &&
      (currentHash === undefined || record.proof.derivedSha256 === currentHash)
  );
  if (!proof?.proof)
    throw new Error(
      '[DERIVATION_INVALID] ingest target has no matching tenant custody or protected producer receipt'
    );
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
