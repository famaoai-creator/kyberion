import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';

type ApprovalFixture = {
  status: string;
  accountability: { finalDecision: string };
  workflow: { approvals: { status: string; decidedByType: string; authenticated: boolean }[] };
  justification: { requestedEffects: string[] };
  applyClaim?: { claimId: string };
  applyResult?: { result: string };
};
const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  source: {} as Record<string, string>,
  approval: undefined as ApprovalFixture | undefined,
  audit: vi.fn(),
  writes: vi.fn(),
  usable: vi.fn(),
  createApproval: vi.fn(),
  artifact: vi.fn(),
  requests: [] as ApprovalRequestRecord[],
  bound: false,
  explicitScope: {} as Record<string, string>,
  claim: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../path-resolver.js', () => ({ pathResolver: { rootDir: () => '/canonical' } }));
vi.mock('../secure-io.js', () => ({
  safeExecResult: () => ({
    status: 0,
    stdout: `PUBLICATION_ROLE_SOURCE:${JSON.stringify(fixture.source)}\n`,
    stderr: '',
  }),
  safeExistsSync: (file: string) => file.endsWith('/authority-roles') || fixture.files.has(file),
  safeReaddir: () => ['existing.json'],
  safeReadFile: (file: string) => {
    if (!fixture.files.has(file)) throw new Error(`missing ${file}`);
    return fixture.files.get(file)!;
  },
  safeWriteFile: (file: string, content: string) => {
    fixture.writes(file, content);
    fixture.files.set(file, content);
  },
}));
vi.mock('../foundation/governed-catalog.js', () => ({
  defineCatalog: () => ({ validate: (value: unknown) => value }),
}));
vi.mock('../foundation/lock-utils.js', () => ({
  withLockSync: (_key: string, callback: () => unknown) => callback(),
}));
vi.mock('../knowledge/memory-promotion-git.js', () => ({
  resolvePromotionTargetRoot: (root: string) => {
    if (root !== '/source') throw new Error('different repository');
    return { root };
  },
}));
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: fixture.audit } }));
vi.mock('../scope-context.js', () => ({
  withScopeEnvOnly: (callback: () => unknown) => callback(),
  resolveScopeContext: () => fixture.explicitScope,
}));
vi.mock('../scope-envelope.js', () => ({
  currentScopeEnvelope: () => (fixture.bound ? { scope_kind: 'tenant' } : undefined),
}));
vi.mock('../foundation/execution-scope.js', () => ({ currentExecutionScope: () => undefined }));
vi.mock('../foundation/resource-access-scope.js', () => ({
  currentResourceAccessScope: () => undefined,
}));
vi.mock('../governance/delegated-execution.js', () => ({
  hasDelegatedExecutionContext: () => false,
}));
vi.mock('../governance/human-execution.js', () => ({ hasHumanExecutionContext: () => false }));
vi.mock('../governance/external-operation.js', () => ({
  hasExternalOperationAuthority: () => false,
}));
vi.mock('../shell/sandbox-policy.js', () => ({ getPluginExecutionContext: () => undefined }));
vi.mock('../workforce/artifact-store.js', () => ({ writeScopedArtifact: fixture.artifact }));
vi.mock('../governance/approval-store.js', () => ({
  loadApprovalRequest: () => fixture.approval,
  assertApprovalUsable: fixture.usable,
  createApprovalRequest: fixture.createApproval,
  listApprovalRequests: () => fixture.requests,
  isApprovalRequestExpired: (record: ApprovalRequestRecord) => record.expiresAt === 'expired',
  claimApprovalApply: fixture.claim,
  recordApprovalApplyResult: fixture.complete,
  computeApprovalPayloadHash: () => 'record-hash',
}));

