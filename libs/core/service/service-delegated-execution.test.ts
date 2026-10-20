import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanActor } from '../actor.js';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { acceptCharter, readCharterLedger } from '../governance/accountability-charter-registry.js';
import {
  authorizeDelegatedExecution,
  currentDelegatedExecution,
  runDelegatedExecution,
  verifyDelegatedExecution,
  withDelegatedExecutionOptions,
  type DelegatedExecutionPolicy,
  type DelegatedExecutionTarget,
  delegatedExecutionBindingHash,
} from '../governance/delegated-execution.js';
import {
  currentHumanExecutionAuthorization,
  runHumanExecutionAuthorization,
} from '../governance/human-execution.js';
import {
  createApprovalRequest,
  decideApprovalRequest,
  claimApprovalApply,
  computeApprovalPayloadHash,
  approvalStoreRoots,
} from '../governance/approval-store.js';
import { issueTenantServiceEngineAdmission } from './service-engine-admission.js';
import { executeServicePreset } from './service-engine.js';

const mock = vi.hoisted(() => ({
  config: { preset_path: 'fixture', base_url: 'https://provider.example' },
  preset: {
    tenant_binding_required: true,
    operations: {
      assign: {
        type: 'api',
        method: 'POST',
        risk: 'write',
        payload_template: { summary: '{{summary}}' },
      },
    },
  },
  account: 'account-1',
  execute: vi.fn(async () => ({ result: { created: true } })),
}));
vi.mock('./service-endpoint-registry.js', () => ({
  loadServiceEndpointsCatalog: () => ({ services: { 'test-service': mock.config } }),
}));
vi.mock('./service-preset-registry.js', () => ({ getServicePresetRecord: () => mock.preset }));
vi.mock('./service-binding.js', () => ({
  resolveServiceBinding: () => ({
    authMode: 'none',
    accessToken: 'hidden-credential',
    serviceId: 'test-service',
  }),
}));
vi.mock('./service-binding-registry.js', () => ({
  authorizeTenantServiceAction: () => ({ bindingId: 'binding-1', approvalRequired: true }),
  listServiceBindingRecords: () => [
    {
      binding_id: 'binding-1',
      tenant_slug: 'service-delegation',
      service_id: 'test-service',
      target: mock.account,
    },
  ],
}));
vi.mock('./service-engine-helpers.js', async (original) => ({
  ...(await original<typeof import('./service-engine-helpers.js')>()),
  loadConnectionWithFallback: () => ({ account: mock.account }),
}));
vi.mock('./service-engine-execution.js', () => ({ executeServicePresetAlternative: mock.execute }));
vi.mock('../governance/approval-policy.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-policy.js')>()),
  resolveApprovalPolicy: () => ({ requiresApproval: false, missingRequirements: [] }),
}));
vi.mock('../decision-rights.js', () => ({
  resolveDecisionRightsMatrix: () => ({}),
  evaluateDecisionRights: () => null,
}));

