import { describe, expect, it, vi } from 'vitest';
import {
  computeApprovalPresentedDigest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { resolveApprovalTenant, resolveApprovalTenantSource } from './su-surface-data';

const missionTenants = vi.hoisted(() => new Map<string, string>());

vi.mock('@agent/core/path-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/path-resolver')>();
  return {
    ...actual,
    findMissionPath: (missionId: string) =>
      missionTenants.has(missionId) ? `/missions/${missionId}` : null,
  };
});

vi.mock('@agent/core/mission/mission-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/mission/mission-state')>();
  return {
    ...actual,
    loadState: (missionId: string) => ({ tenant_slug: missionTenants.get(missionId) }),
  };
});

const base: ApprovalRequestRecord = {
  id: 'approval-tenant-1',
  kind: 'channel-approval',
  storageChannel: 'chronos',
  channel: 'chronos',
  threadTs: '1',
  correlationId: 'corr-1',
  requestedBy: 'agent:planner',
  requestedAt: '2026-10-10T00:00:00.000Z',
  status: 'pending',
  title: 'Rotate key',
  summary: 'Rotate the service key.',
  requestedByContext: {
    surface: 'chronos',
    actorId: 'agent:planner',
    actorRole: 'planner',
    missionId: 'MSN-TENANT',
  },
};

function tenantScope(tenant: string): ApprovalRequestRecord['scope'] {
  return { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant };
}

function withRequesterTenant(
  record: ApprovalRequestRecord,
  key: 'tenant_slug' | 'tenantSlug',
  tenant: string
): ApprovalRequestRecord {
  const requestedByContext = { ...record.requestedByContext!, [key]: tenant };
  return { ...record, requestedByContext };
}

function withLoopTenant(record: ApprovalRequestRecord, tenant: string): ApprovalRequestRecord {
  const workLoop = {
    intent: { label: 'rotate' },
    context: { tier: 'confidential' as const, service_bindings: [], tenant_slug: tenant },
  };
  return { ...record, work_loop: workLoop as unknown as ApprovalRequestRecord['work_loop'] };
}

describe('approval tenant resolution (Chronos approvals workspace)', () => {
  it('prefers the request scope and labels a mission-state tenant as off-record', () => {
    missionTenants.set('MSN-TENANT', 'tenant-mission');
    expect(resolveApprovalTenantSource(base)).toEqual({
      tenantSlug: 'tenant-mission',
      source: 'mission',
    });
    const scoped = withLoopTenant(
      withRequesterTenant(
        { ...base, scope: tenantScope('tenant-scope') },
        'tenant_slug',
        'tenant-requester'
      ),
      'tenant-loop'
    );
    expect(resolveApprovalTenantSource(scoped)).toEqual({
      tenantSlug: 'tenant-scope',
      source: 'record',
    });
    expect(resolveApprovalTenant(scoped)).toBe('tenant-scope');
  });

  it('reads the tenant only from fields the presented digest covers', () => {
    missionTenants.clear();
    const variants: Array<[string, (tenant: string) => ApprovalRequestRecord]> = [
      ['scope', (tenant) => ({ ...base, scope: tenantScope(tenant) })],
      ['requester tenant_slug', (tenant) => withRequesterTenant(base, 'tenant_slug', tenant)],
      ['requester tenantSlug', (tenant) => withRequesterTenant(base, 'tenantSlug', tenant)],
      ['work loop', (tenant) => withLoopTenant(base, tenant)],
    ];
    for (const [label, build] of variants) {
      const shown = build('tenant-a');
      const changed = build('tenant-b');
      expect(resolveApprovalTenantSource(shown), label).toEqual({
        tenantSlug: 'tenant-a',
        source: 'record',
      });
      expect(computeApprovalPresentedDigest(changed), label).not.toBe(
        computeApprovalPresentedDigest(shown)
      );
    }
  });
});
