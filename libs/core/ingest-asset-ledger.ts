/**
 * DA-05 Hybrid Sovereign Ledger — per-tenant information-asset ledger.
 *
 * Implements the "情報資産台帳" half of 案7 (Hybrid Sovereign Ledger,
 * knowledge/product/architecture/analysis-multi-tenant-governance-20260304.md):
 * every knowledge-card that enters knowledge/confidential/{tenant}/ through
 * the explicit ingest ceremony gets an append-only JSONL ledger record with
 * who / when / why / visible-to provenance, so lineage (source → transform
 * chain → approval) is reconstructible for any card. The auto-classifying
 * funnel (案6 Sovereign Funnel) stays rejected — nothing in this module
 * ingests anything by itself; it only records and queries.
 *
 * Ledger location: knowledge/confidential/{tenant}/_ledger/assets.jsonl
 * (derived via resolveTenant; `common` is the profile-less shared tenant at
 * knowledge/confidential/common). Append-only: a re-ingest (supersede) is a
 * NEW record with version+1 and a `supersedes` ref — history lines are never
 * rewritten. The stored `status` of an old line stays 'active'; the RESOLVED
 * status (everything but the highest version is superseded) is computed at
 * read time by assetLineage/listAssets, mirroring the KM-03 supersede-record
 * pattern of memory-promotion-queue.ts.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as pathResolver from './path-resolver.js';
import { resolveTenant, type TenantRegistryPathOptions } from './tenant-registry.js';
import { safeAppendFile, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

/** Shared (cross-tenant) confidential namespace — has no tenant profile. */
export const COMMON_TENANT_SLUG = 'common';

/** Ledger directory name under the tenant knowledge root. */
export const INGEST_LEDGER_DIRNAME = '_ledger';

export type IngestAssetStatus = 'active' | 'superseded';

/** One append-only ledger line (DA-05 record shape). */
export interface IngestAssetRecord {
  /** Stable id: 'ing-' + sha256(source_system + '::' + source_id)[0..16]. */
  asset_id: string;
  source_system: string;
  source_id: string;
  source_url?: string;
  source_version?: string;
  content_sha256: string;
  retrieved_at: string;
  ingested_at: string;
  /** Who performed the ingest ceremony (KYBERION_PERSONA / MISSION_ROLE). */
  ingested_by: string;
  approval_id?: string;
  /** DA-06: KM-03 steward approval that authorized a common/public landing. */
  steward_approval_id?: string;
  /** Tenant slugs allowed to see this asset. Default: [tenant slug]. */
  visible_to: string[];
  /** e.g. ['parse_document:docx', 'pii_scrub', 'normalize_card']. */
  transform_chain: string[];
  /** Repo-relative landing path of the knowledge card. */
  target_path: string;
  /** 1-based, increments per re-ingest of the same source. */
  version: number;
  /** Previous version ref ('{asset_id}@v{n}') or dedup-registry hash ref ('sha256:{hash}'). */
  supersedes?: string;
  status: IngestAssetStatus;
}

/** Path seam mirroring TenantRegistryPathOptions (hermetic tests pass a fixture rootDir/env). */
export type IngestLedgerPathOptions = TenantRegistryPathOptions;

function assertTenantSlug(slug: string): void {
  if (!TENANT_SLUG_RE.test(slug)) {
    throw new Error(`[ingest-asset-ledger] invalid tenant slug '${slug}'`);
  }
}

/** Deterministic asset id: re-ingesting the same source maps to the same asset. */
export function deriveAssetId(sourceSystem: string, sourceId: string): string {
  const system = String(sourceSystem || '').trim();
  const id = String(sourceId || '').trim();
  if (!system || !id) {
    throw new Error('[ingest-asset-ledger] source_system and source_id are required');
  }
  return `ing-${createHash('sha256').update(`${system}::${id}`).digest('hex').slice(0, 16)}`;
}

/** Provenance ref for KKP provenance[] entries (DA-05 KKP connection). */
export function assetProvenanceRef(
  record: Pick<IngestAssetRecord, 'asset_id' | 'version'>
): string {
  return `asset:${record.asset_id}@v${record.version}`;
}

/**
 * Repo-relative knowledge root for a tenant. `common` is the profile-less
 * shared confidential namespace; every other slug must be registered
 * (resolveTenant throws otherwise — fail-closed, DA-01).
 */
export function tenantIngestKnowledgeRoot(
  tenantSlug: string,
  options: IngestLedgerPathOptions = {}
): string {
  assertTenantSlug(tenantSlug);
  if (tenantSlug === COMMON_TENANT_SLUG) return `knowledge/confidential/${COMMON_TENANT_SLUG}`;
  return resolveTenant(tenantSlug, options).knowledge_root;
}