describe('real service engine delegated admission', () => {
  let root: string;
  let charter: ReturnType<typeof acceptCharter>;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let humanChannels: string[];
  const scope = { kind: 'organization', tenant_slug: 'service-delegation' } as const;
  const target: DelegatedExecutionTarget = {
    operationId: 'service:preset:test-service:assign',
    params: { request: { summary: 'Assign internal work' }, auth: 'none' },
    tenantSlug: scope.tenant_slug,
    agentId: 'worker',
    source: { taskId: 'task-only' },
    stepId: 'assign',
    correlationId: 'work-item-1',
  };
  const policy: DelegatedExecutionPolicy = {
    version: '1',
    operations: [
      {
        operation_id: target.operationId,
        decision_type: 'internal_task_assignment',
        required_paths: [['request', 'summary']],
        risk_level: 'low',
        max_ttl_seconds: 600,
      },
    ],
  };
  const opts = () => ({ rootDir: root, policy });
  beforeEach(() => {
    humanChannels = [];
    root = path.join(pathResolver.rootDir(), 'active/shared/tmp', `service-permit-${randomUUID()}`);
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    mock.config.base_url = 'https://provider.example';
    mock.account = 'account-1';
    mock.execute.mockClear();
    mock.preset.operations.assign.method = 'POST';
    charter = acceptCharter(
      {
        draft: {
          charter_id: 'chr-service-permit',
          scope,
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry' },
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: {},
            delegated_decisions: { internal_task_assignment: 'allow' },
            irreversible: 'forbid',
          },
          appetite: {
            max_loss_per_incident: 0,
            reputational_class_max: 'D',
            blast_radius_max: { recipients: 5, systems: 5 },
            tripwires: [],
          },
        },
        statement: 'I accept.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
      },
      { rootDir: root }
    );
  });
  afterEach(() => {
    const roots = approvalStoreRoots();
    for (const channel of humanChannels) {
      safeRmSync(path.resolve(pathResolver.rootDir(), roots.coordination, channel), {
        recursive: true,
        force: true,
      });
      safeRmSync(path.resolve(pathResolver.rootDir(), roots.observability, channel), {
        recursive: true,
        force: true,
      });
    }
    safeRmSync(root, { recursive: true, force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('admits an exact operation without inventing a human approval and executes once', async () => {
    await withDelegatedExecutionOptions(opts(), async () => {
      const result = await runDelegatedExecution(target, async () => {
        const delegated = currentDelegatedExecution(target.operationId, target.params)!;
        const admission = issueTenantServiceEngineAdmission({
          securityScope: {
            tenant_slug: scope.tenant_slug,
            mission_id: '',
            task_id: 'task-only',
            read_tiers: ['confidential'],
            write_tier: 'confidential',
            purpose: 'internal work',
          },
          bindingId: 'binding-1',
          approvalGranted: false,
          delegated,
        });
        return executeServicePreset(
          'test-service',
          'assign',
          target.params.request,
          'none',
          undefined,
          admission
        );
      });
      expect(result).toEqual({ created: true });
      await expect(runDelegatedExecution(target, async () => 'duplicate')).rejects.toThrow(
        'replay'
      );
    });
    expect(mock.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(readCharterLedger(charter, { rootDir: root }))).not.toContain(
      'hidden-credential'
    );
  });

  it('invalidates issued authority when endpoint, preset template or provider account changes', () => {
    withDelegatedExecutionOptions(opts(), () => {
      const permitId = authorizeDelegatedExecution(target).permitId!;
      expect(verifyDelegatedExecution({ ...target, permitId })).toBe(true);
      mock.config.base_url = 'https://changed.example';
      expect(verifyDelegatedExecution({ ...target, permitId })).toBe(false);
      mock.config.base_url = 'https://provider.example';
      mock.preset.operations.assign.method = 'DELETE';
      expect(verifyDelegatedExecution({ ...target, permitId })).toBe(false);
      mock.preset.operations.assign.method = 'POST';
      mock.account = 'account-2';
      expect(verifyDelegatedExecution({ ...target, permitId })).toBe(false);
    });
  });

  it('rejects a mutated actual request at the real engine boundary', async () => {
    await withDelegatedExecutionOptions(opts(), async () => {
      await expect(
        runDelegatedExecution(target, () =>
          executeServicePreset(
            'test-service',
            'assign',
            { summary: 'different actual effect' },
            'none',
            undefined,
            issueTenantServiceEngineAdmission({
              securityScope: {
                tenant_slug: scope.tenant_slug,
                mission_id: '',
                read_tiers: ['confidential'],
                write_tier: 'confidential',
                purpose: 'work',
              },
              bindingId: 'binding-1',
              approvalGranted: false,
              delegated: currentDelegatedExecution(target.operationId, target.params)!,
            })
          )
        )
      ).rejects.toThrow('Actual service operation/payload');
    });
    expect(mock.execute).not.toHaveBeenCalled();
  });

  it('consumes a real strong human approval through the opaque service admission without minting a charter permit', async () => {
    const binding = delegatedExecutionBindingHash(target);
    const effectBinding = `service-effect:${binding}`;
    const channel = `human-service-${randomUUID()}`;
    humanChannels.push(channel);
    const request = createApprovalRequest('mission_controller', {
      channel,
      threadTs: 'work-1',
      correlationId: `human:${randomUUID()}`,
      requestedBy: 'requesting-agent',
      kind: 'mission_gate',
      scope: { tier: 'confidential', tenant_slug: scope.tenant_slug },
      requestedByContext: {
        surface: 'system',
        actorId: 'requesting-agent',
        actorRole: 'pipeline',
        pipelineRunId: 'run-original',
        targetStepId: 'assign',
        executionBindingHash: binding,
      },
      accountability: { finalDecision: 'human_only', payloadHash: binding, effectBinding },
      draft: { title: 'Assign internal work', summary: 'Exact original operation' },
    });
    const approved = decideApprovalRequest('mission_controller', {
      channel: request.channel,
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'human-owner',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      payloadHash: binding,
      effectBinding,
    });
    const claimed = claimApprovalApply('mission_controller', {
      channel: request.channel,
      requestId: request.id,
      appliedBy: target.agentId,
      expectedRecordHash: computeApprovalPayloadHash({ record: approved }),
    });
    const result = await runHumanExecutionAuthorization(
      target,
      { channel: request.channel, requestId: request.id, claimId: claimed.applyClaim.claimId },
      () => {
        const humanExecution = currentHumanExecutionAuthorization(
          target.operationId,
          target.params
        )!;
        return executeServicePreset(
          'test-service',
          'assign',
          target.params.request,
          'none',
          undefined,
          issueTenantServiceEngineAdmission({
            securityScope: {
              tenant_slug: scope.tenant_slug,
              mission_id: '',
              read_tiers: ['confidential'],
              write_tier: 'confidential',
              purpose: 'human-authorized work',
            },
            bindingId: 'binding-1',
            approvalGranted: false,
            humanExecution,
          })
        );
      }
    );
    expect(result).toEqual({ created: true });
    expect(mock.execute).toHaveBeenCalledTimes(1);
    expect(
      readCharterLedger(charter, { rootDir: root }).filter(
        (entry) => entry.kind === 'delegated_execution'
      )
    ).toHaveLength(0);
  });
});
