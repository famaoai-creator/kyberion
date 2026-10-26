/** cleanupSimulationApprovals clears the system tree AND the tenant partitions. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createApprovalRequest,
  locateApprovalRequest,
} from '@agent/core/governance/approval-store';
import { resetCurrentScope } from '@agent/core/scope-context';
import { cleanupSimulationApprovals } from './external-actuator-simulation.js';

function request(channel: string, scope?: { tenant_slug: string; tier: 'confidential' }) {
  return createApprovalRequest('mission_controller', {
    channel,
    threadTs: `ts-${randomUUID()}`,
    correlationId: `corr-${randomUUID()}`,
    requestedBy: 'worker:simulation-cleanup-test',
    draft: { title: 'simulation cleanup', summary: 'cleanup regression fixture' },
    ...(scope ? { scope } : {}),
  });
}

describe('cleanupSimulationApprovals', () => {
  afterEach(() => {
    cleanupSimulationApprovals({ channels: ['external-operation', 'terminal'] });
    vi.unstubAllEnvs();
    resetCurrentScope();
  });

  it('removes tenant-partition and system external-operation requests, keeping other channels', () => {
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    vi.stubEnv('KYBERION_TENANT', undefined);
    resetCurrentScope();
    const scope = { tenant_slug: 'sim-x', tier: 'confidential' as const };
    const tenantRequest = request('external-operation', scope);
    const systemRequest = request('external-operation');
    const otherChannel = request('terminal', scope);

    expect(locateApprovalRequest('external-operation', tenantRequest.id)?.partition.kind).toBe(
      'tenant'
    );
    expect(locateApprovalRequest('external-operation', systemRequest.id)?.partition.kind).toBe(
      'system'
    );

    cleanupSimulationApprovals();

    expect(locateApprovalRequest('external-operation', tenantRequest.id)).toBeNull();
    expect(locateApprovalRequest('external-operation', systemRequest.id)).toBeNull();
    expect(locateApprovalRequest('terminal', otherChannel.id)?.partition.kind).toBe('tenant');
  });
});
