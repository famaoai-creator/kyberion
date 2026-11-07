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
 * store's inter-process lock lives in; the guard narrows every write and mkdir
 * to the role's `narrow` declaration in security-policy.json
 * (authority_role_permissions.deliverable_inbox_writer.narrow, G3): the inbox
 * entries file, its directory, and the inbox's own lock files, with the
 * entries file content-checked append-only. No other `active/shared/runtime/`
 * path.
 */
export const DELIVERABLE_INBOX_WRITER_ROLE = 'deliverable_inbox_writer';

/** The repo-relative inbox entries file (content-checked for the writer role). */
export const DELIVERABLE_INBOX_ENTRIES_PATH = 'active/shared/inbox/entries.jsonl';