/** Absolute path of the tenant's assets.jsonl ledger. */
export function assetLedgerPath(tenantSlug: string, options: IngestLedgerPathOptions = {}): string {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const knowledgeRoot = tenantIngestKnowledgeRoot(tenantSlug, options);
  return path.join(rootDir, knowledgeRoot, INGEST_LEDGER_DIRNAME, 'assets.jsonl');
}

function assertAssetRecord(record: IngestAssetRecord): void {
  const problems: string[] = [];
  if (!record || typeof record !== 'object') {
    throw new Error('[ingest-asset-ledger] record must be an object');
  }
  if (typeof record.asset_id !== 'string' || !record.asset_id.startsWith('ing-')) {
    problems.push('asset_id must be an ing-* id');
  }
  if (!String(record.source_system || '').trim()) problems.push('source_system is required');
  if (!String(record.source_id || '').trim()) problems.push('source_id is required');
  if (!SHA256_RE.test(String(record.content_sha256 || ''))) {
    problems.push('content_sha256 must be a sha256 hex digest');
  }
  if (!String(record.retrieved_at || '').trim()) problems.push('retrieved_at is required');
  if (!String(record.ingested_at || '').trim()) problems.push('ingested_at is required');
  if (!String(record.ingested_by || '').trim()) problems.push('ingested_by is required');
  if (!Array.isArray(record.visible_to) || record.visible_to.length === 0) {
    problems.push('visible_to must be a non-empty array');
  }
  if (!Array.isArray(record.transform_chain) || record.transform_chain.length === 0) {
    problems.push('transform_chain must be a non-empty array');
  }
  if (!String(record.target_path || '').trim()) problems.push('target_path is required');
  if (!Number.isInteger(record.version) || record.version < 1) {
    problems.push('version must be a positive integer');
  }
  if (record.status !== 'active' && record.status !== 'superseded') {
    problems.push("status must be 'active' or 'superseded'");
  }
  if (problems.length > 0) {
    throw new Error(
      `[ingest-asset-ledger] invalid asset record (nothing appended): ${problems.join('; ')}`
    );
  }
  const expectedAssetId = deriveAssetId(record.source_system, record.source_id);
  if (record.asset_id !== expectedAssetId) {
    throw new Error(
      `[ingest-asset-ledger] asset_id '${record.asset_id}' does not match ` +
        `deriveAssetId('${record.source_system}', '${record.source_id}') = '${expectedAssetId}'`
    );
  }
}

/**
 * Reads every ledger line in append order. Corrupt lines are skipped (the
 * ledger is append-only evidence — one bad line must not block ingestion),
 * mirroring the ingest dedup registry reader.
 */
export function readAssetLedger(
  tenantSlug: string,
  options: IngestLedgerPathOptions = {}
): IngestAssetRecord[] {
  const ledgerFile = assetLedgerPath(tenantSlug, options);
  if (!safeExistsSync(ledgerFile)) return [];
  const raw = String(safeReadFile(ledgerFile, { encoding: 'utf8' }) || '');
  const records: IngestAssetRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as IngestAssetRecord;
      if (record && typeof record.asset_id === 'string') records.push(record);
    } catch {
      /* skip corrupt line */
    }
  }
  return records;
}

/**
 * Appends one validated record. Append-only by construction: there is no
 * update/delete API in this module — a supersede is a new record.
 */
export function appendAssetRecord(
  tenantSlug: string,
  record: IngestAssetRecord,
  options: IngestLedgerPathOptions = {}
): IngestAssetRecord {
  assertTenantSlug(tenantSlug);
  assertAssetRecord(record);
  const ledgerFile = assetLedgerPath(tenantSlug, options);
  safeMkdir(path.dirname(ledgerFile), { recursive: true });
  safeAppendFile(ledgerFile, `${JSON.stringify(record)}\n`);
  return record;
}

function latestPerAsset(records: IngestAssetRecord[]): Map<string, IngestAssetRecord> {
  const latest = new Map<string, IngestAssetRecord>();
  for (const record of records) {
    const current = latest.get(record.asset_id);
    if (!current || record.version > current.version) latest.set(record.asset_id, record);
  }
  return latest;
}

/** Latest ledger record for a source (highest version), or null. */
export function findAssetBySource(
  tenantSlug: string,
  sourceSystem: string,
  sourceId: string,
  options: IngestLedgerPathOptions = {}
): IngestAssetRecord | null {
  const assetId = deriveAssetId(sourceSystem, sourceId);
  const records = readAssetLedger(tenantSlug, options).filter(
    (record) => record.asset_id === assetId
  );
  if (records.length === 0) return null;
  return records.reduce((best, record) => (record.version > best.version ? record : best));
}

