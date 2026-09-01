/**
 * DA-04 ingest:dedup — content-hash registry check + registration.
 *
 * Exact content_sha256 matches are duplicates (nothing is re-registered).
 * A record with the same source_system/source_id but a DIFFERENT hash is
 * NOT a duplicate — it is an update: the op reports it as
 * supersedes_candidate so DA-05's ingest:commit can turn it into a
 * supersede instead of a new card.
 *
 * Registry: JSONL, one first-seen record per content hash, at
 * active/shared/runtime/ingest/content-hash-registry.jsonl by default
 * (registry_path overridable for hermetic tests).
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
} from '@agent/core/secure-io';
import { appendJsonLine, isRecord, parseSafeJsonInput } from '@agent/core/foundation';

export const DEFAULT_INGEST_REGISTRY_PATH =
  'active/shared/runtime/ingest/content-hash-registry.jsonl';

export interface IngestRegistryRecord {
  content_sha256: string;
  source_system?: string;
  source_id?: string;
  first_seen: string;
  target_path?: string;
}

export interface DedupInput {
  content_sha256: string;
  source_system?: string;
  source_id?: string;
  /** Repo-relative or absolute JSONL path; defaults to the shared runtime registry. */
  registry_path?: string;
  /** Recorded on registration so DA-05 can trace where the hash landed. */
  target_path?: string;
  /** Set false for a check-only pass (no registration). Default true. */
  register?: boolean;
  /** Explicit first_seen timestamp (golden-test determinism). Default: wall clock. */
  now?: string;
}

export interface DedupResult {
  duplicate: boolean;
  existing?: IngestRegistryRecord;
  supersedes_candidate?: IngestRegistryRecord;
  registered: boolean;
}

function resolveRegistryPath(registryPath?: string): string {
  const candidate = registryPath?.trim() || DEFAULT_INGEST_REGISTRY_PATH;
  return assertSafeRepositoryPath(
    path.isAbsolute(candidate) ? candidate : pathResolver.rootResolve(candidate),
    { allowMissingLeaf: true }
  );
}

function assertTargetPath(targetPath: string | undefined): void {
  if (targetPath === undefined) return;
  if (path.isAbsolute(targetPath)) {
    throw new Error('ingest:dedup — target_path must be repository-relative');
  }
  assertSafeRepositoryPath(pathResolver.rootResolve(targetPath), { allowMissingLeaf: true });
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
}

/** Validate a registry row before it participates in duplicate detection. */
export function parseIngestRegistryRecord(value: unknown): IngestRegistryRecord | undefined {
  if (!isRecord(value) || !isSha256(value.content_sha256)) return undefined;
  if (typeof value.first_seen !== 'string' || !Number.isFinite(Date.parse(value.first_seen))) {
    return undefined;
  }
  for (const key of ['source_system', 'source_id', 'target_path'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) {
      return undefined;
    }
  }
  return value as unknown as IngestRegistryRecord;
}

function readRegistry(absPath: string): IngestRegistryRecord[] {
  if (!safeExistsSync(absPath)) return [];
  if (!safeLstat(absPath).isFile()) {
    throw new Error(`ingest:dedup — registry_path must be a regular file: ${absPath}`);
  }
  const raw = String(safeReadFile(absPath, { encoding: 'utf8' }) || '');
  const records: IngestRegistryRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = parseIngestRegistryRecord(
        parseSafeJsonInput(trimmed, 'ingest dedup registry entry')
      );
      if (record) records.push(record);
    } catch {
      // Corrupt line: skip rather than block ingestion — the registry is
      // append-only evidence, not the source of truth for card content.
    }
  }
  return records;
}

export function dedupContent(input: DedupInput): DedupResult {
  if (!isSha256(input?.content_sha256)) {
    throw new Error('ingest:dedup — content_sha256 is required');
  }
  assertTargetPath(input.target_path);
  const absPath = resolveRegistryPath(input.registry_path);
  const records = readRegistry(absPath);

  const existing = records.find((record) => record.content_sha256 === input.content_sha256);
  if (existing) {
    return { duplicate: true, existing, registered: false };
  }

  // Same source, different hash → update, not duplicate (DA-05 supersede).
  const supersedesCandidate =
    input.source_id !== undefined
      ? records.find(
          (record) =>
            record.source_id === input.source_id &&
            (record.source_system ?? '') === (input.source_system ?? '') &&
            record.content_sha256 !== input.content_sha256
        )
      : undefined;

  let registered = false;
  if (input.register !== false) {
    const record: IngestRegistryRecord = {
      content_sha256: input.content_sha256,
      ...(input.source_system !== undefined ? { source_system: input.source_system } : {}),
      ...(input.source_id !== undefined ? { source_id: input.source_id } : {}),
      first_seen: input.now ?? new Date().toISOString(),
      ...(input.target_path !== undefined ? { target_path: input.target_path } : {}),
    };
    safeMkdir(path.dirname(absPath), { recursive: true });
    appendJsonLine(absPath, record);
    registered = true;
  }

  return {
    duplicate: false,
    ...(supersedesCandidate ? { supersedes_candidate: supersedesCandidate } : {}),
    registered,
  };
}
