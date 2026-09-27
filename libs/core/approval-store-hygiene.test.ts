import { afterEach, describe, expect, it, vi } from 'vitest';

const janitor = vi.hoisted(() => ({
  softDeleteToTrash: vi.fn((absolutePath: string) => ({
    trashPath: `/trash${absolutePath}`,
    originalRepoRelative: absolutePath,
  })),
  appendRetentionAudit: vi.fn(),
}));
vi.mock('./storage-janitor.js', () => janitor);

import {
  approvalEventLogicalPath,
  approvalStoreRoots,
  createApprovalRequest,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  DEFAULT_STALE_PENDING_APPROVAL_MS,
  findExpirablePendingApprovals,
  isFixtureApproval,
  purgeFixtureApprovals,
  sweepExpirablePendingApprovals,
} from './approval-store-hygiene.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function record(overrides: Partial<ApprovalRequestRecord>): ApprovalRequestRecord {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    kind: 'secret_mutation',
    storageChannel: 'terminal',
    channel: 'terminal',
    threadTs: '1',
    correlationId: 'c',
    requestedBy: 'operator',
    requestedAt: new Date(NOW - DAY_MS).toISOString(),
    status: 'pending',
    title: 'Introduce secret',
    summary: 's',
    ...overrides,
  } as ApprovalRequestRecord;
}

describe('findExpirablePendingApprovals', () => {
  it('expires pending requests past expiresAt and abandoned ones without it', () => {
    const selected = findExpirablePendingApprovals(
      [
        record({ id: 'overdue', expiresAt: new Date(NOW - 1000).toISOString() }),
        record({ id: 'future', expiresAt: new Date(NOW + DAY_MS).toISOString() }),
        record({ id: 'fresh' }),
        record({
          id: 'stale',
          requestedAt: new Date(NOW - DEFAULT_STALE_PENDING_APPROVAL_MS - 1).toISOString(),
        }),
        record({ id: 'unparseable', requestedAt: 'not-a-date' }),
        record({
          id: 'decided',
          status: 'approved',
          requestedAt: new Date(NOW - 90 * DAY_MS).toISOString(),
        }),
      ],
      { now: NOW }
    );

    expect(selected.map((c) => [c.requestId, c.reason])).toEqual([
      ['overdue', 'expires_at_passed'],
      ['stale', 'stale_pending'],
      ['unparseable', 'stale_pending'],
    ]);
  });

  it('honours a custom stale threshold and leaves fixtures to the purge', () => {
    const old = new Date(NOW - 3 * DAY_MS).toISOString();
    const selected = findExpirablePendingApprovals(
      [
        record({ id: 'real', requestedAt: old }),
        record({ id: 'fixture', requestedAt: old, storageChannel: 'qm07-test' }),
      ],
      { now: NOW, staleAfterMs: 2 * DAY_MS }
    );
    expect(selected.map((c) => c.requestId)).toEqual(['real']);
  });
});

describe('sweepExpirablePendingApprovals', () => {
  const channel = `hygiene-sweep-${process.pid}`;

  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/${channel}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('reports without writing in dry-run and expires through the store on apply', () => {
    const created = createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'sweep',
      requestedBy: 'operator',
      draft: { title: 'overdue request', summary: 'expired an hour ago' },
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const records = [loadApprovalRequest(channel, created.id)!];

    const dry = sweepExpirablePendingApprovals({ dryRun: true, records });
    expect(dry.candidates.map((c) => c.requestId)).toEqual([created.id]);
    expect(dry.applied).toEqual([]);
    expect(loadApprovalRequest(channel, created.id)?.status).toBe('pending');

    const applied = sweepExpirablePendingApprovals({ dryRun: false, records });
    expect(applied.errors).toEqual([]);
    expect(applied.applied).toEqual([created.id]);
    expect(loadApprovalRequest(channel, created.id)?.status).toBe('expired');
    const events = safeReadFile(pathResolver.rootResolve(approvalEventLogicalPath(channel)), {
      encoding: 'utf8',
    }) as string;
    expect(events).toContain('"reason":"expires_at_passed"');
  });
});

describe('purgeFixtureApprovals', () => {
  afterEach(() => {
    janitor.softDeleteToTrash.mockClear();
    janitor.appendRetentionAudit.mockClear();
  });

  it('selects the same fixtures the census excludes and never touches real records', () => {
    const records = [
      record({ id: '11111111-1111-4111-8111-111111111111', storageChannel: 'qm07-test' }),
      record({ id: '22222222-2222-4222-8222-222222222222', requestedBy: 'human:alice' }),
      record({ id: '33333333-3333-4333-8333-333333333333' }),
    ];
    expect(records.map(isFixtureApproval)).toEqual([true, true, false]);
    const secretLeftover = record({
      target: { serviceId: 'gemini', secretKey: 'API_KEY' },
      justification: { reason: 'pending apply' },
    });
    expect(isFixtureApproval(secretLeftover)).toBe(true);
    expect(
      isFixtureApproval({ ...secretLeftover, justification: { reason: 'Rotate prod key' } })
    ).toBe(false);

    const dry = purgeFixtureApprovals({ dryRun: true, records });
    expect(dry.candidates.map((c) => c.requestId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(janitor.softDeleteToTrash).not.toHaveBeenCalled();
  });

  it('moves existing fixture records to the trash with an audit line', () => {
    const channel = `qm99-fixture-${process.pid}`;
    const created = createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'purge',
      requestedBy: 'test-operator',
      draft: { title: 'fixture', summary: 'left behind by a test' },
    });
    try {
      const result = purgeFixtureApprovals({ dryRun: false, records: [created] });
      expect(result.errors).toEqual([]);
      expect(result.applied).toEqual([created.id]);
      expect(janitor.softDeleteToTrash).toHaveBeenCalledTimes(1);
      expect(janitor.appendRetentionAudit).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVAL_FIXTURE_TRASHED' })
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        for (const root of Object.values(approvalStoreRoots())) {
          const dir = pathResolver.rootResolve(`${root}/${channel}`);
          if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
});
