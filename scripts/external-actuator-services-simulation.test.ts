/** Real actuator, engine, approval and reservation paths; only configuration and final wire are fake. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import { rootResolve } from '@agent/core/path-resolver';
import { withExternalOperationAuthority } from '@agent/core/governance/external-operation';
import { resolveScopeContext, resetCurrentScope } from '@agent/core/scope-context';
import {
  grantStanding,
  requestGrantApproval,
  GRANT_APPROVAL_CHANNEL,
} from '@agent/core/governance/grant-store';
import { approvalStoreRoots } from '@agent/core/governance/approval-store';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '@agent/core/storage-layout';
import { checkRecordingConsent } from '../libs/actuators/meeting-actuator/src/meeting-session.js';
import {
  simulationAuthority,
  captureSimulationApproval,
  approveSimulationRequest,
  cleanupSimulationApprovals,
} from '../tests/helpers/external-actuator-simulation.js';

const wire = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ ok: true, id: 'simulated-issue' })),
}));
vi.mock('@agent/core/network', async (original) => ({
  ...(await original<typeof import('@agent/core/network')>()),
  secureFetch: wire.fetch,
}));
vi.mock('@agent/core/service/service-preset-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/service/service-preset-registry')>()),
  getServicePresetRecord: (id: string) => ({
    service_id: id,
    operations: {
      create: {
        type: 'api',
        method: 'POST',
        path: 'issues',
        risk: 'write',
        payload_template: { title: '{{title}}' },
      },
    },
  }),
}));
vi.mock('@agent/core/service/service-endpoint-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/service/service-endpoint-registry')>()),
  loadServiceEndpointsCatalog: () => ({
    services: { simulation: { preset_path: 'simulation.json', base_url: 'https://example.com' } },
  }),
}));

import { handleAction as serviceAction } from '../libs/actuators/service-actuator/src/index.js';
import { handleAction as meetingAction } from '../libs/actuators/meeting-actuator/src/meeting-actuator-helpers.js';
import { registerMeetingJoinDriver } from '@agent/core/meeting/meeting-join-driver';
import type { MeetingSession } from '@agent/core/meeting/meeting-session-types';

const observations: Array<Record<string, unknown>> = [];
const fixturePaths: string[] = [];
afterAll(() => {
  const report = `active/shared/tmp/external-actuator-simulation/${randomUUID()}/services-report.json`;
  safeWriteFile(
    rootResolve(report),
    JSON.stringify(
      {
        simulation: true,
        real_governance_and_storage: true,
        mocked_boundary: 'service configuration and HTTP wire; registered meeting driver session',
        cases: observations,
      },
      null,
      2
    )
  );
  process.stdout.write(`SIMULATION_REPORT ${report}\n`);
  cleanupSimulationApprovals();
  for (const fixturePath of fixturePaths) safeRmSync(fixturePath, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetCurrentScope();
});

beforeAll(() => {
  vi.stubEnv('KYBERION_ALLOW_TEST_NOTIFICATIONS', '0');
  vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
});

describe('services and meeting real governance simulation', () => {
  it('real service engine sends one reviewed POST and fences replay', async () => {
    const authority = simulationAuthority('service', resolveScopeContext().tenant_slug);
    const execute = () =>
      serviceAction(
        {
          service_id: 'simulation',
          mode: 'PRESET',
          action: 'create',
          params: { title: 'Reviewed simulation' },
        },
        undefined,
        { externalAuthority: () => authority }
      );
    const pending = await captureSimulationApproval(execute);
    expect(wire.fetch).not.toHaveBeenCalled();
    approveSimulationRequest(pending);
    await execute();
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    expect(wire.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: 'https://example.com/issues' })
    );
    await expect(execute()).rejects.toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(wire.fetch).toHaveBeenCalledTimes(1);
    observations.push({
      actuator: 'service',
      approval_id: pending.id,
      transitions: ['pending', 'approved', 'one POST', 'replay blocked'],
      transport_calls: wire.fetch.mock.calls.length,
    });
  });

  it('registered meeting driver joins and leaves only after actual stored approval', async () => {
    const tenant = `sim-meeting-${randomUUID().slice(0, 8)}`;
    const meetingUrl = 'https://meet.google.com/abc-defg-hij';
    vi.stubEnv('KYBERION_TENANT', tenant);
    vi.stubEnv('KYBERION_TIER', 'confidential');
    vi.stubEnv('MISSION_ID', undefined);
    vi.stubEnv('KYBERION_SUDO', undefined);
    resetCurrentScope();
    fixturePaths.push(
      rootResolve(`${PARTITIONED_RUNTIME_STATE_ROOTS.grants}/confidential/${tenant}`),
      rootResolve(`customer/${tenant}`)
    );
    for (const root of Object.values(approvalStoreRoots()))
      fixturePaths.push(rootResolve(`${root}/${GRANT_APPROVAL_CHANNEL}`));
    // The consent and grant resolver remain real: begin denied, then create
    // only this unique fixture tenant's exact-URL grant through real approval.
    expect(checkRecordingConsent({ url: meetingUrl }).allowed).toBe(false);
    const grantDraft = {
      capability: 'meeting.recording',
      tenant_slug: tenant,
      meeting_urls: [meetingUrl],
      purpose: 'synthetic meeting simulation',
      ttl_days: 1,
    };
    const grantRequest = requestGrantApproval(grantDraft, {
      requester: { requestedBy: 'simulation-meeting-grant' },
    });
    approveSimulationRequest(grantRequest);
    const grant = grantStanding(grantDraft, { approvalRequestId: grantRequest.id });
    expect(checkRecordingConsent({ url: meetingUrl })).toMatchObject({
      allowed: true,
      grant_id: grant.grant_id,
    });
    const leave = vi.fn(async () => undefined);
    const join = vi.fn(async () => ({ leave }) as unknown as MeetingSession);
    const dispose = registerMeetingJoinDriver({
      driver_id: 'simulation-driver',
      supported_platforms: ['meet'],
      probe: async () => ({ available: true }),
      join,
    });
    try {
      const authority = simulationAuthority('meeting', resolveScopeContext().tenant_slug);
      const execute = () =>
        withExternalOperationAuthority(
          () => authority,
          () =>
            meetingAction({
              action: 'join',
              params: {
                platform: 'auto',
                url: 'https://meet.google.com/abc-defg-hij',
                join_backend: 'simulation-driver',
                duration_sec: 0,
              },
            })
        );
      const pending = await captureSimulationApproval(execute);
      expect(join).not.toHaveBeenCalled();
      approveSimulationRequest(pending);
      await execute();
      expect(join).toHaveBeenCalledTimes(1);
      expect(leave).toHaveBeenCalledTimes(1);
      await expect(execute()).rejects.toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
      expect(join).toHaveBeenCalledTimes(1);
      observations.push({
        actuator: 'meeting',
        approval_id: pending.id,
        recording_consent: {
          real_resolver: true,
          grant_id: grant.grant_id,
          approval_id: grantRequest.id,
          scope: { tenant_slug: tenant, meeting_urls: [meetingUrl] },
          denied_before_grant: true,
        },
        transitions: [
          'recording denied before grant',
          'recording grant approved and resolved',
          'pending',
          'approved',
          'one join and leave',
          'replay blocked',
        ],
        join_calls: join.mock.calls.length,
      });
    } finally {
      dispose();
    }
  });
});
