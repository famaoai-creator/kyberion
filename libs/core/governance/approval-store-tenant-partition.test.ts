import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';
import {
  approvalEventLogicalPath,
  approvalPartitionForScope,
  approvalRequestLogicalPath,
  approvalStoreRoots,
  asTenantApprovalStore,
  cancelApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
  expireApprovalRequest,
  listApprovalPartitions,
  listApprovalRequests,
  loadApprovalRequest,
  locateApprovalRequest,
  tenantApprovalEventLogicalPath,
  tenantApprovalPartitionLogicalRoot,
  tenantApprovalPasskeyChallengesLogicalDir,
  tenantApprovalRequestLogicalPath,
  writeApprovalJsonAt,
  type ApprovalRequestRecord,
  type ApprovalTenantPartition,
} from './approval-store.js';
import { computeApprovalPresentedDigest } from './approval-presentation.js';
import {
  claimApprovalPasskeyChallenge,
  issueApprovalPasskeyChallenge,
  markApprovalPasskeyChallengeVerified,
} from './approval-passkey-challenge.js';
import { markApprovalConsumed, revokeApprovalRequest } from './approval-revocation.js';
import {
  buildVetoWindow,
  markApprovalNotificationDelivered,
  tickVetoWindows,
} from './approval-veto-window.js';
import {
  annotateApprovalRejectionReason,
  claimApprovalApply,
  clearSessionApprovalCache,
  computeApprovalPayloadHash,
  lookupSessionApprovalCache,
  recordApprovalApplyResult,
  recordSessionCacheAutoApproval,
  resolveSessionCacheSeed,
} from './approval-store.js';

const CHANNEL = `tenant-partition-${process.pid}`;
const TENANT_A = `apa-${process.pid}`;
const TENANT_B = `apb-${process.pid}`;
const partitionOf = (
  tenant: string,
  tier: ApprovalTenantPartition['tier'] = 'confidential'
): ApprovalTenantPartition => ({ kind: 'tenant', tier, tenant_slug: tenant });

const asController = <T>(fn: () => T, tenant?: string): T =>
  withExecutionContext('mission_controller', fn, undefined, tenant);

function exists(logicalPath: string): boolean {
  return asController(() => safeExistsSync(pathResolver.rootResolve(logicalPath)));
}

function eventLines(logicalPath: string, tenant?: string): Record<string, unknown>[] {
  const read = () => {
    const file = pathResolver.rootResolve(logicalPath);
    if (!safeExistsSync(file)) return [];
    return String(safeReadFile(file, { encoding: 'utf8' }))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return tenant ? asTenantApprovalStore(tenant, read) : asController(read);
}

function create(
  scope?: { tenant_slug?: string; tier?: 'personal' | 'confidential' | 'public' },
  options: {
    storageChannel?: string;
    tenantActive?: boolean;
    kind?: ApprovalRequestRecord['kind'];
    channel?: string;
    role?: 'mission_controller' | 'slack_bridge';
  } = {}
): ApprovalRequestRecord {
  return createApprovalRequest(options.role ?? 'mission_controller', {
    channel: options.channel ?? CHANNEL,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.storageChannel ? { storageChannel: options.storageChannel } : {}),
    threadTs: '1',
    correlationId: `tenant-partition-${process.pid}`,
    requestedBy: 'approval-store-tenant-partition-test',
    draft: { title: 'partition probe', summary: 'written by approval-store-tenant-partition.test' },
    ...(scope
      ? {
          scope: {
            scope_kind: scope.tenant_slug ? ('tenant' as const) : ('system' as const),
            tier: scope.tier ?? 'confidential',
            ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
          },
        }
      : {}),
    ...(options.tenantActive !== undefined ? { tenantActive: options.tenantActive } : {}),
  });
}

