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
