import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetOpPreflight } from '@agent/core/pipeline/op-preflight';
import type { ExternalOperationAuthority } from '@agent/core/governance/external-operation';
import { withExternalOperationPipelineRun } from '@agent/core/governance/external-operation';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  execute: vi.fn(),
  audit: vi.fn(),
  binding: vi.fn(),
}));
vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: mocks.gate }));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('@agent/core/service/service-binding-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/service/service-binding-registry')>()),
  authorizeTenantServiceAction: mocks.binding,
}));
vi.mock('@agent/core/cloudflare-os-shared', () => ({
  sharedControlPlane: () => ({
    enforceIntroduction: vi.fn(),
    projectTaint: () => ({
      missionId: 'mission-binding',
      highestTier: 'public',
      tenants: [],
      prohibitExternal: false,
      observationIds: [],
    }),
  }),
}));
vi.mock('@agent/core/service/service-preset-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/service/service-preset-registry')>()),
  getServicePresetRecord: (id: string) => ({
    service_id: id,
    tenant_binding_required: id === 'bound',
    operations: {
      read: { risk: 'read', type: 'api', method: 'GET' },
      write: { risk: 'write', type: 'api', method: 'POST' },
      delete: { risk: 'destructive', type: 'api', method: 'DELETE' },
      opaque: { type: 'cli', command: 'unknown' },
    },
  }),
}));
vi.mock('@agent/core/service/service-engine', async (original) => ({
  ...(await original<typeof import('@agent/core/service/service-engine')>()),
  executeServicePreset: mocks.execute,
}));
vi.mock('@agent/core/service/service-harness', async (original) => ({
  ...(await original<typeof import('@agent/core/service/service-harness')>()),
  describeServiceHarness: () => ({
    operations: [
      { action: 'read', risk: 'read', approval_required: false },
      { action: 'write', risk: 'write', approval_required: false },
      { action: 'delete', risk: 'destructive', approval_required: true },
      { action: 'opaque', risk: 'read', approval_required: false },
    ],
  }),
}));

import { handleAction } from './index.js';
const authority = {
  agentId: 'worker',
  invocationId: 'invocation-1',
  tenantSlug: 'acme',
  charter: {
    scope: { kind: 'organization', tenant_slug: 'acme', organization_id: 'org' },
    action: { decision_type: 'external_send' },
  },
} as ExternalOperationAuthority;
const action = (name = 'write') => ({
  service_id: 'github',
  mode: 'PRESET' as const,
  action: name,
  params: {},
});