/** Latest ledger record whose content_sha256 matches, or null. */
export function findAssetByContentHash(
  tenantSlug: string,
  contentSha256: string,
  options: IngestLedgerPathOptions = {}
): IngestAssetRecord | null {
  const hash = String(contentSha256 || '').trim();
  if (!SHA256_RE.test(hash)) return null;
  const matches = readAssetLedger(tenantSlug, options).filter(
    (record) => record.content_sha256 === hash
  );
  if (matches.length === 0) return null;
  return matches[matches.length - 1];
}

/**
 * Latest record per asset with the RESOLVED status view: an asset whose
 * stored latest line says 'active' stays active; older versions are never
 * returned here. Codepoint-sorted by asset_id (deterministic across
 * platforms — no localeCompare).
 */
export function listAssets(
  tenantSlug: string,
  options: IngestLedgerPathOptions = {}
): IngestAssetRecord[] {
  return [...latestPerAsset(readAssetLedger(tenantSlug, options)).values()].sort((left, right) =>
    left.asset_id < right.asset_id ? -1 : left.asset_id > right.asset_id ? 1 : 0
  );
}

/**
 * Full version chain of one asset, sorted by version ascending, with the
 * RESOLVED status: every record except the highest version is reported as
 * 'superseded' (the stored line keeps whatever status it was appended with —
 * history is never rewritten). This is how "台帳から任意カードの lineage
 * (源泉→変換列→承認) が復元できる" is answered: each returned record carries
 * source_*, transform_chain, approval_id and supersedes.
 */
export function assetLineage(
  tenantSlug: string,
  assetId: string,
  options: IngestLedgerPathOptions = {}
): IngestAssetRecord[] {
  const chain = readAssetLedger(tenantSlug, options)
    .filter((record) => record.asset_id === assetId)
    .sort((left, right) => left.version - right.version);
  if (chain.length === 0) return [];
  const maxVersion = chain[chain.length - 1].version;
  return chain.map((record) =>
    record.version === maxVersion ? record : { ...record, status: 'superseded' as const }
  );
}

/** One current-source observation supplied by the caller for staleness comparison. */
export interface IngestSourceObservation {
  source_system: string;
  source_id: string;
  source_version?: string;
  content_sha256?: string;
}

export interface IngestStalenessEntry {
  asset_id: string;
  source_system: string;
  source_id: string;
  target_path: string;
  version: number;
  ledger_content_sha256: string;
  ledger_source_version?: string;
  current_content_sha256?: string;
  current_source_version?: string;
  reason: 'content_hash_mismatch' | 'source_version_mismatch';
}

export interface IngestStalenessReport {
  tenant_slug: string;
  /** Active (latest-version) assets, codepoint-sorted by asset_id. */
  assets: IngestAssetRecord[];
  /** Assets whose supplied current source differs from the ledger. Empty when no observations given. */
  stale: IngestStalenessEntry[];
}

/**
 * DA-05 陳腐化検出 — deterministic and side-effect free. Given the current
 * state of the sources (as observed by the caller), lists every active asset
 * whose ledger content_sha256 / source_version no longer matches. With no
 * observations it just dumps the active assets for external comparison.
 */
export function stalenessReport(
  tenantSlug: string,
  currentSources: IngestSourceObservation[] = [],
  options: IngestLedgerPathOptions = {}
): IngestStalenessReport {
  const assets = listAssets(tenantSlug, options);
  const stale: IngestStalenessEntry[] = [];
  for (const asset of assets) {
    const observed = currentSources.find(
      (source) =>
        String(source.source_system || '') === asset.source_system &&
        String(source.source_id || '') === asset.source_id
    );
    if (!observed) continue;
    const observedHash = String(observed.content_sha256 || '').trim();
    const observedVersion = String(observed.source_version || '').trim();
    let reason: IngestStalenessEntry['reason'] | null = null;
    if (observedHash && observedHash !== asset.content_sha256) {
      reason = 'content_hash_mismatch';
    } else if (
      observedVersion &&
      asset.source_version !== undefined &&
      observedVersion !== asset.source_version
    ) {
      reason = 'source_version_mismatch';
    }
    if (!reason) continue;
    stale.push({
      asset_id: asset.asset_id,
      source_system: asset.source_system,
      source_id: asset.source_id,
      target_path: asset.target_path,
      version: asset.version,
      ledger_content_sha256: asset.content_sha256,
      ...(asset.source_version !== undefined
        ? { ledger_source_version: asset.source_version }
        : {}),
      ...(observedHash ? { current_content_sha256: observedHash } : {}),
      ...(observedVersion ? { current_source_version: observedVersion } : {}),
      reason,
    });
  }
  return { tenant_slug: tenantSlug, assets, stale };
}
