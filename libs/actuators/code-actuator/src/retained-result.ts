/**
 * Retained references for oversized op results: results above the inline
 * budget are persisted to the cache floor and replaced by a retained
 * reference + preview (REA retained-evidence shape), so oversized captures
 * cannot bloat pipeline context. Consumers page the full payload back with
 * read_file on result_ref.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '@agent/core/core';
import { safeWriteFile } from '@agent/core/secure-io';
import {
  resolveStorageFloor,
  storageFloorRelativePath,
  SYSTEM_PARTITION,
} from '@agent/core/storage-layout';

const RETAINED_RESULT_INLINE_LIMIT = 64 * 1024;
const RETAINED_PREVIEW_ITEMS = 50;

function buildPreview(value: unknown, serialized: string): unknown {
  if (Array.isArray(value)) return value.slice(0, RETAINED_PREVIEW_ITEMS);
  if (typeof value !== 'object' || value === null) return serialized.slice(0, 4096);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.results)) return serialized.slice(0, 4096);
  const preview: Record<string, unknown> = {
    ...record,
    results: record.results.slice(0, RETAINED_PREVIEW_ITEMS),
  };
  if (Array.isArray(record.errors)) {
    preview.errors = record.errors.slice(0, RETAINED_PREVIEW_ITEMS);
  }
  const paths = record.paths;
  if (typeof paths === 'object' && paths !== null) {
    const scanned = (paths as Record<string, unknown>).scanned;
    preview.paths = { scanned: Array.isArray(scanned) ? scanned.length : scanned };
  }
  return preview;
}

export function retainOversizedResult(value: unknown, domain: string): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= RETAINED_RESULT_INLINE_LIMIT) return value;
  const fileName = `${randomUUID()}.json`;
  try {
    safeWriteFile(resolveStorageFloor('cache', SYSTEM_PARTITION, domain, fileName), serialized);
  } catch (error) {
    // A retention failure must not fail the capture — return the payload
    // inline with the limitation noted rather than losing the result.
    logger.warn(
      `[CODE_RETAIN_FAILED] could not persist oversized result — returning inline: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return value;
  }
  return {
    retained: true,
    result_ref: storageFloorRelativePath('cache', SYSTEM_PARTITION, domain, fileName),
    total_bytes: serialized.length,
    ...(Array.isArray(value) ? { item_count: value.length } : {}),
    preview: buildPreview(value, serialized),
    next_step: 'read the result_ref file for the full payload',
  };
}
