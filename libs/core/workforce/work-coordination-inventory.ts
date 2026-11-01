/** Read-only WorkItem inventory validation and unchanged latest-record folding. */
import { parkedCompactionCopies, streamJsonLinesAcrossCompaction } from '../jsonl-parked-read.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { validateWorkItem } from './work-coordination-identity.js';
import type { WorkItem } from './work-coordination-types.js';

export function latestById<T extends object>(records: T[], key: keyof T): T[] {
  const index = new Map<string, T>();
  for (const record of records) {
    const value = record[key];
    if (typeof value === 'string' && value) {
      index.set(value, record);
    }
  }
  return Array.from(index.values());
}

/** Validate before folding so malformed rows cannot disappear; missing is not verified empty. */
export function readWorkItemInventoryAtPath(logicalPath: string): {
  present: boolean;
  items: WorkItem[];
} {
  const file = assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true });
  // A store parked by a concurrent compaction is present: read its copies.
  if (!safeExistsSync(file) && parkedCompactionCopies(file).length === 0) {
    return { present: false, items: [] };
  }
  // Streamed (size never fails the read); strict: a malformed row still throws.
  const records = Array.from(streamJsonLinesAcrossCompaction<WorkItem>(file));
  for (const record of records) validateWorkItem(record);
  return { present: true, items: latestById(records, 'item_id') };
}