afterEach(() => {
  const roots = approvalStoreRoots();
  asController(() => {
    for (const root of [roots.coordination, roots.observability]) {
      const dir = pathResolver.rootResolve(`${root}/${CHANNEL}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
    for (const tier of ['personal', 'confidential'])
      for (const tenant of [TENANT_A, TENANT_B]) {
        const dir = pathResolver.rootResolve(`${roots.tenantApprovals}/${tier}/${tenant}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
  });
});

describe('approval store tenant partitions', () => {
  it('places a tenant-scoped request (and its event) in the tenant partition, never the system tree', () => {
    const record = create({ tenant_slug: TENANT_A });
    const partition = partitionOf(TENANT_A);
    expect(exists(tenantApprovalRequestLogicalPath(partition, CHANNEL, record.id))).toBe(true);
    expect(exists(approvalRequestLogicalPath(CHANNEL, record.id))).toBe(false);
    expect(
      eventLines(tenantApprovalEventLogicalPath(partition, CHANNEL), TENANT_A).map((e) => e.event)
    ).toEqual(['approval_requested']);
    expect(eventLines(approvalEventLogicalPath(CHANNEL))).toEqual([]);
  });

  it('keeps untenanted requests in the system tree and maps public tenant records to confidential', () => {
    const system = create({ tier: 'public' });
    expect(exists(approvalRequestLogicalPath(CHANNEL, system.id))).toBe(true);
    const unscoped = create();
    expect(exists(approvalRequestLogicalPath(CHANNEL, unscoped.id))).toBe(true);

    const pub = create({ tenant_slug: TENANT_A, tier: 'public' });
    expect(pub.scope?.tier).toBe('public');
    expect(exists(tenantApprovalRequestLogicalPath(partitionOf(TENANT_A), CHANNEL, pub.id))).toBe(
      true
    );
    const personal = create({ tenant_slug: TENANT_A, tier: 'personal' });
    expect(
      exists(
        tenantApprovalRequestLogicalPath(partitionOf(TENANT_A, 'personal'), CHANNEL, personal.id)
      )
    ).toBe(true);
  });

  it('keeps an activation request for a tenant that is not yet active in the system tree', () => {
    const scope = {
      scope_kind: 'tenant' as const,
      tier: 'confidential' as const,
      tenant_slug: TENANT_A,
    };
    const activation = { storageChannel: 'tenant-activation', kind: 'mission_gate' };
    expect(approvalPartitionForScope(scope, activation)).toEqual({ kind: 'system' });
    expect(approvalPartitionForScope(scope, { ...activation, tenantActive: false })).toEqual({
      kind: 'system',
    });
    expect(approvalPartitionForScope(scope, { ...activation, tenantActive: true })).toEqual(
      partitionOf(TENANT_A)
    );
    // Only a genuine activation request (channel AND kind) gets the exception.
    expect(
      approvalPartitionForScope(scope, {
        storageChannel: 'tenant-activation',
        kind: 'channel-approval',
      })
    ).toEqual(partitionOf(TENANT_A));
    // Only the activation channel consults activation state.
    expect(approvalPartitionForScope(scope, { storageChannel: CHANNEL })).toEqual(
      partitionOf(TENANT_A)
    );

    const pending = create(
      { tenant_slug: TENANT_A },
      { storageChannel: 'tenant-activation', tenantActive: false, kind: 'mission_gate' }
    );
    try {
      expect(exists(approvalRequestLogicalPath('tenant-activation', pending.id))).toBe(true);
      expect(locateApprovalRequest('tenant-activation', pending.id)?.partition).toEqual({
        kind: 'system',
      });
    } finally {
      asController(() => {
        for (const logical of [
          approvalRequestLogicalPath('tenant-activation', pending.id),
          approvalEventLogicalPath('tenant-activation'),
        ])
          safeRmSync(pathResolver.rootResolve(logical), { force: true });
      });
    }
  });

  it('lets an unbound process load, list, decide, cancel and expire a tenant record by (channel, id)', () => {
    const decided = create({ tenant_slug: TENANT_A });
    const cancelled = create({ tenant_slug: TENANT_A });
    const expired = create({ tenant_slug: TENANT_B });
    expect(loadApprovalRequest(CHANNEL, decided.id)?.id).toBe(decided.id);
    expect(
      listApprovalRequests({ storageChannels: [CHANNEL] })
        .map((record) => record.id)
        .sort()
    ).toEqual([decided.id, cancelled.id, expired.id].sort());
    expect(listApprovalPartitions()).toEqual(
      expect.arrayContaining([partitionOf(TENANT_A), partitionOf(TENANT_B)])
    );

    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: decided.id,
      decision: 'rejected',
      decidedBy: 'operator',
    });
    cancelApprovalRequest('mission_controller', { channel: CHANNEL, requestId: cancelled.id });
    expireApprovalRequest('mission_controller', { channel: CHANNEL, requestId: expired.id });

    expect(loadApprovalRequest(CHANNEL, decided.id)?.status).toBe('rejected');
    expect(loadApprovalRequest(CHANNEL, cancelled.id)?.status).toBe('cancelled');
    expect(loadApprovalRequest(CHANNEL, expired.id)?.status).toBe('expired');
    // Each transition stays in its record's own partition and log.
    expect(exists(approvalRequestLogicalPath(CHANNEL, decided.id))).toBe(false);
    expect(
      eventLines(tenantApprovalEventLogicalPath(partitionOf(TENANT_A), CHANNEL), TENANT_A).map(
        (e) => e.event
      )
    ).toEqual(['approval_requested', 'approval_requested', 'rejected', 'cancelled']);
    expect(
      eventLines(tenantApprovalEventLogicalPath(partitionOf(TENANT_B), CHANNEL), TENANT_B).map(
        (e) => e.event
      )
    ).toEqual(['approval_requested', 'expired']);
    expect(eventLines(approvalEventLogicalPath(CHANNEL))).toEqual([]);
  });

  it("never shows a process bound to tenant A tenant B's record, nor lets it decide it", () => {
    const own = create({ tenant_slug: TENANT_A });
    const other = create({ tenant_slug: TENANT_B });
    asController(() => {
      expect(loadApprovalRequest(CHANNEL, other.id)).toBeNull();
      expect(
        loadApprovalRequest(CHANNEL, other.id, { scope: { tenant_slug: TENANT_B } })
      ).toBeNull();
      expect(listApprovalRequests({ storageChannels: [CHANNEL] }).map((r) => r.id)).toEqual([
        own.id,
      ]);
      expect(listApprovalPartitions()).toEqual([partitionOf(TENANT_A)]);
      expect(() =>
        decideApprovalRequest('mission_controller', {
          channel: CHANNEL,
          requestId: other.id,
          decision: 'approved',
          decidedBy: 'operator',
        })
      ).toThrow(/not found/u);
      // Its own tenant's record stays reachable.
      expect(
        decideApprovalRequest('mission_controller', {
          channel: CHANNEL,
          requestId: own.id,
          decision: 'rejected',
          decidedBy: 'operator',
        }).status
      ).toBe('rejected');
      // A bound process cannot create a request for another tenant either.
      expect(() => create({ tenant_slug: TENANT_B })).toThrow(/APPROVAL_TENANT_BINDING_CONFLICT/u);
    }, TENANT_A);
    expect(loadApprovalRequest(CHANNEL, other.id)?.status).toBe('pending');
    expect(listApprovalRequests({ storageChannels: [CHANNEL] })).toHaveLength(2);
  });

  it('keeps a legacy tenant record in the system tree readable and writes its transitions back in place', () => {
    const legacy = create({ tier: 'public' });
    const record: ApprovalRequestRecord = {
      ...legacy,
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT_A },
    };
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(CHANNEL, record.id),
      record
    );
    expect(locateApprovalRequest(CHANNEL, record.id)?.partition).toEqual({ kind: 'system' });
    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'rejected',
      decidedBy: 'operator',
    });
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('rejected');
    expect(exists(approvalRequestLogicalPath(CHANNEL, record.id))).toBe(true);
    expect(
      exists(tenantApprovalRequestLogicalPath(partitionOf(TENANT_A), CHANNEL, record.id))
    ).toBe(false);
    expect(eventLines(approvalEventLogicalPath(CHANNEL)).map((e) => e.event)).toEqual([
      'approval_requested',
      'rejected',
    ]);
  });

  it('refuses an id stored in two locations', () => {
    const record = create({ tenant_slug: TENANT_A });
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(CHANNEL, record.id),
      record
    );
    expect(() => loadApprovalRequest(CHANNEL, record.id)).toThrow(/APPROVAL_LOCATION_AMBIGUOUS/u);
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'operator',
      })
    ).toThrow(/APPROVAL_LOCATION_AMBIGUOUS/u);
  });

  it("refuses to write a record found in a partition that disagrees with the record's scope", () => {
    const record = create({ tenant_slug: TENANT_B });
    const misplaced = partitionOf(TENANT_A);
    writeApprovalJsonAt(
      'mission_controller',
      misplaced,
      tenantApprovalRequestLogicalPath(misplaced, CHANNEL, record.id),
      record
    );
    asController(() => {
      expect(() =>
        cancelApprovalRequest('mission_controller', { channel: CHANNEL, requestId: record.id })
      ).toThrow(/APPROVAL_LOCATION_MISMATCH/u);
    }, TENANT_A);
    asController(() => {
      expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
    }, TENANT_A);
  });

  it('probes only the named tenant when a list scope names one', () => {
    const own = create({ tenant_slug: TENANT_A });
    create({ tenant_slug: TENANT_B });
    // An unreadable record in tenant B's partition breaks a full listing...
    const broken = partitionOf(TENANT_B);
    asTenantApprovalStore(TENANT_B, () =>
      safeWriteFile(
        tenantApprovalRequestLogicalPath(broken, CHANNEL, '00000000-0000-4000-8000-000000000000'),
        '{ not json'
      )
    );
    // ...is skipped with a warning by a full listing (it never blinds the rest)...
    const lines: string[] = [];
    const capture = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    let all: string[];
    try {
      all = listApprovalRequests({ storageChannels: [CHANNEL] }).map((record) => record.id);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
    expect(all).toHaveLength(2);
    expect(all).toContain(own.id);
    const skipped = () =>
      lines.filter((line) => line.includes('approval request skipped in listing')).length;
    expect(skipped()).toBe(1);
    lines.length = 0;
    // ...and a listing scoped to tenant A never touches it.
    const stderr2 = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const stdout2 = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    let scoped: string[];
    try {
      scoped = listApprovalRequests({
        storageChannels: [CHANNEL],
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT_A },
      }).map((record) => record.id);
    } finally {
      stderr2.mockRestore();
      stdout2.mockRestore();
    }
    expect(scoped).toEqual([own.id]);
    expect(skipped()).toBe(0);
  });

  it('stores passkey challenges beside a tenant request', () => {
    const record = create({ tenant_slug: TENANT_A });
    const challenge = issueApprovalPasskeyChallenge('mission_controller', {
      record,
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'member-a',
      presentedDigest: computeApprovalPresentedDigest(record),
    });
    const dir = tenantApprovalPasskeyChallengesLogicalDir(partitionOf(TENANT_A), CHANNEL);
    expect(exists(`${dir}/${challenge.challenge_id}.json`)).toBe(true);
    expect(
      exists(
        `${approvalStoreRoots().coordination}/${CHANNEL}/approvals/passkey-challenges/${challenge.challenge_id}.json`
      )
    ).toBe(false);
    const claimed = claimApprovalPasskeyChallenge('mission_controller', {
      storageChannel: CHANNEL,
      challengeId: challenge.challenge_id,
      requestId: record.id,
      memberId: 'member-a',
      decision: 'approved',
    });
    expect(claimed.claimed_at).toBeTruthy();
    // A process bound to another tenant cannot find the challenge.
    asController(() => {
      expect(() =>
        claimApprovalPasskeyChallenge('mission_controller', {
          storageChannel: CHANNEL,
          challengeId: challenge.challenge_id,
          requestId: record.id,
          memberId: 'member-a',
          decision: 'approved',
        })
      ).toThrow(/unknown challenge/u);
    }, TENANT_B);
    expect(tenantApprovalPartitionLogicalRoot(partitionOf(TENANT_A))).toBe(
      `${approvalStoreRoots().tenantApprovals}/confidential/${TENANT_A}`
    );
  });
});

