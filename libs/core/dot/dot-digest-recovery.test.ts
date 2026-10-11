import { dotStatePath } from './dot-state-paths.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { safeRmSync, safeReadFile, safeExistsSync, safeWriteFile } from '../secure-io.js';
import { getFoundationIo } from '../foundation/io.js';
import { sendDueDotDigest, DOT_DIGEST_MAX_ATTEMPTS } from './dot-digest-delivery.js';
import { dotDigestActionEvidence } from './dot-digest-evidence.js';
import type { DotCharter } from './dot-charter.js';
import type { DotActionRecord } from './dot-action-ledger.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
const root = 'active/shared/tmp/digest-recovery-' + randomUUID();
const charter = {
  dot_id: 'digest',
  title: 'Digest',
  scope: { tier: 'public' },
  notification: { digest_cron: '0 9 * * *' },
  authority: { authority_role: 'worker' },
} as DotCharter;
afterEach(() => {
  vi.restoreAllMocks();
  safeRmSync(root, { recursive: true, force: true });
});
const deps = (at: string, notify: Parameters<typeof sendDueDotDigest>[2]['notify']) => ({
  rootDir: root,
  now: () => new Date(at),
  compose: () => 'frozen digest',
  notify,
});
describe('durable digest delivery', () => {
  it('ignores null and primitive legacy metadata rows', () => {
    safeWriteFile(root + '/active/shared/runtime/dot-digest-ledger.jsonl', 'null\n1\n"legacy"\n', {
      mkdir: true,
    });
    expect(
      sendDueDotDigest(
        charter,
        'UTC',
        deps('2026-10-04T09:00:00Z', () => ({ status: 'accepted' }))
      )
    ).toBe(true);
  });
  it('persists tenant digest prose only inside its physical tenant namespace', () => {
    const c = { ...charter, scope: { tier: 'confidential' as const, tenant_slug: 'private-team' } };
    sendDueDotDigest(
      c,
      'UTC',
      deps('2026-10-04T09:00:00Z', () => ({ status: 'retryable' }))
    );
    expect(safeExistsSync(root + '/active/shared/runtime/dot-digest-ledger.jsonl')).toBe(false);
    const physical = dotStatePath(c, 'digest-ledger.jsonl');
    expect(physical).toContain('private-team');
    expect(String(safeReadFile(root + '/' + physical, { encoding: 'utf8' }))).toContain(
      'frozen digest'
    );
  });
  it('retries false/no-effect outcome after restart, outside exact cron minute, with frozen identity', () => {
    const calls: string[] = [];
    expect(
      sendDueDotDigest(
        charter,
        'UTC',
        deps('2026-10-04T09:00:10Z', (text, key) => {
          calls.push(text + key);
          return { status: 'retryable' };
        })
      )
    ).toBe(false);
    const notify = vi.fn((text: string, key: string) => {
      calls.push(text + key);
      return { status: 'accepted' as const };
    });
    expect(sendDueDotDigest(charter, 'UTC', deps('2026-10-04T09:01:00Z', notify))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(sendDueDotDigest(charter, 'UTC', deps('2026-10-04T09:11:00Z', notify))).toBe(true);
    expect(calls[1]).toBe(calls[0]);
    expect(sendDueDotDigest(charter, 'UTC', deps('2026-10-04T10:00:00Z', notify))).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('catches up only the latest missed slot and never emits a historical storm', () => {
    const notify = vi.fn(() => ({ status: 'accepted' as const }));
    expect(sendDueDotDigest(charter, 'UTC', deps('2026-10-04T12:00:00Z', notify))).toBe(true);
    expect(sendDueDotDigest(charter, 'UTC', deps('2026-10-04T12:01:00Z', notify))).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(
      sendDueDotDigest(
        { ...charter, notification: { digest_cron: '0 9 1 * *' } },
        'UTC',
        deps('2026-10-04T12:01:00Z', notify)
      )
    ).toBe(false);
  });
  it('keeps the content cutoff before a delayed retry so later results are not skipped', () => {
    const compose = vi.fn((_since: Date | undefined) => 'snapshot');
    sendDueDotDigest(charter, 'UTC', {
      ...deps('2026-10-04T09:00:00Z', () => ({ status: 'retryable' })),
      compose,
    });
    sendDueDotDigest(
      charter,
      'UTC',
      deps('2026-10-04T12:00:00Z', () => ({ status: 'accepted' }))
    );
    sendDueDotDigest(charter, 'UTC', {
      ...deps('2026-10-05T09:00:00Z', () => ({ status: 'accepted' })),
      compose,
    });
    expect(compose.mock.calls[1][0]?.toISOString()).toBe('2026-10-04T09:00:00.000Z');
  });
  it('settles mute and uncertainty without retries', () => {
    for (const status of ['suppressed', 'uncertain'] as const) {
      const c = { ...charter, dot_id: status };
      const notify = vi.fn(() => ({ status }));
      expect(sendDueDotDigest(c, 'UTC', deps('2026-10-04T09:00:00Z', notify))).toBe(false);
      expect(sendDueDotDigest(c, 'UTC', deps('2026-10-04T09:30:00Z', notify))).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    }
  });
  it('has a finite durable retry budget', () => {
    const notify = vi.fn(() => ({ status: 'retryable' as const }));
    for (const time of ['09:00', '09:11', '09:32', '10:13', '11:34', '14:15', '20:00'])
      sendDueDotDigest(charter, 'UTC', deps('2026-10-04T' + time + ':00Z', notify));
    expect(notify).toHaveBeenCalledTimes(DOT_DIGEST_MAX_ATTEMPTS);
  });
  it('reuses pending identity after final receipt append failure', () => {
    const io = getFoundationIo();
    const original = io.appendFile.bind(io);
    let fail = true;
    vi.spyOn(io, 'appendFile').mockImplementation((file, data) => {
      if (
        fail &&
        String(file).endsWith('digest-ledger.jsonl') &&
        String(data).includes('"status":"accepted"')
      ) {
        fail = false;
        throw new Error('interrupted');
      }
      return original(file, data);
    });
    const keys = new Set<string>();
    const notify = vi.fn((_text: string, key: string) => {
      keys.add(key);
      return { status: 'accepted' as const };
    });
    expect(() => sendDueDotDigest(charter, 'UTC', deps('2026-10-04T09:00:00Z', notify))).toThrow(
      'interrupted'
    );
    expect(sendDueDotDigest(charter, 'UTC', deps('2026-10-04T09:11:00Z', notify))).toBe(true);
    expect(keys.size).toBe(1);
  });
  it('uses timezone and scheduled UTC instant across date boundaries', () => {
    const keys: string[] = [];
    const notify = (_text: string, key: string) => {
      keys.push(key);
      return { status: 'accepted' as const };
    };
    expect(sendDueDotDigest(charter, 'Asia/Tokyo', deps('2026-10-04T00:02:00Z', notify))).toBe(
      true
    );
    expect(sendDueDotDigest(charter, 'Asia/Tokyo', deps('2026-10-05T00:02:00Z', notify))).toBe(
      true
    );
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('2026-10-04T00:00:00.000Z');
  });
});
describe('terminal evidence only', () => {
  const action = {
    dot_id: 'digest',
    action_ref: 'a',
    work_item_id: 'i',
    status: 'dispatched',
    at: '2026-10-04T08:00:00Z',
  } as DotActionRecord;
  const item = {
    item_id: 'i',
    status: 'done',
    context: {},
    metadata: { action_ref: 'a' },
    attempts: [{ run_id: 'attempt' }],
  } as WorkItem;
  const row = {
    dot_id: 'digest',
    action_ref: 'a',
    work_item_id: 'i',
    status: 'done',
    attempt_id: 'attempt',
    completed_at: '2026-10-04T09:00:00Z',
  } as DotWorkResultRow;
  const evidence = (rows: DotWorkResultRow[], i = item, c = charter) =>
    dotDigestActionEvidence(c, action, {
      findWorkItemByActionRef: () => i,
      readWorkResults: () => rows,
    });
  it('never calls dispatch or item-only done completion', () => {
    expect(evidence([]).status).toBe('queued');
    expect(evidence([row]).status).toBe('done');
  });
  it('reports blocked/failed receipts honestly', () => {
    expect(evidence([{ ...row, status: 'blocked' }]).status).toBe('blocked');
    expect(evidence([{ ...row, status: 'failed' }]).status).toBe('failed');
  });
  it('rejects stale attempts, mismatched identity, release and reopened work', () => {
    expect(evidence([{ ...row, attempt_id: 'old' }]).status).toBe('queued');
    expect(evidence([{ ...row, action_ref: 'other' }]).status).toBe('queued');
    expect(
      evidence([row], {
        ...item,
        metadata: {
          ...item.metadata,
          dot_executor: { operator_verified_at: '2026-10-04T09:10:00Z' },
        },
      }).status
    ).toBe('queued');
    expect(evidence([row], { ...item, status: 'ready' }).status).toBe('queued');
  });
  it('does not read cross-tenant handoff receipts', () => {
    const read = vi.fn(() => [row]);
    expect(
      dotDigestActionEvidence(
        charter,
        { ...action, handoff_to: 'other' },
        {
          listCharters: () => [
            { ...charter, dot_id: 'other', scope: { tier: 'confidential', tenant_slug: 'other' } },
          ],
          readWorkResults: read,
        }
      ).status
    ).toBe('queued');
    expect(read).not.toHaveBeenCalled();
  });
});
