import * as path from 'node:path';
import type { ResourceAccessOperation } from './resource-access-scope.js';
import { RUNTIME_LOCK_ROOT_PATH } from './runtime-state-roots.js';

/**
 * Narrow writer role of the deliverable inbox (`active/shared/inbox/`,
 * libs/core/deliverable-inbox.ts `addInboxEntry`). libs/core assumes it to add
 * an operator task to the inbox on behalf of a caller that has no inbox grant
 * (a customer-triggered respond in the customer room's facade, the reminder
 * sweep of a tenant pipeline): the CD-10 bolt rejection
 * (libs/core/mission/mission-bolt-review.ts) and the CD-11 hand-off / manual
 * reminder tasks (libs/core/customer-decision/operator-handoff.ts).
 *
 * Its policy grant is the inbox plus the shared lock directory the inbox
 * store's inter-process lock lives in; the guard (tier-guard) narrows every
 * write and mkdir to {@link deliverableInboxWriterPathAllowed}: the inbox
 * entries file, its directory, and the inbox's own lock files. No other
 * `active/shared/runtime/` path.
 */
export const DELIVERABLE_INBOX_WRITER_ROLE = 'deliverable_inbox_writer';

const INBOX_DIR = 'active/shared/inbox';
const INBOX_FILE = `${INBOX_DIR}/entries.jsonl`;
const LOCK_DIR = RUNTIME_LOCK_ROOT_PATH;
/** The inbox lock (`deliverable-inbox-<sha256>`) and its reclaim / tomb siblings. */
const INBOX_LOCK = /^deliverable-inbox-[a-f0-9]{64}\.lock(?:[.A-Za-z0-9_-]{0,160})$/u;

/**
 * May the inbox writer role write / create this repo-relative path? Reads
 * stay with the role's policy grant (the inbox and the lock directory).
 */
export function deliverableInboxWriterPathAllowed(
  relativePath: string,
  operation: ResourceAccessOperation
): boolean {
  if (operation === 'read' || operation === 'metadata') return true;
  if (path.posix.normalize(relativePath) !== relativePath) return false;
  if (operation === 'mkdir')
    return [INBOX_DIR, path.posix.dirname(LOCK_DIR), LOCK_DIR].includes(relativePath);
  if (relativePath === INBOX_FILE) return true;
  return (
    path.posix.dirname(relativePath) === LOCK_DIR &&
    INBOX_LOCK.test(path.posix.basename(relativePath))
  );
}

/** The repo-relative inbox entries file (content-checked for the writer role). */
export const DELIVERABLE_INBOX_ENTRIES_PATH = INBOX_FILE;

const lines = (text: string) => text.split('\n').filter((line) => line.trim().length > 0);

/**
 * The guard-side content rule of an inbox writer write of the entries file:
 * the inbox is shared by every tenant, so the role may only append. Every
 * existing line stays byte-identical and in place; each new line is a JSON
 * object with a new string `entry_id` (the store validates it against the
 * entry schema before writing). Returns the refusal reason, or null.
 */
export function deliverableInboxWriteProblem(
  previous: string | undefined,
  next: string
): string | null {
  const refused = (why: string) => `[DELIVERABLE_INBOX_WRITE_REFUSED] ${why}`;
  const before = lines(previous ?? '');
  const after = lines(next);
  if (after.length < before.length || before.some((line, index) => after[index] !== line))
    return refused('the inbox writer may only append entries');
  const ids = new Set<string>();
  for (const line of before) {
    try {
      const id = (JSON.parse(line) as { entry_id?: unknown }).entry_id;
      if (typeof id === 'string') ids.add(id);
    } catch {
      // An unreadable existing line stays as it is.
    }
  }
  for (const line of after.slice(before.length)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return refused('a new inbox entry is not JSON');
    }
    const id = (entry as { entry_id?: unknown } | null)?.entry_id;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof id !== 'string')
      return refused('a new inbox entry needs an entry_id');
    if (ids.has(id)) return refused('a new inbox entry may not reuse an entry_id');
    ids.add(id);
  }
  return null;
}
