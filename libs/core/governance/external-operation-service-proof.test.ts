import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ execute: vi.fn(async () => ({ ok: true })) }));
vi.mock('../service/service-endpoint-registry.js', () => ({
  loadServiceEndpointsCatalog: () => ({
    services: { 'proof-service': { preset_path: 'fixture', base_url: 'https://provider.invalid' } },
  }),
}));
vi.mock('../service/service-preset-registry.js', () => ({
  getServicePresetRecord: () => ({
    operations: { assign: { type: 'api', method: 'POST', risk: 'write' } },
  }),
}));
vi.mock('../service/service-binding.js', () => ({
  resolveServiceBinding: () => ({ authMode: 'none' }),
}));
vi.mock('../service/service-binding-registry.js', () => ({
  listServiceBindingRecords: () => [],
  authorizeTenantServiceAction: () => ({ approvalRequired: false }),
}));
vi.mock('../service/service-engine-helpers.js', async (original) => ({
  ...(await original<typeof import('../service/service-engine-helpers.js')>()),
  loadConnectionWithFallback: () => ({}),
}));
vi.mock('../service/service-engine.js', () => ({
  executeServicePreset: transport.execute,
  executeMcp: vi.fn(),
}));
vi.mock('../service/service-harness.js', async (original) => ({
  ...(await original<typeof import('../service/service-harness.js')>()),
  describeServiceHarness: () => ({
    operations: [{ action: 'assign', risk: 'write', approval_required: true }],
  }),
}));
vi.mock('../surface/operator-notifications.js', () => ({ notifyOperator: vi.fn() }));

import { rootResolve } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { humanActor } from '../actor.js';
import {
  acceptCharter,
  readCharterLedger,
  retireCharter,
} from './accountability-charter-registry.js';
import {
  runDelegatedExecution,
  withDelegatedExecutionOptions,
  delegatedExecutionBindingHash,
  type DelegatedExecutionTarget,
  type DelegatedExecutionPolicy,
} from './delegated-execution.js';
import { runHumanExecutionAuthorization } from './human-execution.js';
import {
  createApprovalRequest,
  decideApprovalRequest,
  claimApprovalApply,
  computeApprovalPayloadHash,
  approvalStoreRoots,
  listApprovalRequests,
} from './approval-store.js';
import { handleAction } from '../../actuators/service-actuator/src/service-actuator-helpers.js';
import { admitExternalOperation } from './external-operation.js';

