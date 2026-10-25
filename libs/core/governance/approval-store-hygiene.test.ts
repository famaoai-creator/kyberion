import { afterEach, describe, expect, it, vi } from 'vitest';

const janitor = vi.hoisted(() => ({
  softDeleteToTrash: vi.fn((absolutePath: string) => ({
    trashPath: `/trash${absolutePath}`,
    originalRepoRelative: absolutePath,
  })),
  appendRetentionAudit: vi.fn(),
  TRASH_REPO_SUBPATH: 'active/archive/.trash',
}));
vi.mock('../storage-janitor.js', () => janitor);

const trashAccess = vi.hoisted(() => ({
  check: vi.fn((): { allowed: boolean; reason?: string } => ({ allowed: true })),
}));
vi.mock('../tier-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tier-guard.js')>();
  return {
    ...actual,
    validateWritePermission: (filePath: string) =>
      filePath.includes('/active/archive/.trash/')
        ? trashAccess.check()
        : actual.validateWritePermission(filePath),
  };
});

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
  findLegacyTenantApprovals,
  isFixtureApproval,
  migrateTenantApprovalPartitions,
  purgeFixtureApprovals,
  sweepExpirablePendingApprovals,
  sweepExpiredPasskeyChallenges,
} from './approval-store-hygiene.js';
import { approvalRequestLogicalPath } from './approval-store-paths.js';
import {
  locateApprovalRequest,
  tenantApprovalPasskeyChallengesLogicalDir,
  tenantApprovalRequestLogicalPath,
  writeApprovalJsonAt,
  type ApprovalTenantPartition,
} from './approval-store-location.js';
import { auditChain } from './audit-chain.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';
import { issueApprovalPasskeyChallenge } from './approval-passkey-challenge.js';
import { computeApprovalPresentedDigest } from './approval-presentation.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const TENANT = `hyg-${process.pid}`;
const TENANT_PARTITION: ApprovalTenantPartition = {
  kind: 'tenant',
  tier: 'confidential',
  tenant_slug: TENANT,
};
const TENANT_SCOPE = {
  scope_kind: 'tenant' as const,
  tier: 'confidential' as const,
  tenant_slug: TENANT,
};

