import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDecisionDigest,
  formatDigestAge,
  listAutonomousActionNotices,
  recordAutonomousActionNotice,
  renderDecisionDigestText,
} from './approval-digest.js';
import { approvalStoreRoots, type ApprovalRequestRecord } from './approval-store.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';

const NOW = Date.parse('2026-09-28T03:00:00Z');
const HOUR = 60 * 60 * 1000;
const SINCE = new Date(NOW - 12 * HOUR).toISOString();

let seq = 0;
function record(overrides: Partial<ApprovalRequestRecord>): ApprovalRequestRecord {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    kind: 'channel-approval',
    storageChannel: 'autonomy',
    channel: 'chat-1',
    threadTs: '',
    correlationId: 'c',
    requestedBy: 'agent:test',
    requestedAt: new Date(NOW - HOUR).toISOString(),
    status: 'pending',
    title: `Request ${seq}`,
    summary: 'summary',
    ...overrides,
  } as ApprovalRequestRecord;
}

describe('buildDecisionDigest', () => {
  it('sorts the loop into needs-you, veto, done, stale and expired', () => {
    const digest = buildDecisionDigest({
      now: NOW,
      since: SINCE,
      approvals: [
        record({ title: 'Old decision', requestedAt: new Date(NOW - 50 * HOUR).toISOString() }),
        record({ title: 'New decision' }),
        record({
          title: 'Veto later',
          veto: {
            windowMinutes: 120,
            deliveryDeadlineAt: new Date(NOW + HOUR).toISOString(),
            deliveredAt: new Date(NOW).toISOString(),
            proceedsAt: new Date(NOW + 3 * HOUR).toISOString(),
          },
        }),
        record({
          title: 'Veto sooner',
          veto: {
            windowMinutes: 60,
            deliveryDeadlineAt: new Date(NOW + HOUR).toISOString(),
            deliveredAt: new Date(NOW).toISOString(),
            proceedsAt: new Date(NOW + HOUR).toISOString(),
          },
        }),
        record({
          title: 'Undelivered veto',
          veto: { windowMinutes: 60, deliveryDeadlineAt: new Date(NOW - HOUR).toISOString() },
        }),
        record({
          title: 'Auto merged',
          status: 'approved',
          decidedByType: 'service',
          decidedBy: 'policy:veto-window',
          decidedAt: new Date(NOW - 2 * HOUR).toISOString(),
        }),
        record({
          title: 'Human approved',
          status: 'approved',
          decidedByType: 'human',
          decidedAt: new Date(NOW - 2 * HOUR).toISOString(),
        }),
        record({
          title: 'Timed out',
          status: 'expired',
          expiresAt: new Date(NOW - HOUR).toISOString(),
        }),
      ],
      notices: [
        {
          ts: new Date(NOW - HOUR).toISOString(),
          actionId: 'auto_checkpoint',
          level: 'none',
          title: 'Checkpoint',
        },
        {
          ts: new Date(NOW - 20 * HOUR).toISOString(),
          actionId: 'auto_checkpoint',
          level: 'none',
          title: 'Too old',
        },
      ],
      missions: [
        {
          missionId: 'MSN-STALE',
          status: 'planned',
          updatedAt: new Date(NOW - 5 * 24 * HOUR).toISOString(),
        },
        { missionId: 'MSN-FRESH', status: 'paused', updatedAt: new Date(NOW - HOUR).toISOString() },
      ],
    });

    expect(digest.needsDecision.map((item) => item.title)).toEqual([
      'Old decision',
      'New decision',
      'Undelivered veto',
    ]);
    expect(digest.vetoPending.map((item) => item.title)).toEqual(['Veto sooner', 'Veto later']);
    expect(digest.done.map((item) => item.title)).toEqual(['Auto merged', 'Checkpoint']);
    expect(digest.stale.map((item) => item.id)).toEqual(['MSN-STALE']);
    expect(digest.expired.map((item) => item.title)).toEqual(['Timed out']);
    expect(digest.counts).toEqual({ decide: 3, veto: 2, done: 2, stale: 1, expired: 1 });

    const text = renderDecisionDigestText(digest, { locale: 'ja', timezone: 'Asia/Tokyo' });
    expect(text.split('\n')[1]).toBe(
      'あなたの判断: 3件 ・ 異議がなければ進むもの: 2件 ・ 自動で済ませたこと: 2件'
    );
    expect(text).toContain('Old decision — summary (2日待ち)');
    expect(text).toContain('9/28 13:00 に進行');
    expect(text).toContain('ミッション MSN-STALE が planned のまま (5日待ち)');
    expect(text).not.toContain('いま、あなたの対応が必要なものはありません。');
  });

  it('says so when nothing needs the operator and caps long sections', () => {
    const empty = buildDecisionDigest({ now: NOW, since: SINCE, approvals: [] });
    expect(renderDecisionDigestText(empty, { locale: 'en' })).toContain(
      'Nothing needs you right now.'
    );

    const many = buildDecisionDigest({
      now: NOW,
      since: SINCE,
      approvals: Array.from({ length: 7 }, () => record({})),
    });
    expect(renderDecisionDigestText(many, { locale: 'en' })).toContain('…and 2 more');
  });

  it('formats ages compactly', () => {
    expect(formatDigestAge(30 * 60_000, 'en')).toBe('30m');
    expect(formatDigestAge(5 * HOUR, 'ja')).toBe('5時間');
  });
});

describe('autonomous action notices', () => {
  // The per-worker approval store is shared by every file that runs in this
  // worker; clear it before as well as after so earlier files' notices
  // (e.g. approval-decision-routing) cannot leak into the assertion.
  const clearNotices = () =>
    withExecutionContext('mission_controller', () => {
      const dir = pathResolver.rootResolve(`${approvalStoreRoots().observability}/autonomy`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    });
  beforeEach(clearNotices);
  afterEach(clearNotices);

  it('records report-only actions so the digest can show them', () => {
    recordAutonomousActionNotice('mission_controller', {
      actionId: 'daemon_restart',
      level: 'fyi',
      title: 'Restarted chronos daemon',
      ts: new Date(NOW).toISOString(),
    });
    expect(listAutonomousActionNotices(NOW - HOUR).map((notice) => notice.title)).toEqual([
      'Restarted chronos daemon',
    ]);
    expect(listAutonomousActionNotices(NOW + HOUR)).toEqual([]);
  });
});
