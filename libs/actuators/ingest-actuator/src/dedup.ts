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
 *
 * The registry is full history by design (dedupe needs every hash ever seen):
 * it is never windowed or compacted. Lookups stream it forward with an early
 * exit, so its size never makes a check fail, and check→register runs under
 * a per-registry lock so two concurrent ingests of the same content cannot
 * both register it.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
} from '@agent/core/secure-io';
import { appendJsonLine, isRecord, nowIso } from '@agent/core/foundation';
import { fileEndsWithNewline, streamJsonLines } from '@agent/core/jsonl-read';
import { withLockSync } from '@agent/core/lock-utils';

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

export interface IngestRegistryLookup {
  /** First registered record with the same content hash. */
  existing?: IngestRegistryRecord;
  /** First record with the same source and a different hash (DA-05 supersede). */
  supersedesCandidate?: IngestRegistryRecord;
}

/**
 * One forward streaming pass (constant memory). Stops at the first exact hash
 * match — a duplicate needs nothing after it; otherwise the whole registry is
 * scanned for the first same-source/different-hash record.
 */
export function lookupIngestRegistry(
  absPath: string,
  input: Pick<DedupInput, 'content_sha256' | 'source_system' | 'source_id'>,
  options: { chunkBytes?: number } = {}
): IngestRegistryLookup {
  if (!safeExistsSync(absPath)) return {};
  if (!safeLstat(absPath).isFile()) {
    throw new Error(`ingest:dedup — registry_path must be a regular file: ${absPath}`);
  }
  let supersedesCandidate: IngestRegistryRecord | undefined;
  for (const value of streamJsonLines<unknown>(absPath, {
    onMalformed: 'skip',
    ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
  })) {
    const record = parseIngestRegistryRecord(value);
    if (!record) continue;
    if (record.content_sha256 === input.content_sha256) return { existing: record };
    if (
      !supersedesCandidate &&
      input.source_id !== undefined &&
      record.source_id === input.source_id &&
      (record.source_system ?? '') === (input.source_system ?? '')
    ) {
      supersedesCandidate = record;
    }
  }
  return supersedesCandidate ? { supersedesCandidate } : {};
}

function registryLockId(absPath: string): string {
  return `ingest-content-hash-registry-${createHash('sha256').update(absPath).digest('hex').slice(0, 32)}`;
}

export function dedupContent(input: DedupInput): DedupResult {
  if (!isSha256(input?.content_sha256)) {
    throw new Error('ingest:dedup — content_sha256 is required');
  }
  assertTargetPath(input.target_path);
  const absPath = resolveRegistryPath(input.registry_path);
  if (input.register === false) return checkAndRegister(absPath, input);
  return withLockSync(registryLockId(absPath), () => checkAndRegister(absPath, input));
}

function checkAndRegister(absPath: string, input: DedupInput): DedupResult {
  const { existing, supersedesCandidate } = lookupIngestRegistry(absPath, input);
  if (existing) {
    return { duplicate: true, existing, registered: false };
  }

  let registered = false;
  if (input.register !== false) {
    const record: IngestRegistryRecord = {
      content_sha256: input.content_sha256,
      ...(input.source_system !== undefined ? { source_system: input.source_system } : {}),
      ...(input.source_id !== undefined ? { source_id: input.source_id } : {}),
      first_seen: input.now ?? nowIso(),
      ...(input.target_path !== undefined ? { target_path: input.target_path } : {}),
    };
    safeMkdir(path.dirname(absPath), { recursive: true });
    // A torn tail (writer died mid-append) would swallow this record into one
    // unparseable line; start it on its own line instead.
    appendJsonLine(absPath, record, { leadingNewline: !fileEndsWithNewline(absPath) });
    registered = true;
  }

  return {
    duplicate: false,
    ...(supersedesCandidate ? { supersedes_candidate: supersedesCandidate } : {}),
    registered,
  };
}