/** Remove a channel from the system tree and the test tenant's partitions. */
function removeChannel(channel: string): void {
  withExecutionContext('mission_controller', () => {
    const roots = approvalStoreRoots();
    for (const root of [roots.coordination, roots.observability]) {
      const dir = pathResolver.rootResolve(`${root}/${channel}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
    for (const tier of ['personal', 'confidential']) {
      const dir = pathResolver.rootResolve(`${roots.tenantApprovals}/${tier}/${TENANT}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
  });
}

function existsAt(logicalPath: string): boolean {
  return withExecutionContext('mission_controller', () =>
    safeExistsSync(pathResolver.rootResolve(logicalPath))
  );
}
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
          id: 'pipeline-owned',
          requestedAt: new Date(NOW - 90 * DAY_MS).toISOString(),
          requestedByContext: { surface: 'pipeline', pipelineRunId: 'run-1' } as never,
        }),
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
    trashAccess.check.mockReset();
    trashAccess.check.mockReturnValue({ allowed: true });
  });

  it('stops with one actionable error when the trash is not writable', () => {
    trashAccess.check.mockReturnValue({ allowed: false, reason: '[POLICY_VIOLATION] denied' });
    const records = [
      record({ id: '11111111-1111-4111-8111-111111111111', storageChannel: 'qm07-test' }),
      record({ id: '22222222-2222-4222-8222-222222222222', requestedBy: 'human:alice' }),
    ];
    const result = purgeFixtureApprovals({ dryRun: false, records });
    expect(result.candidates).toHaveLength(2);
    expect(result.applied).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('KYBERION_PERSONA=sovereign');
    expect(trashAccess.check).toHaveBeenCalledTimes(1);
    expect(janitor.softDeleteToTrash).not.toHaveBeenCalled();
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
    expect(dry.candidates.map((c) => [c.requestId, c.rule])).toEqual([
      ['11111111-1111-4111-8111-111111111111', 'channel_token'],
      ['22222222-2222-4222-8222-222222222222', 'requester_alice'],
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
        expect.objectContaining({
          event: 'APPROVAL_FIXTURE_TRASHED',
          fixture_rule: 'channel_token',
        })
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

describe('sweepExpiredPasskeyChallenges', () => {
  const channel = `hygiene-passkey-${process.pid}`;

  afterEach(() => {
    withExecutionContext('mission_controller', () => {
      for (const root of Object.values(approvalStoreRoots())) {
        const dir = pathResolver.rootResolve(`${root}/${channel}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('removes challenges past expiry plus retention and keeps live ones', () => {
    const created = createApprovalRequest('mission_controller', {
      channel,
      threadTs: '1',
      correlationId: 'passkey-sweep',
      requestedBy: 'operator',
      draft: { title: 'passkey sweep', summary: 'HA-07 challenge cleanup' },
      accountability: { finalDecision: 'human_only', min_assurance: 'A3' },
    });
    const issue = (now: Date) =>
      issueApprovalPasskeyChallenge('mission_controller', {
        record: created,
        presentedDigest: computeApprovalPresentedDigest(created),
        storageChannel: channel,
        decision: 'approved',
        memberId: 'owner',
        now,
      });
    const stale = issue(new Date(Date.now() - 3 * 60 * 60 * 1000));
    const live = issue(new Date());
    const path = (id: string) =>
      `${approvalStoreRoots().coordination}/${channel}/approvals/passkey-challenges/${id}.json`;

    const dry = sweepExpiredPasskeyChallenges({ dryRun: true });
    const mine = dry.candidates.filter((c) => c.storageChannel === channel);
    expect(mine.map((c) => c.logicalPath)).toEqual([path(stale.challenge_id)]);
    expect(safeExistsSync(pathResolver.rootResolve(path(stale.challenge_id)))).toBe(true);

    const applied = sweepExpiredPasskeyChallenges({ dryRun: false });
    expect(applied.errors).toEqual([]);
    expect(applied.applied).toContain(path(stale.challenge_id));
    expect(safeExistsSync(pathResolver.rootResolve(path(stale.challenge_id)))).toBe(false);
    expect(safeExistsSync(pathResolver.rootResolve(path(live.challenge_id)))).toBe(true);
  });
});

describe('approval store hygiene over tenant partitions', () => {
  const channel = `hygiene-tenant-${process.pid}`;
  const fixtureChannel = `qm98-tenant-fixture-${process.pid}`;

  afterEach(() => {
    removeChannel(channel);
    removeChannel(fixtureChannel);
    janitor.softDeleteToTrash.mockClear();
    vi.restoreAllMocks();
  });

  function createTenant(storageChannel = channel): ApprovalRequestRecord {
    return createApprovalRequest('mission_controller', {
      channel: storageChannel,
      threadTs: '1',
      correlationId: 'tenant-hygiene',
      requestedBy: 'operator',
      draft: { title: 'tenant hygiene', summary: 'approval-store-hygiene tenant partition' },
      scope: TENANT_SCOPE,
      accountability: { finalDecision: 'human_only', min_assurance: 'A3' },
    });
  }

  /** A tenant record written to the system tree before the partitions existed. */
  function writeLegacy(storageChannel = channel): ApprovalRequestRecord {
    const base = createApprovalRequest('mission_controller', {
      channel: storageChannel,
      threadTs: '1',
      correlationId: 'tenant-hygiene-legacy',
      requestedBy: 'operator',
      draft: { title: 'legacy tenant record', summary: 'pre-partition' },
    });
    const legacy: ApprovalRequestRecord = { ...base, scope: TENANT_SCOPE };
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(storageChannel, legacy.id),
      legacy
    );
    return legacy;
  }

  it('sweeps expired passkey challenges inside a tenant partition', () => {
    const created = createTenant();
    const issue = (now: Date) =>
      issueApprovalPasskeyChallenge('mission_controller', {
        record: created,
        presentedDigest: computeApprovalPresentedDigest(created),
        storageChannel: channel,
        decision: 'approved',
        memberId: 'owner',
        now,
      });
    const stale = issue(new Date(Date.now() - 3 * 60 * 60 * 1000));
    const live = issue(new Date());
    const path = (id: string) =>
      `${tenantApprovalPasskeyChallengesLogicalDir(TENANT_PARTITION, channel)}/${id}.json`;
    expect(existsAt(path(stale.challenge_id))).toBe(true);

    const dry = sweepExpiredPasskeyChallenges({ dryRun: true });
    const mine = dry.candidates.filter((c) => c.storageChannel === channel);
    expect(mine.map((c) => [c.logicalPath, c.partition])).toEqual([
      [path(stale.challenge_id), TENANT_PARTITION],
    ]);

    const applied = sweepExpiredPasskeyChallenges({ dryRun: false });
    expect(applied.errors).toEqual([]);
    expect(applied.applied).toContain(path(stale.challenge_id));
    expect(existsAt(path(stale.challenge_id))).toBe(false);
    expect(existsAt(path(live.challenge_id))).toBe(true);
  });

  it('trashes a fixture record from the tenant partition it lives in', () => {
    const created = createTenant(fixtureChannel);
    const partitionPath = tenantApprovalRequestLogicalPath(
      TENANT_PARTITION,
      fixtureChannel,
      created.id
    );
    const result = purgeFixtureApprovals({ dryRun: false, records: [created] });
    expect(result.errors).toEqual([]);
    expect(result.candidates.map((c) => [c.logicalPath, c.partition])).toEqual([
      [partitionPath, TENANT_PARTITION],
    ]);
    expect(janitor.softDeleteToTrash).toHaveBeenCalledWith(pathResolver.resolve(partitionPath));
  });

  it('reports a legacy tenant record and moves it into its partition on apply, idempotently', () => {
    const legacy = writeLegacy();
    const audit = vi.spyOn(auditChain, 'record');
    const from = approvalRequestLogicalPath(channel, legacy.id);
    const to = tenantApprovalRequestLogicalPath(TENANT_PARTITION, channel, legacy.id);

    const dry = migrateTenantApprovalPartitions({ dryRun: true });
    const mine = dry.candidates.filter((c) => c.storageChannel === channel);
    expect(mine).toEqual([
      expect.objectContaining({ requestId: legacy.id, from, to, partition: TENANT_PARTITION }),
    ]);
    expect(existsAt(from)).toBe(true);
    expect(existsAt(to)).toBe(false);

    const applied = migrateTenantApprovalPartitions({ dryRun: false });
    expect(applied.errors).toEqual([]);
    expect(applied.outcomes[legacy.id]).toBe('moved');
    expect(existsAt(from)).toBe(false);
    expect(existsAt(to)).toBe(true);
    const located = locateApprovalRequest(channel, legacy.id);
    expect(located?.partition).toEqual(TENANT_PARTITION);
    expect(located?.record).toEqual(legacy);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'migrate_tenant_partition',
        result: 'completed',
        metadata: expect.objectContaining({ request_id: legacy.id, outcome: 'moved' }),
      })
    );

    const again = migrateTenantApprovalPartitions({ dryRun: false });
    expect(again.candidates.filter((c) => c.storageChannel === channel)).toEqual([]);
    expect(again.errors).toEqual([]);
  });

  it('removes an identical system copy and refuses a partition copy with different content', () => {
    const same = writeLegacy();
    writeApprovalJsonAt(
      'mission_controller',
      TENANT_PARTITION,
      tenantApprovalRequestLogicalPath(TENANT_PARTITION, channel, same.id),
      same
    );
    const differs = writeLegacy();
    writeApprovalJsonAt(
      'mission_controller',
      TENANT_PARTITION,
      tenantApprovalRequestLogicalPath(TENANT_PARTITION, channel, differs.id),
      { ...differs, status: 'approved' }
    );

    const result = migrateTenantApprovalPartitions({
      dryRun: false,
      records: [same, differs],
    });
    expect(result.outcomes[same.id]).toBe('removed_duplicate');
    expect(existsAt(approvalRequestLogicalPath(channel, same.id))).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('[APPROVAL_MIGRATION_CONFLICT]');
    expect(existsAt(approvalRequestLogicalPath(channel, differs.id))).toBe(true);
  });

  it('leaves a tenant-activation request in the system tree until its tenant is active', () => {
    const activation = record({
      id: '44444444-4444-4444-8444-444444444444',
      kind: 'mission_gate',
      storageChannel: 'tenant-activation',
      channel: 'tenant-activation',
      scope: TENANT_SCOPE,
    });
    const untenanted = record({ id: '55555555-5555-4555-8555-555555555555' });
    expect(
      findLegacyTenantApprovals([activation, untenanted], { isTenantActive: () => false })
    ).toEqual([]);
    expect(
      findLegacyTenantApprovals([activation, untenanted], { isTenantActive: () => true }).map(
        (c) => c.requestId
      )
    ).toEqual([activation.id]);
    // Without a readable activation command the default rule counts it as not active.
    expect(findLegacyTenantApprovals([activation])).toEqual([]);
  });
});
