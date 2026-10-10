import * as path from 'node:path';
import { isRecord, parseSafeJsonInput } from '@agent/core/foundation';
import {
  assetProvenanceRef,
  deriveAssetId,
  normalizeIngestAssetRecord,
} from '@agent/core/ingest-asset-ledger';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';

export interface IngestCliVerdict {
  outcome: 'would_commit' | 'committed' | 'duplicate';
  target_path: string;
}

const PREVIEW_MARKER = '[ingest] DRY RUN — no card written, no ledger record appended';
const DUPLICATE_MARKER = '[ingest] NOT committed (duplicate) — the ledger is unchanged';
const INGESTED_BY = 'sovereign_concierge:web';

function isTenantTarget(value: unknown, tenant: string): value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return false;
  const segments = value.split(/[\\/]/u);
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    segments.some((part) => !part || part === '.' || part === '..')
  )
    return false;
  // Custom knowledge roots and prior version paths may be nested within this tenant.
  const prefix = `knowledge/confidential/${tenant}/`;
  if (!segments.join('/').startsWith(prefix) || segments.join('/').length <= prefix.length)
    return false;
  try {
    assertSafeRepositoryPath(value, { allowMissingLeaf: true });
    return true;
  } catch {
    return false;
  }
}

/** A successful process exit or a human-readable marker alone is never a receipt. */
export function parseIngestCliVerdict(
  stdout: string,
  expected: { dryRun: boolean; tenant: string; sourceId: string }
): IngestCliVerdict | null {
  const markers = [
    ...stdout.matchAll(/^\[ingest\] (?:DRY RUN\b|committed |NOT committed\b)[^\r\n]*(?:\r?\n|$)/gm),
  ];
  if (markers.length !== 1) return null;
  const match = markers[0];
  const marker = match[0].trimEnd();
  let payload = stdout.slice(match.index + match[0].length).trim();
  if (marker === PREVIEW_MARKER && payload.startsWith('[ingest] no --target given: ')) {
    const newline = payload.indexOf('\n');
    if (newline < 0) return null;
    payload = payload.slice(newline + 1).trim();
  }
  try {
    const receipt: unknown = parseSafeJsonInput(payload, 'ingest CLI verdict');
    if (!isRecord(receipt) || !isTenantTarget(receipt.target_path, expected.tenant)) return null;
    if (expected.dryRun) {
      if (
        marker !== PREVIEW_MARKER ||
        receipt.dry_run !== true ||
        typeof receipt.would_commit !== 'boolean' ||
        Object.hasOwn(receipt, 'committed') ||
        receipt.tenant_slug !== expected.tenant ||
        receipt.asset_id !== deriveAssetId('concierge-upload', expected.sourceId) ||
        receipt.ingested_by !== INGESTED_BY ||
        typeof receipt.content_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/iu.test(receipt.content_sha256)
      )
        return null;
      return {
        outcome: receipt.would_commit ? 'would_commit' : 'duplicate',
        target_path: receipt.target_path,
      };
    }
    if (Object.hasOwn(receipt, 'dry_run') || Object.hasOwn(receipt, 'would_commit')) return null;
    if (marker === DUPLICATE_MARKER) {
      if (receipt.committed !== false || receipt.reason !== 'duplicate') return null;
      // Exact content may match a different source. The CLI does not promise an existing row.
      return { outcome: 'duplicate', target_path: receipt.target_path };
    }
    if (Object.hasOwn(receipt, 'committed')) return null;
    const asset = normalizeIngestAssetRecord(receipt);
    if (
      !asset ||
      asset.status !== 'active' ||
      asset.source_system !== 'concierge-upload' ||
      asset.source_id !== expected.sourceId ||
      asset.ingested_by !== INGESTED_BY ||
      asset.visible_to.length !== 1 ||
      asset.visible_to[0] !== expected.tenant ||
      marker !== `[ingest] committed ${assetProvenanceRef(asset)} → ${asset.target_path}`
    )
      return null;
    return { outcome: 'committed', target_path: asset.target_path };
  } catch {
    return null;
  }
}