describe('approval store tenant partitions — review round 1', () => {
  afterEach(() => clearSessionApprovalCache());
  const events = (tenant: string) =>
    eventLines(tenantApprovalEventLogicalPath(partitionOf(tenant), CHANNEL), tenant).map(
      (e) => e.event
    );

  it("keeps a tenant record behind the caller role's own channel grant", () => {
    const onChannel = create({ tenant_slug: TENANT_A });
    const onSlack = create({ tenant_slug: TENANT_A }, { channel: 'slack' });
    try {
      const decide = (channel: string, id: string) =>
        decideApprovalRequest('slack_bridge', {
          channel,
          requestId: id,
          decision: 'rejected',
          decidedBy: 'user:approver',
        });
      // slack_bridge may not write another channel's approvals — tenant or system alike.
      expect(() => decide(CHANNEL, onChannel.id)).toThrow(/may not write this channel/u);
      expect(loadApprovalRequest(CHANNEL, onChannel.id)?.status).toBe('pending');
      // (A system record is judged on the same live channel grant; under Vitest the
      // system tree itself lives in the isolated root, which the runtime default admits.)
      // On its own channel it decides the tenant record as it would a system one.
      expect(decide('slack', onSlack.id).status).toBe('rejected');
      expect(() => create({ tenant_slug: TENANT_A }, { role: 'slack_bridge' })).toThrow(
        /may not write this channel/u
      );
    } finally {
      asController(() => {
        for (const root of [approvalStoreRoots().coordination, approvalStoreRoots().observability])
          safeRmSync(pathResolver.rootResolve(`${root}/slack`), { recursive: true, force: true });
      });
    }
  });

  it("hides another tenant's legacy system-tree record from a bound process", () => {
    const legacy: ApprovalRequestRecord = {
      ...create({ tier: 'public' }),
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT_B },
    };
    writeGovernedArtifactJson(
      'mission_controller',
      approvalRequestLogicalPath(CHANNEL, legacy.id),
      legacy
    );
    asController(() => {
      expect(loadApprovalRequest(CHANNEL, legacy.id)).toBeNull();
      expect(listApprovalRequests({ storageChannels: [CHANNEL] })).toEqual([]);
      expect(() =>
        decideApprovalRequest('mission_controller', {
          channel: CHANNEL,
          requestId: legacy.id,
          decision: 'approved',
          decidedBy: 'user:approver',
        })
      ).toThrow(/not found/u);
    }, TENANT_A);
    asController(
      () => expect(loadApprovalRequest(CHANNEL, legacy.id)?.id).toBe(legacy.id),
      TENANT_B
    );
    expect(loadApprovalRequest(CHANNEL, legacy.id)?.status).toBe('pending');
  });

  it('applies claim, apply result, consumption, revocation and annotation in the partition', () => {
    const applied = create({ tenant_slug: TENANT_A });
    const approve = (id: string) =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: id,
        decision: 'approved',
        decidedBy: 'user:approver',
      });
    const approved = approve(applied.id);
    const claimed = claimApprovalApply('mission_controller', {
      channel: CHANNEL,
      requestId: applied.id,
      appliedBy: 'user:approver',
      expectedRecordHash: computeApprovalPayloadHash({ record: approved }),
    });
    recordApprovalApplyResult('mission_controller', {
      channel: CHANNEL,
      requestId: applied.id,
      claimId: claimed.applyClaim.claimId,
      applyResult: { appliedAt: new Date().toISOString(), appliedBy: 'test', result: 'success' },
    });
    expect(loadApprovalRequest(CHANNEL, applied.id)?.applyResult?.result).toBe('success');

    const consumed = create({ tenant_slug: TENANT_A });
    approve(consumed.id);
    markApprovalConsumed('mission_controller', {
      channel: CHANNEL,
      requestId: consumed.id,
      consumer: 'test-consumer',
      consumedBy: 'user:approver',
    });
    expect(loadApprovalRequest(CHANNEL, consumed.id)?.consumption?.consumer).toBe('test-consumer');

    const revoked = create({ tenant_slug: TENANT_A });
    approve(revoked.id);
    revokeApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: revoked.id,
      revokedBy: 'user:approver',
    });
    expect(loadApprovalRequest(CHANNEL, revoked.id)?.revocation?.revokedBy).toBe('user:approver');

    const annotated = create({ tenant_slug: TENANT_A });
    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: annotated.id,
      decision: 'rejected',
      decidedBy: 'user:approver',
    });
    annotateApprovalRejectionReason('mission_controller', {
      channel: CHANNEL,
      requestId: annotated.id,
      reasonCategory: 'scope_wrong',
      annotatedBy: 'user:approver',
    });
    // Annotation (now under the record lock) never reverts the decision.
    expect(loadApprovalRequest(CHANNEL, annotated.id)?.status).toBe('rejected');

    for (const id of [applied.id, consumed.id, revoked.id, annotated.id])
      expect(exists(approvalRequestLogicalPath(CHANNEL, id))).toBe(false);
    expect(events(TENANT_A)).toEqual(
      expect.arrayContaining([
        'apply_started',
        'applied',
        'consumed',
        'revoked',
        'rejection_reason_captured',
      ])
    );
    expect(eventLines(approvalEventLogicalPath(CHANNEL))).toEqual([]);
  });

  it('runs veto-window transitions on the fresh tenant record under its lock', () => {
    const NOON = Date.parse('2026-09-28T03:00:00Z');
    const veto = (now: number) =>
      createApprovalRequest('mission_controller', {
        channel: CHANNEL,
        threadTs: '',
        correlationId: 'veto-tenant',
        requestedBy: 'agent:test',
        draft: { title: 'veto probe', summary: 'tenant veto window' },
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT_A },
        veto: buildVetoWindow({ windowMinutes: 60, now }),
      });
    const delivered = veto(NOON);
    expect(
      markApprovalNotificationDelivered('mission_controller', {
        storageChannel: CHANNEL,
        requestId: delivered.id,
        deliveredAt: new Date(NOON + 60_000).toISOString(),
      })?.veto?.deliveredAt
    ).toBe(new Date(NOON + 60_000).toISOString());

    const undelivered = veto(NOON);
    const fell = tickVetoWindows('mission_controller', {
      now: NOON + 120 * 60_000,
      storageChannels: [CHANNEL],
    });
    expect(fell.fellBack.map((r) => r.id)).toContain(undelivered.id);

    // A decided record is never flipped back by a late delivery receipt.
    const decided = veto(NOON);
    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: decided.id,
      decision: 'rejected',
      decidedBy: 'user:approver',
    });
    expect(
      markApprovalNotificationDelivered('mission_controller', {
        storageChannel: CHANNEL,
        requestId: decided.id,
        deliveredAt: new Date(NOON + 60_000).toISOString(),
      })?.status
    ).toBe('rejected');
    expect(events(TENANT_A)).toEqual(
      expect.arrayContaining(['notification_delivered', 'veto_window_fallback'])
    );
    expect(eventLines(approvalEventLogicalPath(CHANNEL))).toEqual([]);
  });

  it('verifies and consumes a passkey challenge in the tenant partition', () => {
    const record = create({ tenant_slug: TENANT_A });
    const presentedDigest = computeApprovalPresentedDigest(record);
    const issued = issueApprovalPasskeyChallenge('mission_controller', {
      record,
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'member-a',
      presentedDigest,
    });
    const claimed = claimApprovalPasskeyChallenge('mission_controller', {
      storageChannel: CHANNEL,
      challengeId: issued.challenge_id,
      requestId: record.id,
      memberId: 'member-a',
      decision: 'approved',
    });
    markApprovalPasskeyChallengeVerified('mission_controller', claimed, 'credential-1');
    const decided = decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      decidedBy: 'user:member-a',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'passkey',
      presentedDigest,
      passkeyChallengeId: issued.challenge_id,
    });
    expect(decided.decidedAuthMethod).toBe('passkey');
    const file = `${tenantApprovalPasskeyChallengesLogicalDir(partitionOf(TENANT_A), CHANNEL)}/${issued.challenge_id}.json`;
    const stored = asTenantApprovalStore(TENANT_A, () =>
      JSON.parse(String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' })))
    );
    expect(stored.verified_at).toBeTruthy();
    expect(stored.consumed_at).toBeTruthy();
    // A request this process cannot find never gets a challenge (no system-tree fallback).
    const other = create({ tenant_slug: TENANT_B });
    asController(() => {
      expect(() =>
        issueApprovalPasskeyChallenge('mission_controller', {
          record: other,
          storageChannel: CHANNEL,
          decision: 'approved',
          memberId: 'member-a',
          presentedDigest: computeApprovalPresentedDigest(other),
        })
      ).toThrow(/request not found/u);
    }, TENANT_A);
  });

  it('binds a session-cache grant to its tenant seed and re-reads the seed where it was stored', () => {
    const descriptor = { action: 'secret:set', targetClass: 'service:github' };
    const payloadHash = computeApprovalPayloadHash({ secret: 'approved' });
    const seed = createApprovalRequest('mission_controller', {
      channel: CHANNEL,
      threadTs: 'ts-cache',
      correlationId: 'corr-cache',
      requestedBy: 'worker:test',
      draft: { title: 'cache seed', summary: 'approve and cache' },
      scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT_A },
      accountability: { finalDecision: 'human_only', payloadHash, effectBinding: 'secret:set' },
    });
    // A standing grant needs a full-assurance (A3) human decision: a verified passkey.
    const stored = loadApprovalRequest(CHANNEL, seed.id)!;
    const presentedDigest = computeApprovalPresentedDigest(stored);
    const issued = issueApprovalPasskeyChallenge('mission_controller', {
      record: stored,
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'operator-a',
      presentedDigest,
    });
    markApprovalPasskeyChallengeVerified(
      'mission_controller',
      claimApprovalPasskeyChallenge('mission_controller', {
        storageChannel: CHANNEL,
        challengeId: issued.challenge_id,
        requestId: seed.id,
        memberId: 'operator-a',
        decision: 'approved',
      }),
      'credential-a'
    );
    const decidedSeed = decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: seed.id,
      decision: 'approved',
      decidedBy: 'user:operator-a',
      decidedByType: 'human',
      authMethod: 'passkey',
      authenticated: true,
      payloadHash,
      effectBinding: 'secret:set',
      presentedDigest,
      passkeyChallengeId: issued.challenge_id,
      sessionCache: descriptor,
    });
    const context = { agentId: 'worker:test', payloadHash, effectBinding: 'secret:set' };
    const entry = lookupSessionApprovalCache(descriptor, Date.now(), context);
    expect(decidedSeed.assuranceShortfall).toBeUndefined();
    expect(entry).not.toBeNull();
    expect(entry?.seedPartition).toEqual(partitionOf(TENANT_A));
    expect(entry?.tenantSlug).toBe(TENANT_A);
    expect(resolveSessionCacheSeed(entry!).status).toBe('found');
    // Another tenant's process neither gets the grant nor can trust its seed.
    asController(() => {
      expect(lookupSessionApprovalCache(descriptor, Date.now(), context)).toBeNull();
      expect(resolveSessionCacheSeed(entry!).status).toBe('unusable');
    }, TENANT_B);
    // The auto-approval event lands in the seed's tenant log, never the system log.
    recordSessionCacheAutoApproval('mission_controller', {
      entry: entry!,
      operationId: 'secret:set',
      agentId: 'worker:test',
      correlationId: 'corr-cache-2',
    });
    expect(events(TENANT_A)).toContain('auto_approved_via_session_cache');
    expect(eventLines(approvalEventLogicalPath(CHANNEL))).toEqual([]);
    // A tenant seed that is gone from its partition makes the grant unusable.
    asTenantApprovalStore(TENANT_A, () =>
      safeRmSync(
        pathResolver.rootResolve(
          tenantApprovalRequestLogicalPath(partitionOf(TENANT_A), CHANNEL, seed.id)
        ),
        { force: true }
      )
    );
    expect(resolveSessionCacheSeed(entry!).status).toBe('unusable');
  });

  it('warns and lists nothing for a tier directory it cannot read', () => {
    const tierDir = pathResolver.rootResolve(
      `${approvalStoreRoots().tenantApprovals}/confidential`
    );
    asController(() => safeRmSync(tierDir, { recursive: true, force: true }));
    asController(() => safeWriteFile(tierDir, 'not a directory'));
    const lines: string[] = [];
    const capture = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    try {
      expect(listApprovalPartitions().filter((p) => p.tier === 'confidential')).toEqual([]);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      asController(() => safeRmSync(tierDir, { force: true }));
    }
    expect(
      lines.some(
        (line) => line.includes('tenant approval partitions not listed') && line.includes('| next:')
      )
    ).toBe(true);
  });
});
