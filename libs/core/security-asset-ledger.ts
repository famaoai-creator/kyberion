import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';
import { tenantIngestKnowledgeRoot, type IngestLedgerPathOptions } from './ingest-asset-ledger.js';

/**
 * External-asset security ledger — the governed, append-only record of the
 * tenant's external-service inventory
 * (knowledge/public/procedures/system/external-asset-inventory.md).
 *
 * Location: `knowledge/confidential/{tenant}/security/external-assets.jsonl`
 * — tenant scope via the tenant registry (fail-closed, same as ingest).
 *
 * Unlike the ingest ledger (one record per *source document*), one record
 * here represents one *service_id* — the canonical ledger row. A promotion
 * (draft → registry) appends version n+1; prior lines keep their stored
 * status (history is never rewritten). `retired` is a governed logical
 * deletion, appended only by an explicit retire ceremony.
 */

export type SecurityAssetStatus = 'active' | 'superseded' | 'retired';

/** One applied check outcome (IPA checklist item, exposure probe, review). */
export interface SecurityCheckResult {
  /** Checklist/probe id, e.g. 'A-1-reachability', 'A-2', 'B-3'. */
  check_id: string;
  /** Outcome label — 'ok', 'finding', 'manual-verified', 'not-applicable', 'error'. */
  result: string;
  /** Evidence pointer or short note (never raw secrets). */
  evidence?: string;
  checked_at?: string;
  checker?: string;
}

/** Canonical ledger fields, mirroring the procedure's Phase 2 schema. */
export interface SecurityAssetEntry {
  service_id: string;
  name: string;
  vendor?: string;
  category:
    | 'saas'
    | 'cloud'
    | 'vpn'
    | 'published-app'
    | 'api-integration'
    | 'data-store'
    | 'network-control'
    | 'identity';
  endpoints: string[];
  exposure: 'public' | 'partner-restricted' | 'internal-only' | 'unknown';
  data_classification: 'personal' | 'confidential' | 'public' | 'unknown';
  auth_method: 'sso' | 'local-password' | 'api-key' | 'federated' | 'unknown';
  mfa_status: 'enforced' | 'optional' | 'unavailable' | 'unknown';
  log_access: string;
  account_admin: string;
  owner: string;
  department: string;
  contract_ref: string;
  discovery_sources: string[];
  last_verified: string;
  shadow: boolean;
  review_status: 'pending' | 'verified';
  /** Phase 3/4 evidence: applied IPA/probe check outcomes (latest per check_id). */
  check_results?: SecurityCheckResult[];
  provenance?: {
    source_op?: string;
    evidence?: string[];
    signal_rules?: string[];
    via?: string[];
    unresolved_refs?: string[];
  };
}

export interface SecurityAssetRecord {
  /** Stable id: 'sec-' + sha256('sec-ledger::' + service_id)[0..16]. */
  asset_id: string;
  service_id: string;
  entry: SecurityAssetEntry;
  promoted_at: string;
  /** Who performed the promotion ceremony (KYBERION_PERSONA / MISSION_ROLE). */
  promoted_by: string;
  /** Approval reference for a governed promotion or verification, if any. */
  approval_id?: string;
  version: number;
  /** Previous record ref ('{asset_id}@v{n}'). */
  supersedes?: string;
  status: SecurityAssetStatus;
  /** When status is 'retired': who/what authorized the retirement. */
  retired_at?: string;
}

export type SecurityLedgerPathOptions = IngestLedgerPathOptions;

const SECURITY_LEDGER_DIRNAME = 'security';
const SECURITY_LEDGER_FILENAME = 'external-assets.jsonl';

const SECURITY_ASSET_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/security-asset-record.schema.json'
);

function securityAssetCatalog(filePath: string): GovernedCatalog<SecurityAssetRecord> {
  return defineCatalog<SecurityAssetRecord>({
    id: 'security-asset-record',
    path: filePath,
    schema: SECURITY_ASSET_SCHEMA_PATH,
  });
}

