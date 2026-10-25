import { afterEach, describe, expect, it } from 'vitest';
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
} from './approval-passkey-challenge.js';

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
  options: { storageChannel?: string; tenantActive?: boolean } = {}
): ApprovalRequestRecord {
  return createApprovalRequest('mission_controller', {
    channel: CHANNEL,
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
    expect(approvalPartitionForScope(scope, { storageChannel: 'tenant-activation' })).toEqual({
      kind: 'system',
    });
    expect(
      approvalPartitionForScope(scope, { storageChannel: 'tenant-activation', tenantActive: false })
    ).toEqual({ kind: 'system' });
    expect(
      approvalPartitionForScope(scope, { storageChannel: 'tenant-activation', tenantActive: true })
    ).toEqual(partitionOf(TENANT_A));
    // Only the activation channel consults activation state.
    expect(approvalPartitionForScope(scope, { storageChannel: CHANNEL })).toEqual(
      partitionOf(TENANT_A)
    );

    const pending = create(
      { tenant_slug: TENANT_A },
      { storageChannel: 'tenant-activation', tenantActive: false }
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
    expect(() => listApprovalRequests({ storageChannels: [CHANNEL] })).toThrow();
    // ...but a listing scoped to tenant A never touches it.
    expect(
      listApprovalRequests({
        storageChannels: [CHANNEL],
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: TENANT_A },
      }).map((record) => record.id)
    ).toEqual([own.id]);
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
