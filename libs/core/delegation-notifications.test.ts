import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  claimPendingDelegationNotifications,
  delegationNotificationsPath,
  enqueueDelegationNotification,
  listDelegationNotifications,
  renderDelegationNotificationLines,
} from './delegation-notifications.js';

const QUEUE_OVERRIDE = `active/shared/tmp/kc06-tests/notifications-${process.pid}.jsonl`;

describe('KC-06 delegation-notifications', () => {
  beforeEach(() => {
    process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH = QUEUE_OVERRIDE;
    if (safeExistsSync(delegationNotificationsPath())) {
      safeRmSync(delegationNotificationsPath());
    }
  });

  afterAll(() => {
    process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH = QUEUE_OVERRIDE;
    if (safeExistsSync(delegationNotificationsPath())) {
      safeRmSync(delegationNotificationsPath());
    }
    delete process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH;
  });

  it('claims at most 4 pending notifications and marks them claimed atomically', () => {
    for (let i = 1; i <= 6; i++) {
      enqueueDelegationNotification({
        delegationId: `DLG-${i}`,
        owner: 'background-review-fork',
        status: 'completed',
        instruction: `Background task ${i}`,
        result: `Result ${i}`,
      });
    }

    const first = claimPendingDelegationNotifications();
    expect(first).toHaveLength(4);
    expect(first.map((n) => n.delegation_id)).toEqual(['DLG-1', 'DLG-2', 'DLG-3', 'DLG-4']);
    expect(first.every((n) => n.claimed && n.claimed_at)).toBe(true);

    // The persisted queue reflects the claims.
    const persisted = listDelegationNotifications();
    expect(persisted.filter((n) => n.claimed)).toHaveLength(4);

    // Second claim returns the remainder; third returns nothing.
    const second = claimPendingDelegationNotifications();
    expect(second.map((n) => n.delegation_id)).toEqual(['DLG-5', 'DLG-6']);
    expect(claimPendingDelegationNotifications()).toEqual([]);
  });

  it('honors a custom claim limit and records failure notifications', () => {
    enqueueDelegationNotification({
      delegationId: 'DLG-FAIL',
      owner: 'adf-repair-agent',
      status: 'failed',
      instruction: 'Repair the contract',
      error: 'sub-agent output unparseable',
    });
    enqueueDelegationNotification({
      delegationId: 'DLG-OK',
      owner: 'adf-repair-agent',
      status: 'completed',
      instruction: 'Repair the other contract',
      result: 'repaired',
    });

    const claimed = claimPendingDelegationNotifications(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.delegation_id).toBe('DLG-FAIL');
    expect(claimed[0]?.error).toContain('unparseable');
  });

  it('only claims notifications matching the requested mission/task scope', () => {
    enqueueDelegationNotification({
      delegationId: 'DLG-M1',
      owner: 'worker',
      missionId: 'M1',
      taskId: 'T1',
      status: 'completed',
      instruction: 'mission one',
    });
    enqueueDelegationNotification({
      delegationId: 'DLG-M2',
      owner: 'worker',
      missionId: 'M2',
      taskId: 'T2',
      status: 'completed',
      instruction: 'mission two',
    });

    const first = claimPendingDelegationNotifications(4, { missionId: 'M1', taskId: 'T1' });
    expect(first.map((notification) => notification.delegation_id)).toEqual(['DLG-M1']);
    expect(claimPendingDelegationNotifications(4, { missionId: 'M1' })).toEqual([]);
    expect(
      claimPendingDelegationNotifications(4, { missionId: 'M2', taskId: 'T2' }).map(
        (notification) => notification.delegation_id
      )
    ).toEqual(['DLG-M2']);
  });

  it('renders claimed notifications as a delimited prompt section', () => {
    enqueueDelegationNotification({
      delegationId: 'DLG-RENDER',
      owner: 'worker',
      status: 'completed',
      instruction: 'Summarize logs',
      result: 'Summary written to active/shared/tmp/summary.md',
    });
    const lines = renderDelegationNotificationLines(claimPendingDelegationNotifications());
    expect(lines[0]).toContain('Background delegation updates');
    expect(lines.join('\n')).toContain('DLG-RENDER');
    expect(lines.join('\n')).toContain('Summary written to');
    expect(lines.join('\n')).toContain('untrusted data');
    expect(renderDelegationNotificationLines([])).toEqual([]);
  });

  it('derives child provenance when reading a legacy notification record', () => {
    safeWriteFile(
      delegationNotificationsPath(),
      `${JSON.stringify({
        notification_id: 'N-LEGACY',
        delegation_id: 'DLG-LEGACY',
        owner: 'worker',
        status: 'completed',
        instruction_excerpt: 'legacy',
        completed_at: new Date().toISOString(),
        enqueued_at: new Date().toISOString(),
        claimed: false,
      })}\n`
    );
    expect(listDelegationNotifications()[0]?.report_provenance).toEqual({
      source: 'child',
      delegation_id: 'DLG-LEGACY',
    });
  });

  it('rejects a queue override outside the repository', () => {
    process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH = '../outside/notifications.jsonl';
    expect(() => delegationNotificationsPath()).toThrow(/outside the repository root/);
    process.env.KYBERION_DELEGATION_NOTIFICATIONS_PATH = QUEUE_OVERRIDE;
  });

  it('rejects schema-invalid persisted notifications', () => {
    safeWriteFile(
      delegationNotificationsPath(),
      `${JSON.stringify({
        notification_id: 'N-INVALID',
        delegation_id: 'DLG-INVALID',
        owner: 'worker',
        status: 'completed',
        instruction_excerpt: 'invalid claimed value',
        completed_at: new Date().toISOString(),
        enqueued_at: new Date().toISOString(),
        claimed: 'no',
      })}\n`
    );

    expect(() => listDelegationNotifications()).toThrow(/Invalid catalog delegation-notification/);
  });

  it('rejects a notification queue directory', () => {
    safeMkdir(delegationNotificationsPath(), { recursive: true });

    expect(() => listDelegationNotifications()).toThrow(/queue must be a regular file/);
  });
});