/** Deterministic record id: re-promoting the same service_id maps to the same asset. */
export function deriveSecurityAssetId(serviceId: string): string {
  const id = String(serviceId || '').trim();
  if (!id) throw new Error('[security-asset-ledger] service_id is required');
  return `sec-${createHash('sha256').update(`sec-ledger::${id}`).digest('hex').slice(0, 16)}`;
}

export function securityLedgerPath(
  tenantSlug: string,
  options: SecurityLedgerPathOptions = {}
): string {
  const rootDir = options.rootDir
    ? assertSafeRepositoryPath(options.rootDir, { allowMissingLeaf: true })
    : pathResolver.rootDir();
  const knowledgeRoot = tenantIngestKnowledgeRoot(tenantSlug, options);
  return assertSafeRepositoryPath(
    path.join(rootDir, knowledgeRoot, SECURITY_LEDGER_DIRNAME, SECURITY_LEDGER_FILENAME),
    { allowMissingLeaf: true }
  );
}

function ensureRegularLedgerFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`[security-asset-ledger] ledger must be a regular file: ${filePath}`);
  }
}

const SERVICE_ID_RE = /^(svc|asset):[a-z0-9][a-z0-9:_-]*$/;
const CATEGORIES = new Set([
  'saas',
  'cloud',
  'vpn',
  'published-app',
  'api-integration',
  'data-store',
  'network-control',
  'identity',
]);
const EXPOSURES = new Set(['public', 'partner-restricted', 'internal-only', 'unknown']);
const DATA_CLASSES = new Set(['personal', 'confidential', 'public', 'unknown']);
const AUTH_METHODS = new Set(['sso', 'local-password', 'api-key', 'federated', 'unknown']);
const MFA_STATUSES = new Set(['enforced', 'optional', 'unavailable', 'unknown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSecurityEntry(entry: unknown): asserts entry is SecurityAssetEntry {
  const problems: string[] = [];
  if (!isRecord(entry)) {
    throw new Error('[security-asset-ledger] entry must be an object');
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.service_id !== 'string' || !SERVICE_ID_RE.test(e.service_id)) {
    problems.push('service_id must match svc:* / asset:*');
  }
  if (!String(e.name || '').trim()) problems.push('name is required');
  if (!CATEGORIES.has(e.category as string))
    problems.push(`category must be one of ${[...CATEGORIES].join('/')}`);
  if (!Array.isArray(e.endpoints)) problems.push('endpoints must be an array');
  if (!EXPOSURES.has(e.exposure as string)) problems.push('exposure must be a schema value');
  if (!DATA_CLASSES.has(e.data_classification as string))
    problems.push('data_classification must be a schema value');
  if (!AUTH_METHODS.has(e.auth_method as string))
    problems.push('auth_method must be a schema value');
  if (!MFA_STATUSES.has(e.mfa_status as string)) problems.push('mfa_status must be a schema value');
  if (!Array.isArray(e.discovery_sources) || e.discovery_sources.length === 0) {
    problems.push('discovery_sources must be a non-empty array');
  }
  if (e.review_status !== 'pending' && e.review_status !== 'verified') {
    problems.push("review_status must be 'pending' or 'verified'");
  }
  if (problems.length > 0) {
    throw new Error(
      `[security-asset-ledger] invalid entry (nothing appended): ${problems.join('; ')}`
    );
  }
}

/**
 * Reads every ledger line in append order. Corrupt lines are skipped — the
 * ledger is append-only evidence and one bad line must not block reads.
 */
export function readSecurityLedger(
  tenantSlug: string,
  options: SecurityLedgerPathOptions = {}
): SecurityAssetRecord[] {
  const ledgerFile = securityLedgerPath(tenantSlug, options);
  if (!safeExistsSync(ledgerFile)) return [];
  ensureRegularLedgerFile(ledgerFile);
  const catalog = securityAssetCatalog(ledgerFile);
  return readJsonLines<SecurityAssetRecord | null>(ledgerFile, {
    onMalformed: 'skip',
    map: (value, lineNumber) => {
      const record = catalog.validate(value, `${ledgerFile}:${lineNumber}`);
      if (!isRecord(record) || !isRecord(record.entry)) return null;
      try {
        // A corrupt service_id would throw inside derive — skip the line,
        // never block the whole append-only read.
        if (deriveSecurityAssetId(String(record.service_id || '')) !== record.asset_id) return null;
      } catch {
        return null;
      }
      return record;
    },
  }).filter((record): record is SecurityAssetRecord => record !== null);
}

function latestPerAsset(records: SecurityAssetRecord[]): Map<string, SecurityAssetRecord> {
  const latest = new Map<string, SecurityAssetRecord>();
  for (const record of records) {
    const current = latest.get(record.asset_id);
    if (!current || record.version > current.version) latest.set(record.asset_id, record);
  }
  return latest;
}

/** Latest record per service_id, codepoint-sorted (deterministic). */
export function listSecurityAssets(
  tenantSlug: string,
  options: SecurityLedgerPathOptions = {}
): SecurityAssetRecord[] {
  return [...latestPerAsset(readSecurityLedger(tenantSlug, options)).values()].sort(
    (left, right) =>
      left.service_id < right.service_id ? -1 : left.service_id > right.service_id ? 1 : 0
  );
}

/** Latest record for one service_id, or null. */
export function findServiceRecord(
  tenantSlug: string,
  serviceId: string,
  options: SecurityLedgerPathOptions = {}
): SecurityAssetRecord | null {
  const assetId = deriveSecurityAssetId(serviceId);
  const records = readSecurityLedger(tenantSlug, options).filter((r) => r.asset_id === assetId);
  if (records.length === 0) return null;
  return records.reduce((best, r) => (r.version > best.version ? r : best));
}

/**
 * Full version chain of one service_id, supersede-resolved: every record
 * except the highest version is reported as 'superseded' (stored lines keep
 * their own status — history is never rewritten).
 */
export function serviceLineage(
  tenantSlug: string,
  serviceId: string,
  options: SecurityLedgerPathOptions = {}
): SecurityAssetRecord[] {
  const assetId = deriveSecurityAssetId(serviceId);
  const chain = readSecurityLedger(tenantSlug, options)
    .filter((r) => r.asset_id === assetId)
    .sort((a, b) => a.version - b.version);
  if (chain.length === 0) return [];
  const maxVersion = chain[chain.length - 1].version;
  return chain.map((r) => (r.version === maxVersion ? r : { ...r, status: 'superseded' as const }));
}

function assertSecurityRecord(record: SecurityAssetRecord): void {
  const problems: string[] = [];
  if (!record || typeof record !== 'object') {
    throw new Error('[security-asset-ledger] record must be an object');
  }
  if (typeof record.asset_id !== 'string' || !record.asset_id.startsWith('sec-')) {
    problems.push('asset_id must be a sec-* id');
  }
  if (!String(record.service_id || '').trim()) problems.push('service_id is required');
  if (!String(record.promoted_at || '').trim()) problems.push('promoted_at is required');
  if (!String(record.promoted_by || '').trim()) problems.push('promoted_by is required');
  if (!Number.isInteger(record.version) || record.version < 1) {
    problems.push('version must be a positive integer');
  }
  if (!['active', 'superseded', 'retired'].includes(record.status)) {
    problems.push("status must be 'active', 'superseded', or 'retired'");
  }
  if (problems.length > 0) {
    throw new Error(
      `[security-asset-ledger] invalid record (nothing appended): ${problems.join('; ')}`
    );
  }
  assertSecurityEntry(record.entry);
  if (record.entry.service_id !== record.service_id) {
    throw new Error('[security-asset-ledger] service_id must match entry.service_id');
  }
  if (deriveSecurityAssetId(record.service_id) !== record.asset_id) {
    throw new Error(
      `[security-asset-ledger] asset_id does not match deriveSecurityAssetId(service_id)`
    );
  }
}

/** Append one validated record — append-only by construction. */
export function appendSecurityRecord(
  tenantSlug: string,
  record: SecurityAssetRecord,
  options: SecurityLedgerPathOptions = {}
): SecurityAssetRecord {
  assertSecurityRecord(record);
  const ledgerFile = securityLedgerPath(tenantSlug, options);
  safeMkdir(path.dirname(ledgerFile), { recursive: true });
  ensureRegularLedgerFile(ledgerFile);
  appendJsonLine(ledgerFile, securityAssetCatalog(ledgerFile).validate(record, ledgerFile));
  return record;
}

/* ------------------------------------------------------------------ */
/* Promotion: draft → governed registry                                 */
/* ------------------------------------------------------------------ */

/** Minimal draft shape — structurally satisfied by modeling-actuator's
 *  `ExternalAssetLedgerDraft` (core does not depend on the actuator). */
export interface SecurityLedgerDraftLike {
  as_of?: string;
  entries: SecurityAssetEntry[];
}

export interface PromoteOptions extends SecurityLedgerPathOptions {
  /** Who performs the ceremony (KYBERION_PERSONA / MISSION_ROLE). */
  promotedBy: string;
  /** Date (YYYY-MM-DD) recorded when entries are verified via verify_ids.
   *  Defaults to the promotion date. */
  asOf?: string;
  /** service_ids the human reviewed — promoted with review_status 'verified'. */
  verifyIds?: string[];
  /** Approval reference recorded on every appended record. */
  approvalId?: string;
  /** Governance-field corrections applied to the entries before merging
   *  (the explicit way a human updates owner/contract/MFA/…). */
  overrides?: Partial<
    Pick<
      SecurityAssetEntry,
      | 'owner'
      | 'department'
      | 'contract_ref'
      | 'auth_method'
      | 'mfa_status'
      | 'log_access'
      | 'account_admin'
      | 'data_classification'
    >
  >;
  /** Compute the merge plan without appending (the --dry-run path). */
  dryRun?: boolean;
}

export interface PromoteResult {
  committed: boolean;
  dry_run?: boolean;
  ledger_path: string;
  added: string[];
  updated: string[];
  unchanged: string[];
  verified: string[];
  /** Ledger services NOT present in the draft — reported, never auto-retired. */
  not_observed: string[];
  skipped_unknown_verify_ids: string[];
  /** service_ids that appear more than once in the draft (first wins). */
  duplicate_draft_ids: string[];
}

function mergeEntry(head: SecurityAssetEntry, next: SecurityAssetEntry): SecurityAssetEntry {
  const merged: SecurityAssetEntry = {
    ...next,
    // Governance fields carry forward from the verified head — the draft
    // never overwrites human-reviewed facts.
    owner: head.owner !== 'unknown' ? head.owner : next.owner,
    department: head.department !== 'unknown' ? head.department : next.department,
    contract_ref: head.contract_ref !== 'none' ? head.contract_ref : next.contract_ref,
    auth_method: head.auth_method !== 'unknown' ? head.auth_method : next.auth_method,
    mfa_status: head.mfa_status !== 'unknown' ? head.mfa_status : next.mfa_status,
    log_access: head.log_access !== 'unknown' ? head.log_access : next.log_access,
    account_admin: head.account_admin !== 'unknown' ? head.account_admin : next.account_admin,
    data_classification:
      head.data_classification !== 'unknown' ? head.data_classification : next.data_classification,
    review_status: head.review_status,
    last_verified: head.last_verified,
    endpoints: [...new Set([...head.endpoints, ...next.endpoints])],
    discovery_sources: [...new Set([...head.discovery_sources, ...next.discovery_sources])],
    check_results: mergeCheckResults(head.check_results, next.check_results),
  };
  return merged;
}

/**
 * Merge check results per check_id. When both sides carry a result, the one
 * with the LATER checked_at wins — an older checks file must never roll back
 * a fresher observation (no freshness regression). Undated < dated.
 */
function mergeCheckResults(
  head: SecurityCheckResult[] | undefined,
  next: SecurityCheckResult[] | undefined
): SecurityCheckResult[] | undefined {
  if (!head?.length && !next?.length) return next;
  const byId = new Map<string, SecurityCheckResult>();
  const wins = (a: SecurityCheckResult, b: SecurityCheckResult) =>
    (b.checked_at ?? '') > (a.checked_at ?? '') ? b : a;
  for (const r of head ?? []) byId.set(r.check_id, r);
  for (const r of next ?? []) {
    const prev = byId.get(r.check_id);
    byId.set(r.check_id, prev ? wins(prev, r) : r);
  }
  return [...byId.values()].sort((a, b) =>
    a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0
  );
}

/**
 * Check-result list equality — compares the full record including
 * checked_at/checker so that a fresher identical outcome still appends
 * (freshness refresh), while re-applying the same checks file is a no-op.
 */
function checkResultsEqual(
  a: SecurityCheckResult[] | undefined,
  b: SecurityCheckResult[] | undefined
): boolean {
  const canon = (list: SecurityCheckResult[] | undefined) =>
    JSON.stringify(
      (list ?? [])
        .map((c) => ({
          check_id: c.check_id,
          result: c.result,
          evidence: c.evidence ?? '',
          checked_at: c.checked_at ?? '',
          checker: c.checker ?? '',
        }))
        .sort((x, y) => (x.check_id < y.check_id ? -1 : x.check_id > y.check_id ? 1 : 0))
    );
  return canon(a) === canon(b);
}

function entryContentEqual(a: SecurityAssetEntry, b: SecurityAssetEntry): boolean {
  // Compare canonical shapes minus provenance churn (evidence array order may
  // legitimately differ between extraction runs) — but signal_rules DO count:
  // a newly-observed exposure signal is a real change worth recording.
  const canon = (e: SecurityAssetEntry) => {
    const { provenance, ...rest } = e;
    return {
      ...rest,
      signal_rules: [...(provenance?.signal_rules ?? [])].sort(),
      evidence: [...(provenance?.evidence ?? [])].sort(),
      unresolved_refs: [...(provenance?.unresolved_refs ?? [])].sort(),
    };
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Checks older than this need re-verification (Phase 6 cadence). */
export const CHECK_STALE_DAYS = 90;

/** 'done' (fresh), 'stale' (recorded but past the re-verification window), 'missing'. */
export type CheckStatus = 'done' | 'stale' | 'missing';

export function checkStatusFor(
  check: SecurityCheckResult | undefined,
  now: string = nowIso()
): CheckStatus {
  if (!check) return 'missing';
  const cutoff = new Date(
    new Date(now).getTime() - CHECK_STALE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  // An undated check is undatable — treat it as stale rather than fresh.
  // A future-dated check is evidence that has not happened yet — also stale.
  if (!check.checked_at || check.checked_at < cutoff || check.checked_at > now) return 'stale';
  return 'done';
}

/**
 * IPA unauthorized-access checklist obligations for a ledger entry.
 * Immediate-check items only (A-1..A-3, B-1..B-3, C-1); the ongoing programs
 * (PA/PB/PD) are separate continuous hygiene, not per-entry checks.
 */
export function requiredChecksFor(entry: SecurityAssetEntry): string[] {
  switch (entry.category) {
    case 'published-app':
      // External-facing applications: inventory + log anomaly + patch checks.
      return entry.exposure === 'public' ? ['A-1', 'A-2', 'A-3'] : ['A-1'];
    case 'saas':
    case 'cloud':
    case 'vpn':
    case 'api-integration':
      // External services: inventory + log anomaly + account audit.
      return ['B-1', 'B-2', 'B-3'];
    case 'data-store':
      // A public data store (leaked S3 bucket, public DB) is the primary IPA
      // leak vector — C-1 data inventory plus A-2 log-anomaly review.
      return entry.exposure === 'public' ? ['C-1', 'A-2'] : ['C-1'];
    case 'network-control':
      return ['B-2']; // the control layer's own log review
    case 'identity':
      return ['B-3']; // account inventory/audit
    default:
      return [];
  }
}

/**
 * Promote a ledger draft into the tenant registry. For every draft entry:
 *  - new service_id → append v1 (pending);
 *  - existing → merge: governance fields carry forward from the verified
 *    head; observation fields refresh; `verify_ids` promote to 'verified'.
 * Services present in the ledger but absent from the draft are reported in
 * `not_observed` — logical deletion is an explicit retire ceremony, never
 * implicit.
 */
export function promoteSecurityLedger(
  tenantSlug: string,
  draft: SecurityLedgerDraftLike,
  opts: PromoteOptions
): PromoteResult {
  if (!opts.promotedBy?.trim()) {
    throw new Error('[security-asset-ledger] promote requires promotedBy');
  }
  const ledgerFile = securityLedgerPath(tenantSlug, opts);
  const heads = latestPerAsset(readSecurityLedger(tenantSlug, opts));
  const verifySet = new Set(opts.verifyIds || []);
  const promotedAt = nowIso();
  const asOf = opts.asOf || promotedAt.slice(0, 10);
  const result: PromoteResult = {
    committed: false,
    ...(opts.dryRun ? { dry_run: true } : {}),
    ledger_path: ledgerFile,
    added: [],
    updated: [],
    unchanged: [],
    verified: [],
    not_observed: [],
    skipped_unknown_verify_ids: [],
    duplicate_draft_ids: [],
  };

  // Validate EVERY entry before appending ANY — a promotion is all-or-nothing;
  // a malformed entry mid-draft must not leave a partial registry update.
  const seen = new Set<string>();
  const deduped: SecurityAssetEntry[] = [];
  for (const entry of draft.entries) {
    assertSecurityEntry(entry);
    if (seen.has(entry.service_id)) {
      result.duplicate_draft_ids.push(entry.service_id);
      continue;
    }
    seen.add(entry.service_id);
    deduped.push(entry);
  }

  // Merge plan — computed fully before a single record is written.
  const plan: SecurityAssetRecord[] = [];
  const planKind = new Map<string, 'added' | 'updated'>();
  for (const entry of deduped) {
    // Human-provided governance overrides land on top of the draft's
    // observation — this is the write path for corrections.
    const next: SecurityAssetEntry = { ...entry, ...(opts.overrides || {}) };
    const assetId = deriveSecurityAssetId(entry.service_id);
    const head = heads.get(assetId);
    const reactivate = !!head && head.status === 'retired';

    let merged: SecurityAssetEntry;
    let version: number;
    let supersedes: string | undefined;
    if (!head) {
      merged = { ...next, review_status: 'pending', last_verified: 'unverified' };
      version = 1;
    } else if (reactivate) {
      // Re-activation continues the version chain — same logical asset.
      merged = { ...next, review_status: 'pending', last_verified: 'unverified' };
      version = head.version + 1;
      supersedes = `${head.asset_id}@v${head.version}`;
    } else {
      merged = mergeEntry(head.entry, next);
      version = head.version + 1;
      supersedes = `${head.asset_id}@v${head.version}`;
    }

    // Shadow derives from the final merged governance values — overrides and
    // carry-forward both count; never leave a stale true/false behind.
    merged.shadow = !(merged.owner !== 'unknown' && merged.contract_ref !== 'none');

    if (verifySet.has(entry.service_id)) {
      merged.review_status = 'verified';
      merged.last_verified = asOf;
      verifySet.delete(entry.service_id);
    }

    if (head && !reactivate && entryContentEqual(merged, head.entry)) {
      result.unchanged.push(entry.service_id);
      continue;
    }

    plan.push({
      asset_id: assetId,
      service_id: entry.service_id,
      entry: merged,
      promoted_at: promotedAt,
      promoted_by: opts.promotedBy,
      ...(opts.approvalId ? { approval_id: opts.approvalId } : {}),
      version,
      ...(supersedes ? { supersedes } : {}),
      status: 'active',
    });
    planKind.set(entry.service_id, !head || reactivate ? 'added' : 'updated');
  }

  for (const head of heads.values()) {
    if (!seen.has(head.service_id) && head.status === 'active') {
      result.not_observed.push(head.service_id);
    }
  }
  result.skipped_unknown_verify_ids = [...verifySet].sort();

  if (!opts.dryRun) {
    for (const record of plan) appendSecurityRecord(tenantSlug, record, opts);
  }
  for (const record of plan) {
    const kind = planKind.get(record.service_id)!;
    result[kind === 'added' ? 'added' : 'updated'].push(record.service_id);
    if (record.entry.review_status === 'verified') result.verified.push(record.service_id);
  }
  result.committed = !opts.dryRun && plan.length > 0;
  return result;
}

export interface RecordChecksResult {
  committed: boolean;
  ledger_path: string;
  applied: Array<{ service_id: string; version: number }>;
  /** Identical check outcome already on the head — nothing appended. */
  unchanged: string[];
  /** Checks for service_ids with no active record — reported, never created. */
  unknown_services: string[];
}

/**
 * Apply check outcomes (IPA checklist items, exposure probes, manual review
 * results) to existing ledger services. One new version per touched service,
 * preserving all other fields; the check history lives in the version chain.
 */
export function recordCheckResults(
  tenantSlug: string,
  checks: Array<{ service_id: string; check: SecurityCheckResult }>,
  opts: Omit<PromoteOptions, 'verifyIds' | 'asOf' | 'overrides'>
): RecordChecksResult {
  if (!opts.promotedBy?.trim()) {
    throw new Error('[security-asset-ledger] record-checks requires promotedBy');
  }
  const ledgerFile = securityLedgerPath(tenantSlug, opts);
  const result: RecordChecksResult = {
    committed: false,
    ledger_path: ledgerFile,
    applied: [],
    unchanged: [],
    unknown_services: [],
  };

  // Group by service: multiple checks for one service append one version.
  const byService = new Map<string, SecurityCheckResult[]>();
  for (const c of checks) {
    if (!c?.service_id || !c.check?.check_id || !c.check?.result) {
      throw new Error(
        '[security-asset-ledger] each check requires service_id, check.check_id, check.result'
      );
    }
    const list = byService.get(c.service_id) || [];
    // Stamp both honesty fields when absent: a check record without a
    // timestamp or a checker is weak evidence.
    list.push({
      ...c.check,
      checked_at: c.check.checked_at || nowIso(),
      checker: c.check.checker || opts.promotedBy,
    });
    byService.set(c.service_id, list);
  }

  const plan: SecurityAssetRecord[] = [];
  for (const [serviceId, newChecks] of byService) {
    const head = findServiceRecord(tenantSlug, serviceId, opts);
    if (!head || head.status !== 'active') {
      result.unknown_services.push(serviceId);
      continue;
    }
    const mergedChecks = mergeCheckResults(head.entry.check_results, newChecks);
    // Byte-identical re-application is a no-op; anything newer — a changed
    // outcome or a fresher checked_at — appends so freshness is preserved.
    if (checkResultsEqual(mergedChecks, head.entry.check_results)) {
      result.unchanged.push(serviceId);
      continue;
    }
    plan.push({
      asset_id: head.asset_id,
      service_id: head.service_id,
      entry: {
        ...head.entry,
        check_results: mergedChecks,
      },
      promoted_at: nowIso(),
      promoted_by: opts.promotedBy,
      ...(opts.approvalId ? { approval_id: opts.approvalId } : {}),
      version: head.version + 1,
      supersedes: `${head.asset_id}@v${head.version}`,
      status: 'active',
    });
  }
  for (const record of plan) {
    appendSecurityRecord(tenantSlug, record, opts);
    result.applied.push({ service_id: record.service_id, version: record.version });
  }
  result.committed = plan.length > 0;
  result.unknown_services.sort();
  return result;
}

/**
 * Governed logical deletion: appends a 'retired' record for the service.
 * Requires an explicit caller and records the ceremony.
 */
export function retireSecurityAsset(
  tenantSlug: string,
  serviceId: string,
  opts: Omit<PromoteOptions, 'verifyIds' | 'asOf'>
): SecurityAssetRecord {
  if (!opts.promotedBy?.trim()) {
    throw new Error('[security-asset-ledger] retire requires promotedBy');
  }
  const head = findServiceRecord(tenantSlug, serviceId, opts);
  if (!head || head.status !== 'active') {
    throw new Error(`[security-asset-ledger] no active record for ${serviceId}`);
  }
  return appendSecurityRecord(
    tenantSlug,
    {
      asset_id: head.asset_id,
      service_id: head.service_id,
      entry: head.entry,
      promoted_at: nowIso(),
      promoted_by: opts.promotedBy,
      ...(opts.approvalId ? { approval_id: opts.approvalId } : {}),
      version: head.version + 1,
      supersedes: `${head.asset_id}@v${head.version}`,
      status: 'retired',
      retired_at: nowIso(),
    },
    opts
  );
}