describe('service shared external admission', () => {
  it('rejects resumable nested calls including binding-gated reads before partial execution', async () => {
    mocks.execute.mockClear();
    const step = { op: 'preset', params: { service_id: 'github', action: 'write', params: {} } };
    await expect(
      withExternalOperationPipelineRun('outer-run', () =>
        handleAction({
          ...action(),
          action: 'pipeline',
          steps: [
            { op: 'preset', params: { service_id: 'bound', action: 'read', params: {} } },
            step,
          ],
        })
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    authority.invocationId = randomUUID();
    delete process.env.MISSION_ID;
    mocks.gate.mockReturnValue({ allowed: false, status: 'human_required' });
    mocks.execute.mockResolvedValue({ ok: true });
    mocks.binding.mockReset();
    mocks.binding.mockReturnValue({ bindingId: 'binding-acme', approvalRequired: true });
  });
  afterEach(() => resetOpPreflight());

  it('blocks writes with no authority and ignores forged params and context', async () => {
    for (const forged of [
      {},
      { params: { authority, approvalGranted: true }, context: { externalAuthority: authority } },
    ]) {
      await expect(handleAction({ ...action(), ...forged })).rejects.toThrow(
        'EXTERNAL_APPROVAL_REQUIRED'
      );
    }
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.gate).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'external-actuator', hasHuman: false })
    );
    expect(mocks.gate.mock.calls.every(([input]) => !input.charter)).toBe(true);
  });

  it('forwards trusted tenant-bound charter authority', async () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'delegated' });
    await handleAction(action(), undefined, { externalAuthority: () => authority });
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'worker', charter: authority.charter })
    );
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps opaque MCP and destructive operations outside charter delegation', async () => {
    for (const input of [action('delete'), { ...action(), mode: 'MCP' as const }]) {
      await expect(
        handleAction(input, undefined, { externalAuthority: () => authority })
      ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    }
    expect(mocks.gate.mock.calls.every(([input]) => !input.charter)).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('allows reviewed reads without an approval gate', async () => {
    await handleAction(action('read'));
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('requires admission for opaque CLI presets even when harness inference says read', async () => {
    await expect(handleAction(action('opaque'))).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false }, 'failed'],
    [{ issue_id: 42 }, 'unknown'],
  ] as const)('records outcome %s as %s', async (result, outcome) => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'delegated' });
    mocks.execute.mockResolvedValue(result);
    await handleAction(action(), undefined, { externalAuthority: () => authority });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome }) })
    );
  });

  it('resolves trusted authority for each pipeline step and never replays an ambiguous effect', async () => {
    mocks.gate.mockReturnValue({ allowed: true, status: 'delegated' });
    mocks.execute
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('connection lost after send'));
    const resolveAuthority = vi.fn(() => ({
      ...authority,
      invocationId: `${authority.invocationId}-step-${mocks.execute.mock.calls.length}`,
    }));
    const step = { op: 'preset', params: { service_id: 'github', action: 'write', params: {} } };
    await expect(
      handleAction({ ...action(), action: 'pipeline', steps: [step, step] }, undefined, {
        externalAuthority: resolveAuthority,
      })
    ).rejects.toThrow('connection lost after send');
    expect(resolveAuthority).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.gate).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: 'unknown' }),
      })
    );
  });

  const boundAction = () => ({
    ...action(),
    service_id: 'bound',
    context: {
      security_scope: {
        tenant_slug: 'acme',
        mission_id: 'mission-binding',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'test',
      },
    },
  });

  it('uses common admission to satisfy binding approval and issues an opaque engine capability', async () => {
    process.env.MISSION_ID = 'mission-binding';
    mocks.gate.mockReturnValue({ allowed: true, status: 'delegated' });
    await handleAction(boundAction(), undefined, { externalAuthority: () => authority });
    expect(mocks.gate).toHaveBeenCalledWith(
      expect.objectContaining({ charter: authority.charter })
    );
    const { resolveTenantServiceEngineAdmission } =
      await import('@agent/core/service/service-engine-admission');
    const capability = mocks.execute.mock.calls[0][5];
    expect(resolveTenantServiceEngineAdmission(capability)).toMatchObject({
      bindingId: 'binding-acme',
      approvalGranted: true,
    });
  });

  it('keeps binding whitelist denial ahead of charter admission', async () => {
    process.env.MISSION_ID = 'mission-binding';
    mocks.binding.mockImplementation(() => {
      throw new Error('operation not in binding whitelist');
    });
    await expect(
      handleAction(boundAction(), undefined, { externalAuthority: () => authority })
    ).rejects.toThrow('binding whitelist');
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects forged binding approval when the common gate denies', async () => {
    process.env.MISSION_ID = 'mission-binding';
    const input = boundAction();
    await expect(
      handleAction({
        ...input,
        context: { ...input.context, service_binding_approval_granted: true },
      })
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects authority for another tenant before consuming approval', async () => {
    process.env.MISSION_ID = 'mission-binding';
    await expect(
      handleAction(boundAction(), undefined, {
        externalAuthority: () => ({ ...authority, tenantSlug: 'other' }),
      })
    ).rejects.toThrow('EXTERNAL_SCOPE_MISMATCH');
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('keeps explicit mandatory preflight approval ahead of charter consumption', async () => {
    process.env.MISSION_ID = 'mission-binding';
    await expect(
      handleAction({ ...boundAction(), params: { _approval_required: true } }, undefined, {
        externalAuthority: () => authority,
      })
    ).rejects.toThrow('OP_PREFLIGHT');
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