import {
  PUBLICATION_MIGRATION_ROLES,
  applyPublicationRoleMigration,
  previewPublicationRoleMigration,
  requestPublicationRoleMigrationApproval,
} from './publication-role-migration.js';
const prefix = 'knowledge/product/governance/';
function setTarget(file: string, value: unknown): void {
  fixture.files.set(`/canonical/${prefix}${file}`, JSON.stringify(value));
}
function source(file: string, value: unknown): void {
  fixture.source[prefix + file] = JSON.stringify(value);
}
function authorize(plan: ReturnType<typeof previewPublicationRoleMigration>): ApprovalFixture {
  const approval = {
    status: 'approved',
    accountability: { finalDecision: 'human_only' },
    workflow: { approvals: [{ status: 'approved', decidedByType: 'human', authenticated: true }] },
    justification: {
      requestedEffects: [plan.requestedEffect, ...plan.changes.map((entry) => entry.path)],
    },
  };
  fixture.approval = approval;
  return approval;
}
beforeEach(() => {
  fixture.files.clear();
  fixture.source = {};
  fixture.approval = undefined;
  fixture.requests = [];
  fixture.bound = false;
  fixture.explicitScope = {};
  fixture.audit.mockReset();
  fixture.writes.mockReset();
  fixture.usable.mockReset();
  fixture.claim.mockReset().mockImplementation(() => {
    if (!fixture.approval || fixture.approval.applyClaim)
      throw new Error('approval apply already started');
    fixture.approval.applyClaim = { claimId: 'claim-1' };
    return fixture.approval;
  });
  fixture.complete
    .mockReset()
    .mockImplementation((_role: string, params: { applyResult: { result: string } }) => {
      if (fixture.approval) fixture.approval.applyResult = params.applyResult;
    });
  fixture.createApproval.mockReset().mockReturnValue({ id: 'human-review' });
  fixture.artifact.mockReset().mockImplementation((input: { name: string; content: unknown }) => {
    const relative = `active/shared/artifacts/personal/shared/evidence/${input.name}`;
    fixture.files.set(`/canonical/${relative}`, JSON.stringify(input.content));
    return { absolute_path: `/canonical/${relative}`, repo_relative_path: relative };
  });
  const cards = Object.fromEntries(
    PUBLICATION_MIGRATION_ROLES.map((role) => [
      role,
      {
        description: role,
        write_scopes: [],
        scope_classes: [],
        allowed_actuators: [],
        tier_access: ['personal'],
      },
    ])
  );
  for (const role of PUBLICATION_MIGRATION_ROLES)
    source(`authority-roles/${role}.json`, { role, ...cards[role] });
  source('security-policy.json', {
    authority_role_permissions: Object.fromEntries(
      PUBLICATION_MIGRATION_ROLES.map((role) => [
        role,
        { allow_read: [`only/${role}`], allow_write: [] },
      ])
    ),
  });
  source('authority-role-index.json', { authority_roles: cards });
  source('role-assumption-policy.json', {
    shared_core_roles: { roles: [...PUBLICATION_MIGRATION_ROLES] },
    system_roles: {},
  });
  setTarget('security-policy.json', {
    authority_role_permissions: { existing: { allow_read: ['untouched/'] } },
    tenant_scope: { untouched: true },
  });
  setTarget('authority-role-index.json', {
    authority_roles: { existing: { description: 'preserve' } },
  });
  setTarget('role-assumption-policy.json', {
    shared_core_roles: { roles: ['existing'], rationale: 'preserve' },
    system_roles: { operator: { may_assume: ['existing'] } },
  });
});
describe('explicit installation publication role migration', () => {
  it('queues a concrete pending human decision without applying the reviewed plan', () => {
    const plan = previewPublicationRoleMigration('/source');
    const result = requestPublicationRoleMigrationApproval('/source', {
      expectedDigest: plan.digest,
      requestedBy: 'agent:codex',
    });
    expect(result.approvalId).toBe('human-review');
    expect(fixture.createApproval).toHaveBeenCalledWith(
      'infrastructure_sentinel',
      expect.objectContaining({
        storageChannel: 'terminal',
        requestedBy: 'agent:codex',
        accountability: { finalDecision: 'human_only' },
        justification: expect.objectContaining({
          requestedEffects: [plan.requestedEffect, ...plan.changes.map((entry) => entry.path)],
        }),
      })
    );
    expect(fixture.artifact).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'personal', scope: { tenant: 'shared' }, content: plan })
    );
    const queued = fixture.createApproval.mock.calls[0][1];
    expect(queued.draft.details).not.toContain('untouched/');
    expect(queued.justification.evidence).toEqual([
      `active/shared/artifacts/personal/shared/evidence/installation-publication-role-migration/${plan.digest}.json`,
    ]);
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('previews only four named roles and three catalog deltas without writing', () => {
    const plan = previewPublicationRoleMigration('/source');
    expect(plan.changes).toHaveLength(7);
    expect(plan.roles).toEqual(PUBLICATION_MIGRATION_ROLES);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('reuses an identical pending request and reports a valid human decision ready to apply', () => {
    const plan = previewPublicationRoleMigration('/source');
    requestPublicationRoleMigrationApproval('/source', {
      expectedDigest: plan.digest,
      requestedBy: 'agent:codex',
    });
    const params = fixture.createApproval.mock.calls[0][1];
    const record: ApprovalRequestRecord = {
      ...params,
      ...params.draft,
      id: 'human-review',
      status: 'pending',
      requestedAt: 'now',
    };
    fixture.requests = [record];
    expect(
      requestPublicationRoleMigrationApproval('/source', {
        expectedDigest: plan.digest,
        requestedBy: 'agent:codex',
      })
    ).toMatchObject({ approvalId: 'human-review', reused: true, status: 'pending_human' });
    record.status = 'approved';
    record.workflow!.approvals = [
      { role: 'human', status: 'approved', decidedByType: 'human', authenticated: true },
    ];
    expect(
      requestPublicationRoleMigrationApproval('/source', {
        expectedDigest: plan.digest,
        requestedBy: 'agent:codex',
      })
    ).toMatchObject({ reused: true, status: 'ready_to_apply' });
    expect(fixture.createApproval).toHaveBeenCalledTimes(1);
    expect(fixture.artifact).toHaveBeenCalledTimes(1);
  });
  it('does not reuse expired, failed, differently scoped, or differently requested records', () => {
    const plan = previewPublicationRoleMigration('/source');
    requestPublicationRoleMigrationApproval('/source', {
      expectedDigest: plan.digest,
      requestedBy: 'agent:codex',
    });
    const params = fixture.createApproval.mock.calls[0][1];
    const base: ApprovalRequestRecord = {
      ...params,
      ...params.draft,
      id: 'old',
      status: 'pending',
      requestedAt: 'now',
    };
    const variants: Partial<ApprovalRequestRecord>[] = [
      { expiresAt: 'expired' },
      { status: 'failed' },
      { requestedBy: 'agent:other' },
      { scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'other' } },
      { details: 'different payload' },
    ];
    for (const variant of variants) {
      fixture.requests = [{ ...base, ...variant }];
      expect(
        requestPublicationRoleMigrationApproval('/source', {
          expectedDigest: plan.digest,
          requestedBy: 'agent:codex',
        }).reused
      ).toBe(false);
    }
    expect(fixture.createApproval).toHaveBeenCalledTimes(6);
  });
  it('rejects bound ceilings and explicit tenant selection before any write', () => {
    fixture.bound = true;
    expect(() => previewPublicationRoleMigration('/source')).toThrow('bound execution');
    fixture.bound = false;
    fixture.explicitScope = { tenant_slug: 'selected' };
    expect(() => previewPublicationRoleMigration('/source')).toThrow('unscoped operator');
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.createApproval).not.toHaveBeenCalled();
  });
  it('rejects unrelated source repositories', () => {
    expect(() => previewPublicationRoleMigration('/foreign')).toThrow('different repository');
  });
  it('refuses divergent existing permissions including explicit empty grants', () => {
    setTarget('security-policy.json', {
      authority_role_permissions: { pr_publication_store: { allow_read: [], allow_write: [] } },
    });
    expect(() => previewPublicationRoleMigration('/source')).toThrow('divergent');
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('refuses explicit denies', () => {
    setTarget('security-policy.json', {
      authority_role_permissions: { pr_publication_store: { deny_read: ['only/'] } },
    });
    expect(() => previewPublicationRoleMigration('/source')).toThrow('explicit deny');
  });
  it('refuses divergent existing role cards', () => {
    setTarget('authority-roles/pr_publication_store.json', {
      role: 'pr_publication_store',
      write_scopes: ['/'],
    });
    expect(() => previewPublicationRoleMigration('/source')).toThrow('divergent role card');
  });
  it('refuses source role/index disagreement or missing assumption registration', () => {
    source('authority-roles/pr_publication_store.json', {
      role: 'pr_publication_store',
      description: 'different',
    });
    expect(() => previewPublicationRoleMigration('/source')).toThrow('index/card mismatch');
    source('role-assumption-policy.json', { shared_core_roles: { roles: [] } });
    expect(() => previewPublicationRoleMigration('/source')).toThrow('incomplete source role');
  });
  it('requires authenticated human approval for the exact digest and every path', () => {
    const plan = previewPublicationRoleMigration('/source');
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow('authenticated human');
    authorize(plan).justification.requestedEffects.pop();
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow('authenticated human');
    authorize(plan).workflow.approvals[0].authenticated = false;
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow('authenticated human');
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('requires a fresh review after a concurrent unrelated catalog change', () => {
    const plan = previewPublicationRoleMigration('/source');
    authorize(plan);
    setTarget('security-policy.json', { authority_role_permissions: { other: {} } });
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow('preview changed');
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('never reuses a consumed approval after the original catalog bytes are restored', () => {
    const plan = previewPublicationRoleMigration('/source');
    authorize(plan);
    applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest });
    expect(fixture.complete).toHaveBeenCalledWith(
      'infrastructure_sentinel',
      expect.objectContaining({
        claimId: 'claim-1',
        applyResult: expect.objectContaining({ result: 'success' }),
      })
    );
    for (const change of plan.changes) {
      const file = `/canonical/${change.path}`;
      if (change.before === null) fixture.files.delete(file);
      else fixture.files.set(file, change.before);
    }
    expect(previewPublicationRoleMigration('/source').digest).toBe(plan.digest);
    fixture.writes.mockClear();
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow();
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.claim).toHaveBeenCalledTimes(1);
  });
  it('retains the application fence after an uncertain write failure', () => {
    const plan = previewPublicationRoleMigration('/source');
    authorize(plan);
    fixture.writes.mockImplementationOnce(() => {
      throw new Error('storage failed');
    });
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow('storage failed');
    expect(fixture.complete).toHaveBeenCalledWith(
      'infrastructure_sentinel',
      expect.objectContaining({ applyResult: expect.objectContaining({ result: 'failed' }) })
    );
    fixture.writes.mockClear();
    expect(() =>
      applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest })
    ).toThrow('already started');
    expect(fixture.writes).not.toHaveBeenCalled();
  });
  it('preserves unrelated policy and role assumptions, audits before/after, and is idempotent', () => {
    const plan = previewPublicationRoleMigration('/source');
    authorize(plan);
    applyPublicationRoleMigration('/source', { approvalId: 'a', expectedDigest: plan.digest });
    expect(fixture.writes).toHaveBeenCalledTimes(7);
    const policy = JSON.parse(fixture.files.get(`/canonical/${prefix}security-policy.json`)!);
    expect(policy.authority_role_permissions.existing).toEqual({ allow_read: ['untouched/'] });
    expect(policy.tenant_scope).toEqual({ untouched: true });
    const assumptions = JSON.parse(
      fixture.files.get(`/canonical/${prefix}role-assumption-policy.json`)!
    );
    expect(assumptions.system_roles).toEqual({ operator: { may_assume: ['existing'] } });
    expect(assumptions.shared_core_roles.rationale).toBe('preserve');
    expect(fixture.audit.mock.calls.map(([event]) => event.result)).toEqual([
      'allowed',
      'completed',
    ]);
    expect(fixture.usable).toHaveBeenCalledWith(fixture.approval, {
      consumer: 'installation_publication_role_migration',
    });
    expect(previewPublicationRoleMigration('/source').changes).toEqual([]);
  });
});
