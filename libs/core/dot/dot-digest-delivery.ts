import { dotStatePath } from './dot-state-paths.js';
/** Durable digest admission, bounded catch-up and safe notification retry. */
import * as path from 'node:path';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { safeMkdir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { matchesCron } from '../pipeline/cron-utils.js';
import type { OperatorNotificationReceipt } from '../surface/operator-notifications.js';
import type { DotCharter } from './dot-charter.js';
import { dotAdmissionScopeHash, withDotAdmissionLock } from './dot-admission-identity.js';

export const DOT_DIGEST_LEDGER_PATH = 'active/shared/runtime/dot-digest-ledger.jsonl';
export const DOT_DIGEST_CATCHUP_MS = 24 * 60 * 60 * 1000;
export const DOT_DIGEST_MAX_ATTEMPTS = 6;
export const DOT_DIGEST_RETRY_MS = 10 * 60 * 1000;
interface DigestRow {
  dot_id: string;
  key: string;
  scope_hash?: string;
  sent_at: string;
  delivered: boolean;
  status?: 'pending' | 'accepted' | 'suppressed' | 'uncertain' | 'exhausted';
  scheduled_at?: string;
  content_at?: string;
  attempts?: number;
  next_attempt_at?: string;
  text?: string;
  reason?: string;
}
export interface DigestDeliveryDeps {
  rootDir?: string;
  now?: () => Date;
  compose: (since: Date | undefined) => string;
  notify: (text: string, key: string) => OperatorNotificationReceipt;
}
export function sendDueDotDigest(
  charter: DotCharter,
  timezone: string | undefined,
  deps: DigestDeliveryDeps
): boolean {
  const cron = charter.notification.digest_cron;
  if (!cron) return false;
  return withDotAdmissionLock(charter, deps.rootDir, () => {
    const now = deps.now?.() ?? new Date();
    const scope = dotAdmissionScopeHash(charter);
    const file = path.join(
      deps.rootDir ?? pathResolver.rootDir(),
      dotStatePath(charter, 'digest-ledger.jsonl')
    );
    const legacyFile = path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_DIGEST_LEDGER_PATH);
    const legacy = readJsonLines<DigestRow>(legacyFile, { onMalformed: 'skip' })
      .filter((row) =>
        Boolean(row && typeof row.dot_id === 'string' && typeof row.key === 'string' && !row.status)
      )
      .map<DigestRow>((row) => ({
        dot_id: row.dot_id,
        key: row.key,
        sent_at: row.sent_at,
        delivered: row.delivered,
      }));
    const all = [...legacy, ...readJsonLines<DigestRow>(file, { onMalformed: 'skip' })].filter(
      (row) => row?.dot_id === charter.dot_id && (!row.scope_hash || row.scope_hash === scope)
    );
    const latest = new Map(all.map((row) => [row.key, row]));
    const append = (row: DigestRow): DigestRow => {
      safeMkdir(path.dirname(file), { recursive: true });
      appendJsonLine(file, row);
      latest.set(row.key, row);
      return row;
    };
    // Legacy false receipts cannot prove non-delivery. Preserve them rather than blindly replaying effects.
    for (const row of latest.values()) {
      if (
        row.status === 'pending' &&
        (now.getTime() - Date.parse(row.scheduled_at ?? row.sent_at) >= DOT_DIGEST_CATCHUP_MS ||
          (row.attempts ?? 0) >= DOT_DIGEST_MAX_ATTEMPTS)
      )
        append({ ...row, status: 'exhausted', reason: 'retry_budget_exhausted' });
    }
    let pending = [...latest.values()].find(
      (row) =>
        row.status === 'pending' && Date.parse(row.next_attempt_at ?? row.sent_at) <= now.getTime()
    );
    if (!pending) {
      // At most the newest due minute is admitted, including first boot after downtime.
      const minute = Math.floor(now.getTime() / 60000) * 60000;
      let scheduled: Date | undefined;
      for (let at = minute; at > now.getTime() - DOT_DIGEST_CATCHUP_MS; at -= 60000) {
        const date = new Date(at);
        if (matchesCron(cron, date, timezone)) {
          scheduled = date;
          break;
        }
      }
      if (!scheduled) return false;
      const key = [scope, cron, timezone ?? 'local', scheduled.toISOString()].join('@');
      if (latest.has(key)) return false;
      // Legacy receipts use wall-clock cron keys: avoid re-sending their already observed minute.
      if (
        all.some(
          (row) =>
            !row.status &&
            Math.floor(Date.parse(row.sent_at) / 60000) === Math.floor(scheduled!.getTime() / 60000)
        )
      )
        return false;
      const last = all
        .filter((row) => row.delivered || row.status === 'accepted')
        .reduce<Date | undefined>((cursor, row) => {
          const at = new Date(row.content_at ?? row.scheduled_at ?? row.sent_at);
          return !cursor || at > cursor ? at : cursor;
        }, undefined);
      pending = append({
        dot_id: charter.dot_id,
        scope_hash: scope,
        key,
        sent_at: now.toISOString(),
        scheduled_at: scheduled.toISOString(),
        content_at: now.toISOString(),
        status: 'pending',
        attempts: 0,
        delivered: false,
        text: deps.compose(last),
      });
    }
    const attempts = (pending.attempts ?? 0) + 1;
    const attempt = append({
      ...pending,
      attempts,
      sent_at: now.toISOString(),
      next_attempt_at: new Date(
        now.getTime() + DOT_DIGEST_RETRY_MS * 2 ** (attempts - 1)
      ).toISOString(),
    });
    let receipt: OperatorNotificationReceipt;
    try {
      receipt = deps.notify(attempt.text ?? '', 'dot-digest:' + attempt.key);
    } catch {
      receipt = { status: 'uncertain', reason: 'notification_threw' };
    }
    const status =
      receipt.status === 'retryable'
        ? attempts >= DOT_DIGEST_MAX_ATTEMPTS
          ? 'exhausted'
          : 'pending'
        : receipt.status;
    append({
      ...attempt,
      status,
      delivered: receipt.status === 'accepted',
      ...(receipt.reason ? { reason: receipt.reason } : {}),
    });
    return receipt.status === 'accepted';
  });
}