describe('existing main service proof satisfies shared external admission exactly once', () => {
  let root: string;
  let charter: ReturnType<typeof acceptCharter>;
  let target: DelegatedExecutionTarget;
  let channels: string[];
  const policy: DelegatedExecutionPolicy = {
    version: '1',
    operations: [
      {
        operation_id: 'service:preset:proof-service:assign',
        decision_type: 'internal_task_assignment',
        required_paths: [['request', 'summary']],
        risk_level: 'low',
        max_ttl_seconds: 600,
      },
    ],
  };
  const action = (summary = 'Reviewed assignment') => ({
    service_id: 'proof-service',
    mode: 'PRESET' as const,
    action: 'assign',
    params: { summary },
  });
  const options = () => ({ rootDir: root, policy });
  beforeEach(() => {
    vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    root = rootResolve(`active/shared/tmp/external-proof-${randomUUID()}`);
    channels = [];
    target = {
      operationId: 'service:preset:proof-service:assign',
      params: { request: action().params, auth: 'none' },
      tenantSlug: 'service-proof',
      agentId: 'worker',
      source: { taskId: randomUUID() },
      stepId: 'assign',
      correlationId: randomUUID(),
    };
    charter = acceptCharter(
      {
        draft: {
          charter_id: `chr-${randomUUID()}`,
          scope: { kind: 'organization', tenant_slug: target.tenantSlug },
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'fixture' },
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: {},
            delegated_decisions: { internal_task_assignment: 'allow' },
            irreversible: 'forbid',
            supersedes_decision_rights: true,
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'D',
            blast_radius_max: { recipients: 5, systems: 5 },
            tripwires: [],
          },
        },
        statement: 'I accept accountability for this fixture.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
      },
      options()
    );
  });
  afterEach(() => {
    const roots = approvalStoreRoots();
    for (const channel of [...channels, 'external-operation'])
      for (const base of Object.values(roots))
        safeRmSync(rootResolve(`${base}/${channel}`), { recursive: true, force: true });
    safeRmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('reuses a real delegated permit without requesting or consuming another approval', async () => {
    await withDelegatedExecutionOptions(options(), async () => {
      await expect(runDelegatedExecution(target, () => handleAction(action()))).resolves.toEqual({
        ok: true,
      });
      await expect(runDelegatedExecution(target, () => handleAction(action()))).rejects.toThrow();
    });
    expect(transport.execute).toHaveBeenCalledTimes(1);
    expect(listApprovalRequests({ storageChannels: ['external-operation'] })).toHaveLength(0);
    expect(
      readCharterLedger(charter, options()).filter((entry) => entry.kind === 'consumption')
    ).toHaveLength(1);
  });
  it('establishes the mapped handler proof before common admission without a runtime resolver', async () => {
    await withDelegatedExecutionOptions(
      {
        ...options(),
        workItem: { id: randomUUID(), tenantSlug: target.tenantSlug, agentId: 'worker' },
      },
      async () => {
        await expect(handleAction(action())).resolves.toEqual({ ok: true });
        await expect(handleAction(action())).rejects.toThrow();
      }
    );
    expect(transport.execute).toHaveBeenCalledTimes(1);
    expect(listApprovalRequests({ storageChannels: ['external-operation'] })).toHaveLength(0);
    expect(
      readCharterLedger(charter, options()).filter((entry) => entry.kind === 'consumption')
    ).toHaveLength(1);
  });
  it('rejects a different payload inside an active delegated context without prompting', async () => {
    await withDelegatedExecutionOptions(options(), () =>
      runDelegatedExecution(target, async () => {
        expect(() =>
          admitExternalOperation({
            operationId: 'service:proof-service:preset:assign',
            effect: action('changed'),
            requiresApproval: true,
          })
        ).toThrow('EXTERNAL_EXECUTION_PROOF_MISMATCH');
        expect(() =>
          admitExternalOperation({
            operationId: 'service:proof-service:preset:assign',
            effect: { ...action(), auth: 'secret-guard' },
            requiresApproval: true,
          })
        ).toThrow('EXTERNAL_EXECUTION_PROOF_MISMATCH');
        expect(() =>
          admitExternalOperation({
            operationId: 'service:proof-service:preset:assign',
            effect: action(),
            requiresApproval: true,
            authority: {
              agentId: 'worker',
              tenantSlug: 'different-tenant',
              invocationId: 'foreign',
            },
          })
        ).toThrow('EXTERNAL_SCOPE_MISMATCH');
      })
    );
    expect(transport.execute).not.toHaveBeenCalled();
    expect(listApprovalRequests({ storageChannels: ['external-operation'] })).toHaveLength(0);
  });
  it('rejects revoked delegated proof without a new prompt or provider call', async () => {
    await withDelegatedExecutionOptions(options(), () =>
      runDelegatedExecution(target, async () => {
        retireCharter(charter, humanActor('owner'), 'fixture revocation', options());
        await expect(handleAction(action())).rejects.toThrow();
      })
    );
    expect(transport.execute).not.toHaveBeenCalled();
    expect(listApprovalRequests({ storageChannels: ['external-operation'] })).toHaveLength(0);
  });
  it('retains real human provenance and apply claim without inventing charter consumption', async () => {
    const channel = `proof-human-${randomUUID()}`;
    channels.push(channel);
    const binding = delegatedExecutionBindingHash(target);
    const record = createApprovalRequest('mission_controller', {
      channel,
      threadTs: 'fixture',
      correlationId: randomUUID(),
      requestedBy: 'requester',
      kind: 'mission_gate',
      scope: { tier: 'confidential', tenant_slug: target.tenantSlug },
      requestedByContext: {
        surface: 'system',
        actorId: 'requester',
        actorRole: 'pipeline',
        executionBindingHash: binding,
      },
      accountability: {
        finalDecision: 'human_only',
        payloadHash: binding,
        effectBinding: `service:${binding}`,
      },
      draft: { title: 'Reviewed assignment', summary: 'Exact original effect' },
    });
    const approved = decideApprovalRequest('mission_controller', {
      channel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: 'human-owner',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      payloadHash: binding,
      effectBinding: `service:${binding}`,
    });
    const claimed = claimApprovalApply('mission_controller', {
      channel,
      requestId: record.id,
      appliedBy: target.agentId,
      expectedRecordHash: computeApprovalPayloadHash({ record: approved }),
    });
    await expect(
      runHumanExecutionAuthorization(
        target,
        { channel, requestId: record.id, claimId: claimed.applyClaim.claimId },
        async () => {
          const result = await handleAction(action());
          await expect(handleAction(action())).rejects.toThrow(
            'EXTERNAL_EXECUTION_ALREADY_RESERVED'
          );
          return result;
        }
      )
    ).resolves.toEqual({ ok: true });
    expect(transport.execute).toHaveBeenCalledTimes(1);
    expect(listApprovalRequests({ storageChannels: ['external-operation'] })).toHaveLength(0);
    expect(
      readCharterLedger(charter, options()).filter(
        (entry) => entry.kind === 'consumption' || entry.kind === 'delegated_execution'
      )
    ).toHaveLength(0);
  });
});
