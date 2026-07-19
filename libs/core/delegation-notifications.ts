/**
 * KC-06: claim-based delegation completion notifications.
 *
 * Background/async delegations complete outside the running worker's context
 * window. Completions are enqueued here and the mission orchestration worker
 * claims a bounded batch (default 4) at the top of its next dispatch, so the
 * completion lands in LLM context exactly once instead of being lost or
 * re-delivered on every step.
 *
 * Persistence follows the memory-promotion-queue idiom: a JSONL file under
 * `active/shared/runtime/`, read/rewritten atomically via secure-io, with an
 * env override so parallel test suites never clobber the real queue.
 */

import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';

export interface DelegationNotification {
  notification_id: string;
  delegation_id: string;
  owner: string;
  status: 'completed' | 'failed';
  instruction_excerpt: string;
  result_excerpt?: string;
  error?: string;
  completed_at: string;
  enqueued_at: string;
  claimed: boolean;
  claimed_at?: string;
}

export const DELEGATION_NOTIFICATION_CLAIM_LIMIT = 4;
const EXCERPT_MAX_CHARS = 240;

// Tests namespace the queue via KYBERION_DELEGATION_NOTIFICATIONS_PATH so
// parallel suites never clobber the real queue file (resolved lazily per call).
function resolveQueuePath(): string {
  const override = process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH?.trim();
  if (override) return pathResolver.rootResolve(override);
  return pathResolver.shared('runtime/delegations/notifications.jsonl');
}

function ensureQueueDir(): void {
  const dir = resolveQueuePath().replace(/[/\\][^/\\]+$/, '');
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function excerpt(value: string | undefined): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > EXCERPT_MAX_CHARS
    ? `${normalized.slice(0, EXCERPT_MAX_CHARS - 1)}…`
    : normalized;
}

function parseJsonl(raw: string): DelegationNotification[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DelegationNotification);
}

export function enqueueDelegationNotification(input: {
  delegationId: string;
  owner: string;
  status: 'completed' | 'failed';
  instruction: string;
  result?: string;
  error?: string;
  completedAt?: string;
}): DelegationNotification {
  const now = new Date().toISOString();
  const notification: DelegationNotification = {
    notification_id: randomUUID(),
    delegation_id: String(input.delegationId || '').trim(),
    owner: String(input.owner || 'unknown').trim() || 'unknown',
    status: input.status,
    instruction_excerpt: excerpt(input.instruction),
    ...(input.result ? { result_excerpt: excerpt(input.result) } : {}),
    ...(input.error ? { error: excerpt(input.error) } : {}),
    completed_at: input.completedAt || now,
    enqueued_at: now,
    claimed: false,
  };
  if (!notification.delegation_id) {
    throw new Error('Delegation notification requires a delegation_id.');
  }
  ensureQueueDir();
  safeAppendFileSync(resolveQueuePath(), `${JSON.stringify(notification)}\n`, 'utf8');
  return notification;
}

export function listDelegationNotifications(): DelegationNotification[] {
  if (!safeExistsSync(resolveQueuePath())) return [];
  const raw = safeReadFile(resolveQueuePath(), { encoding: 'utf8' }) as string;
  return parseJsonl(raw);
}

/**
 * Claim up to `limit` pending notifications: the claimed rows are marked
 * `claimed` in the persisted queue in the same synchronous read-rewrite pass,
 * so a notification is delivered into worker context at most once.
 */
export function claimPendingDelegationNotifications(
  limit = DELEGATION_NOTIFICATION_CLAIM_LIMIT
): DelegationNotification[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const rows = listDelegationNotifications();
  if (rows.length === 0) return [];
  const claimedAt = new Date().toISOString();
  const claimed: DelegationNotification[] = [];
  const next = rows.map((row) => {
    if (row.claimed || claimed.length >= boundedLimit) return row;
    const claimedRow: DelegationNotification = { ...row, claimed: true, claimed_at: claimedAt };
    claimed.push(claimedRow);
    return claimedRow;
  });
  if (claimed.length === 0) return [];
  ensureQueueDir();
  safeWriteFile(resolveQueuePath(), `${next.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return claimed;
}

/** Prompt-section rendering for claimed notifications (worker dispatch). */
export function renderDelegationNotificationLines(
  notifications: readonly DelegationNotification[]
): string[] {
  if (notifications.length === 0) return [];
  return [
    '## Background delegation updates (delivered once — act on or record them now)',
    ...notifications.map((notification) => {
      const outcome =
        notification.status === 'failed'
          ? `FAILED: ${notification.error || 'no error detail recorded'}`
          : notification.result_excerpt || 'completed (no result excerpt recorded)';
      return `- [${notification.status}] delegation ${notification.delegation_id} (${notification.owner}) — task: ${notification.instruction_excerpt} — ${outcome}`;
    }),
    '',
  ];
}

export function delegationNotificationsPath(): string {
  return resolveQueuePath();
}
