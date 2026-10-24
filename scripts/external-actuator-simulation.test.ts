/** Real calendar actuator/registry + admission + approval store + durable
 * reservation + charter ledger. Only the last provider transport is simulated. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('@agent/core/surface/operator-notifications', () => ({ notifyOperator: vi.fn() }));

import { safeWriteFile } from '@agent/core/secure-io';
import { rootResolve } from '@agent/core/path-resolver';
import { humanActor } from '@agent/core/actor';
import {
  withExternalOperationAuthority,
  withOperationArgumentOrigins,
} from '@agent/core/governance/external-operation';
import {
  loadApprovalRequest,
  computeApprovalPayloadHash,
} from '@agent/core/governance/approval-store';
import {
  acceptCharter,
  findActiveCharter,
  readCharterLedger,
} from '@agent/core/governance/accountability-charter-registry';
import { charterInputForDecision } from '@agent/core/governance/charter-call-site';
import { CalendarBackendRegistry } from '../libs/actuators/calendar-actuator/src/calendar-backend.js';
import {
  captureSimulationApproval,
  approveSimulationRequest,
  simulationAuthority,
  cleanupSimulationApprovals,
} from '../tests/helpers/external-actuator-simulation.js';

const job = randomUUID();
const reportRelativePath = `active/shared/tmp/external-actuator-simulation/${job}/report.json`;
const fixtureRoot = rootResolve(`active/shared/tmp/external-actuator-simulation/${job}/charters`);
const results: Array<Record<string, unknown>> = [];

describe('external calendar actuator real governance simulation', () => {
  let totalTransportCalls = 0;
  const transport = vi.fn(async () => ({
    status: 'success',
    title: 'simulated calendar event',
    id: randomUUID(),
  }));
  const registry = new CalendarBackendRegistry([
    {
      id: 'simulation',
      isAvailable: () => true,
      unavailableMessage: () => 'simulation transport unavailable',
      listCalendars: async () => [],
      listEvents: async () => [],
      queryFreeBusy: async () => [],
      createEvent: async () => {
        totalTransportCalls += 1;
        return transport();
      },
    },
  ]);
  const params = {
    title: 'Reviewed meeting',
    calendar_id: 'simulated-calendar',
    start_date: '2026-10-22T09:00:00Z',
  };
  beforeAll(() => {
    vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
  });
  afterAll(() => {
    safeWriteFile(
      rootResolve(reportRelativePath),
      JSON.stringify(
        {
          simulation: 'real calendar registry and governance; final provider transport simulated',
          generated_at: new Date().toISOString(),
          cases: results,
          transport_calls_total: totalTransportCalls,
        },
        null,
        2
      )
    );
    process.stdout.write(`SIMULATION_REPORT ${reportRelativePath}\n`);
    cleanupSimulationApprovals();
    vi.unstubAllEnvs();
  });

  it('persists pending, approves reviewed effect, sends once, then blocks replay', async () => {
    const authority = simulationAuthority('calendar-human');
    const run = () =>
      withExternalOperationAuthority(
        () => authority,
        () => registry.resolve('simulation').createEvent(params)
      );
    const before = transport.mock.calls.length;
    const pending = await captureSimulationApproval(run);
    expect(pending.status).toBe('pending');
    expect(transport).toHaveBeenCalledTimes(before);
    const approved = approveSimulationRequest(pending);
    expect(approved.status).toBe('approved');
    expect(loadApprovalRequest(pending.channel, pending.id)?.status).toBe('approved');
    await expect(run()).resolves.toMatchObject({ status: 'success' });
    expect(transport).toHaveBeenCalledTimes(before + 1);
    await expect(run()).rejects.toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(transport).toHaveBeenCalledTimes(before + 1);
    results.push({
      case: 'human-approval-and-replay',
      request_id: pending.id,
      states: ['pending', 'approved', 'executed', 'replay_blocked'],
      transport_calls: 1,
    });
  });

  it('rejects changing approved payload before the first provider call', async () => {
    const authority = simulationAuthority('calendar-edited');
    const run = (title: string) =>
      withExternalOperationAuthority(
        () => authority,
        () => registry.get('simulation').createEvent({ ...params, title })
      );
    const before = transport.mock.calls.length;
    const pending = await captureSimulationApproval(() => run('Reviewed original'));
    approveSimulationRequest(pending);
    await expect(run('Unreviewed replacement')).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(transport).toHaveBeenCalledTimes(before);
    results.push({
      case: 'changed-payload',
      request_id: pending.id,
      result: 'blocked',
      transport_calls: 0,
    });
  });

  it('does not retry an ambiguous provider effect and cannot replay its invocation', async () => {
    const authority = simulationAuthority('calendar-unknown');
    const run = () =>
      withExternalOperationAuthority(
        () => authority,
        () => registry.get('simulation').createEvent(params)
      );
    const before = transport.mock.calls.length;
    const pending = await captureSimulationApproval(run);
    approveSimulationRequest(pending);
    transport.mockRejectedValueOnce(
      new Error('simulation response lost after provider accepted event')
    );
    await expect(run()).rejects.toThrow('EXTERNAL_RESULT_UNVERIFIED');
    await expect(run()).rejects.toThrow('EXTERNAL_EXECUTION_ALREADY_RESERVED');
    expect(transport).toHaveBeenCalledTimes(before + 1);
    results.push({
      case: 'unknown-provider-result',
      request_id: pending.id,
      result: 'verification_required_replay_blocked',
      transport_calls: 1,
    });
  });

  it('uses a real accepted charter unattended, then stops after a failure tripwire', async () => {
    const tenant = `simulation-${job.slice(0, 8)}`;
    const scope = { kind: 'organization' as const, tenant_slug: tenant };
    const pathOptions = { rootDir: fixtureRoot };
    const now = new Date();
    acceptCharter(
      {
        draft: {
          charter_id: `chr-${job}`,
          scope,
          accountable: {
            actor: 'user:simulation-owner',
            authority_basis: { kind: 'officer', evidence_ref: 'simulation-fixture' },
            expires_at: new Date(now.getTime() + 86400000).toISOString(),
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: { send_message_external: 'allow' },
            irreversible: 'named_actions_only',
            irreversible_named_actions: ['meeting_scheduling'],
            delegated_decisions: { meeting_scheduling: 'allow' },
            supersedes_decision_rights: true,
            information_flow: {
              purposes: ['simulation_calendar'],
              recipient_classes: ['known_counterparty'],
              categories: ['routine_business'],
              max_attachments: 0,
            },
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'B',
            blast_radius_max: { recipients: 1, systems: 1 },
            tripwires: ['external_operation_failure'],
          },
        },
        statement: 'Simulation human accepts accountability for fixture actions only.',
        acceptedBy: humanActor('simulation-owner'),
        validation: { holder_role: 'owner' },
        now,
      },
      pathOptions
    );
    const charterInput = charterInputForDecision(
      {
        tenantSlug: tenant,
        agentId: 'calendar-worker',
        decisionType: 'meeting_scheduling',
        recipients: 1,
        informationFlow: {
          purpose: 'simulation_calendar',
          recipient_class: 'known_counterparty',
          categories: ['routine_business'],
          attachment_count: 0,
        },
      },
      pathOptions
    );
    expect(charterInput).toBeDefined();
    const runUnattested = () =>
      withExternalOperationAuthority(
        () => ({
          ...simulationAuthority('calendar-charter', tenant),
          hasHuman: false,
          charter: charterInput,
        }),
        () => registry.get('simulation').createEvent(params)
      );
    // This fixture host selected both the backend and the reviewed calendar
    // parameters. A decision-type charter alone cannot supply their origins.
    const run = () =>
      withOperationArgumentOrigins(
        [
          {
            path: [],
            value_hash: computeApprovalPayloadHash({ value: { backend: 'simulation', params } }),
            authority: 'policy',
          },
        ],
        runUnattested
      );
    const before = transport.mock.calls.length;
    await expect(runUnattested()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(transport).toHaveBeenCalledTimes(before);
    await expect(run()).resolves.toMatchObject({ status: 'success' });
    transport.mockResolvedValueOnce({
      status: 'error',
      title: 'simulated provider rejection',
      id: randomUUID(),
    });
    await run();
    await expect(run()).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(transport).toHaveBeenCalledTimes(before + 2);
    const charter = findActiveCharter(scope, new Date(), pathOptions);
    expect(charter).not.toBeNull();
    const ledger = readCharterLedger(charter!, pathOptions);
    expect(
      ledger.some((entry) => entry.kind === 'execution_outcome' && entry.outcome === 'failed')
    ).toBe(true);
    results.push({
      case: 'charter-autonomy-and-tripwire',
      charter_id: charter!.charter_id,
      result: 'unattended_allowed_then_tripwire_blocked',
      transport_calls: 2,
      ledger_events: ledger.map((entry) => entry.kind),
    });
  });
});
