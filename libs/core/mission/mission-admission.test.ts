import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeReadFile, safeWriteFile } from '../secure-io.js';
import { prepareEffectSettlement } from '../workforce/work-effect-transitions.js';
import {
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
} from '../governance/approval-store.js';
import { dotAdmissionMissionId } from '../dot/dot-admission-identity.js';
import { normalizeDotProposal } from '../dot/dot-proposals.js';
import { dotWorkItemInput } from '../dot/dot-work-item.js';
import { buildWorkItemCreation } from '../workforce/work-coordination-identity.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { DotActionRecord } from '../dot/dot-action-ledger.js';
import type { WorkItem, ReleaseWorkItemInput } from '../workforce/work-coordination-types.js';
import type { MissionState } from './mission-types.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  authorMissionAdmissionBrief,
  prepareMissionAdmissionBrief,
  buildMissionAdmissionBrief,
  assertHumanMissionAdmissionApproval,
  withHumanMissionAdmissionApply,
  recordVerifiedMissionAdmissionApproval,
  resolveDotMissionAdmission,
  resolveDotMissionAdmissionScope,
  assertMissionAdmissionActivation,
} from './mission-admission.js';

const mocks = vi.hoisted(() => {
  const item: WorkItem = {
    item_id: '',
    title: '',
    description: '',
    status: 'ready',
    priority: 'normal',
    source: 'local',
    source_ref: '',
    project_id: '',
    labels: [],
    dependencies: [],
    version: 1,
    created_at: '',
    updated_at: '',
  };
  const dot: DotCharter = {
    kind: 'dot-charter',
    dot_id: '',
    version: '1',
    title: '',
    purpose: '',
    status: 'active',
    scope: { tier: 'confidential' },
    goal: { statement: '' },
    attention: { triggers: [] },
    authority: { authority_role: 'mission_controller' },
    notification: { deliver_to: { surface: 'surface', channel: 'brief' } },
    runtime: { heartbeat_id: 'test-mission-admission' },
  };
  const state: Partial<MissionState> = {};
  return {
    item,
    dot,
    rows: Array<DotActionRecord>(),
    state,
    missionDir: '',
    covered: true,
    memberActive: true,
    autoAllowed: true,
    leaseActive: true,
    execution: vi.fn(),
    decision: vi.fn(),
    claim: vi.fn(),
    release: vi.fn(),
    approvals: Array<ApprovalRequestRecord>(),
  };
});
vi.mock('../organization/member-registry.js', async (original) => ({
  ...(await original<typeof import('../organization/member-registry.js')>()),
  resolveAccountableHuman: () => ({
    status: mocks.memberActive ? 'active' : 'suspended',
    memberships: [{ tenant_slug: 'acme', role: 'approver' }],
  }),
}));
vi.mock('../governance/autonomous-ops-gate.js', async (original) => ({
  ...(await original<typeof import('../governance/autonomous-ops-gate.js')>()),
  evaluateAutonomousOpsAction: () => ({
    decision: 'auto',
    allowed: mocks.autoAllowed,
    shadow: !mocks.autoAllowed,
  }),
}));
vi.mock('../dot/dot-charter.js', () => ({
  findDotCharter: () => ({ charter: mocks.dot }),
  dotGoalRefLabel: () => undefined,
}));
vi.mock('../dot/dot-action-ledger.js', () => ({
  readDotActionLedgerStrict: () => mocks.rows,
}));
vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: () => mocks.item,
  claimWorkItem: (...args: unknown[]) => mocks.claim(...args),
  releaseWorkItem: (...args: unknown[]) => mocks.release(...args),
  listActiveWorkLeases: () =>
    mocks.leaseActive
      ? [
          {
            lease_id: 'lease',
            item_id: mocks.item.item_id,
            holder_peer_id: 'mission_controller',
          },
        ]
      : [],
}));
vi.mock('./mission-state.js', () => ({ loadState: () => mocks.state }));
vi.mock('../path-resolver.js', async (original) => ({
  ...(await original<typeof import('../path-resolver.js')>()),
  findMissionPath: () => mocks.missionDir,
}));
vi.mock('../governance/mandate-shadow.js', async (original) => ({
  ...(await original<typeof import('../governance/mandate-shadow.js')>()),
  evaluateMissionStartMandate: () => ({ covered: mocks.covered, reasons: [] }),
}));
vi.mock('../governance/approval-store-reader.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store-reader.js')>()),
  listApprovalRequests: () => mocks.approvals,
  loadApprovalRequest: (_channel: string, id: string) =>
    mocks.approvals.find((record) => record.id === id),
}));
vi.mock('../governance/approval-separation-of-duties.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-separation-of-duties.js')>()),
  approvalUsabilityRefusal: () => undefined,
}));
vi.mock('../governance/autonomy-action-state.js', () => ({
  recordAutonomyExecution: (...args: unknown[]) => mocks.execution(...args),
  recordAutonomyOutcome: (...args: unknown[]) => mocks.decision(...args),
}));

const root = pathResolver.sharedTmp(`mission-admission-test-${process.pid}`);
const admission = {
  mandate_ref: 'docs',
  mandate_facts: {
    work_type: 'update docs',
    paths: ['docs/plan.md'],
    estimated_cost: 0,
    currency: 'JPY',
    external_effects: [],
    risk_level: 1,
  },
};
const missionId = dotAdmissionMissionId('action-1');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.covered = true;
  mocks.memberActive = true;
  mocks.autoAllowed = true;
  mocks.leaseActive = true;
  mocks.approvals = [];
  mocks.missionDir = path.join(root, missionId);
  safeMkdir(mocks.missionDir, { recursive: true });
  mocks.dot = {
    ...mocks.dot,
    dot_id: 'ops',
    title: 'Ops',
    status: 'active',
    scope: {
      tier: 'confidential',
      tenant_slug: 'acme',
      organization_id: 'org-1',
      project_id: 'proj-1',
    },
    authority: {
      authority_role: 'mission_controller',
      allowed_work_shapes: ['mission'],
      mission_mandate_refs: ['docs'],
    },
  };
  mocks.rows = [
    {
      action_ref: 'action-1',
      actor_id: 'ops',
      proposal_hash: 'proposal-1',
      at: '2026-10-20T00:00:00Z',
      dot_id: 'ops',
      status: 'dispatched',
      work_item_id: 'work-1',
      admission_only: true,
      mission_admission: admission,
      title: 'Docs',
      objective: 'Update docs',
      action_id: 'dot_delegate_work',
      work_shape: 'mission',
    },
  ];
  mocks.item = {
    ...mocks.item,
    item_id: 'work-1',
    title: 'Docs',
    description: 'Update docs',
    status: 'ready',
    version: 1,
    context: { tenant_slug: 'acme', organization_id: 'org-1', project_id: 'proj-1' },
    metadata: {
      dot_id: 'ops',
      action_ref: 'action-1',
      admission_only: true,
      requested_work_shape: 'mission',
      mission_id: missionId,
      mission_admission: admission,
    },
  };
  mocks.state = {
    status: 'active',
    tenant_slug: 'acme',
    tier: 'confidential',
    organization_id: 'org-1',
    relationships: { project: { project_id: 'proj-1', relationship_type: 'belongs_to' } },
  };
  mocks.claim.mockReturnValue({ item: mocks.item, lease: { lease_id: 'lease-1' } });
  mocks.release.mockImplementation((input: ReleaseWorkItemInput) => {
    prepareEffectSettlement(mocks.item, input, new Date().toISOString());
    mocks.item = { ...mocks.item, status: input.nextStatus ?? mocks.item.status };
  });
});
afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('Dot mission admission production and human receipt', () => {
  it('admits an organization-only Dot through real WorkItem creation normalization', () => {
    delete mocks.dot.scope.project_id;
    mocks.item = buildWorkItemCreation(dotWorkItemInput(mocks.dot, mocks.rows[0]));
    mocks.rows[0].work_item_id = mocks.item.item_id;
    expect(mocks.item.context?.project_id).toBe('default');
    expect(resolveDotMissionAdmission(mocks.item)).toEqual(admission);
    expect(resolveDotMissionAdmissionScope(mocks.item)).toEqual({
      tenant_slug: 'acme',
      organization_id: 'org-1',
    });
    expect(() =>
      assertMissionAdmissionActivation(missionId, mocks.item.item_id, 'acme', {
        organizationId: 'org-1',
      })
    ).not.toThrow();
    mocks.state.relationships = {};
    authorMissionAdmissionBrief(missionId, mocks.item.item_id);
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'done' }));
  });
  it('preserves an explicitly declared default project as a real mission binding', () => {
    mocks.dot.scope.project_id = 'default';
    mocks.item = buildWorkItemCreation(dotWorkItemInput(mocks.dot, mocks.rows[0]));
    mocks.rows[0].work_item_id = mocks.item.item_id;
    expect(resolveDotMissionAdmissionScope(mocks.item).project_id).toBe('default');
    expect(() =>
      assertMissionAdmissionActivation(missionId, mocks.item.item_id, 'acme', {
        organizationId: 'org-1',
      })
    ).toThrow('identity/scope mismatch');
    expect(() =>
      assertMissionAdmissionActivation(missionId, mocks.item.item_id, 'acme', {
        organizationId: 'org-1',
        projectId: 'default',
      })
    ).not.toThrow();
  });
  it('rejects a real project on a projectless Dot and mismatched explicit projects', () => {
    delete mocks.dot.scope.project_id;
    mocks.item = buildWorkItemCreation(dotWorkItemInput(mocks.dot, mocks.rows[0]));
    mocks.rows[0].work_item_id = mocks.item.item_id;
    mocks.item.context!.project_id = 'unapproved-project';
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow(
      'current Dot admission authority missing'
    );
    mocks.dot.scope.project_id = 'approved-project';
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow(
      'current Dot admission authority missing'
    );
  });
  it('retains tenant, organization and admitted action proof checks for normalized items', () => {
    delete mocks.dot.scope.project_id;
    const create = () => buildWorkItemCreation(dotWorkItemInput(mocks.dot, mocks.rows[0]));
    mocks.item = create();
    mocks.rows[0].work_item_id = mocks.item.item_id;
    mocks.item.context!.tenant_slug = 'other-tenant';
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow(
      'current Dot admission authority missing'
    );
    mocks.item = create();
    mocks.item.context!.organization_id = 'other-org';
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow(
      'current Dot admission authority missing'
    );
    mocks.item = create();
    mocks.rows[0].work_item_id = 'other-item';
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow(
      'mission intake differs from admitted action'
    );
  });
  it('retains structured proposal facts into deterministic tenant/org/project WorkItem metadata', () => {
    const proposal = normalizeDotProposal({
      title: 'Docs',
      objective: 'Update docs',
      work_shape: 'mission',
      mission_admission: admission,
    });
    expect(proposal.mission_admission).toEqual(admission);
    const item = dotWorkItemInput(mocks.dot, { ...mocks.rows[0], ...proposal });
    expect(item.metadata).toMatchObject({
      mission_admission: admission,
      mission_id: missionId,
      mandate_ref: 'docs',
    });
    expect(item.context).toMatchObject({
      tenant_slug: 'acme',
      organization_id: 'org-1',
      project_id: 'proj-1',
    });
  });
  it('authors the hash-bound brief through activation receipt and settles the origin via facades', () => {
    authorMissionAdmissionBrief(missionId, 'work-1');
    const brief = JSON.parse(
      safeReadFile(path.join(mocks.missionDir, 'evidence/mission-brief.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(brief.missionAdmission).toEqual(admission);
    expect(brief.gate.approvalRequired).toBe(true);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'work-1', requireNewLease: true })
    );
    expect(mocks.release).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'done', effectDisposition: 'completed' })
    );
    expect(mocks.execution).not.toHaveBeenCalled();
    authorMissionAdmissionBrief(missionId, 'work-1');
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });
  it('records stable success only from an actual human decision after activation and exact brief binding', () => {
    authorMissionAdmissionBrief(missionId, 'work-1');
    const brief = JSON.parse(
      safeReadFile(path.join(mocks.missionDir, 'evidence/mission-brief.json'), {
        encoding: 'utf8',
      }) as string
    );
    const record: ApprovalRequestRecord = {
      title: 'Mission admission',
      summary: 'Approve the exact internal mission admission',
      kind: 'channel-approval',
      threadTs: 'thread-1',
      requestedBy: 'mission_controller',
      requestedAt: '2026-10-20T00:00:00Z',
      id: 'approval-1',
      channel: 'brief',
      storageChannel: 'brief',
      status: 'approved',
      decidedBy: 'user:owner',
      decidedByType: 'human',
      authenticated: true,
      decidedAuthMethod: 'passkey',
      source: { missionId },
      correlationId: `mission-alignment-${missionId}`,
      accountability: {
        finalDecision: 'human_only',
        payloadHash: computeApprovalPayloadHash(brief),
      },
    };
    mocks.approvals = [record];
    recordVerifiedMissionAdmissionApproval(record);
    expect(mocks.execution).toHaveBeenCalledWith(
      expect.objectContaining({ receipt_id: `mission-start:acme:${missionId}`, ok: true }),
      expect.objectContaining({ tenantSlug: 'acme' })
    );
    mocks.execution.mockClear();
    for (const decidedByType of ['ai_agent', 'service', undefined] as const) {
      mocks.approvals = [{ ...record, decidedByType }];
      recordVerifiedMissionAdmissionApproval(record);
    }
    mocks.approvals = [
      { ...record, accountability: { ...record.accountability, payloadHash: 'changed' } },
    ];
    recordVerifiedMissionAdmissionApproval(record);
    mocks.approvals = [record];
    mocks.state = { ...mocks.state, status: 'planned' };
    recordVerifiedMissionAdmissionApproval(record);
    expect(mocks.execution).not.toHaveBeenCalled();
    mocks.approvals = [record];
    mocks.state = { ...mocks.state, status: 'active' };
    authorMissionAdmissionBrief(missionId, 'work-1');
    expect(mocks.execution).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt_id: `mission-start:acme:${missionId}`,
        ok: true,
      }),
      expect.objectContaining({ tenantSlug: 'acme' })
    );
  });
  it('keeps the original brief error while releasing an invalid admission to a held/blocked state', () => {
    authorMissionAdmissionBrief(missionId, 'work-1');
    const file = path.join(mocks.missionDir, 'evidence/mission-brief.json');
    const brief = JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string);
    brief.missionAdmission.mandate_ref = 'changed';
    safeWriteFile(file, JSON.stringify(brief));
    mocks.item = { ...mocks.item, status: 'ready' };
    expect(() => authorMissionAdmissionBrief(missionId, 'work-1')).toThrow('different admission');
    expect(mocks.release).toHaveBeenLastCalledWith(
      expect.objectContaining({ nextStatus: 'blocked' })
    );
    expect(mocks.release.mock.calls.at(-1)?.[0]).not.toHaveProperty('effectDisposition');
  });

  it('holds revoked mandates, cross-tenant/project scopes, unlisted refs and altered durable proposals', () => {
    mocks.covered = false;
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow('no longer covers');
    mocks.covered = true;
    for (const context of [
      { ...mocks.item.context, tenant_slug: 'other' },
      { ...mocks.item.context, project_id: 'other' },
    ]) {
      expect(() => resolveDotMissionAdmission({ ...mocks.item, context })).toThrow();
    }
    mocks.dot.authority.mission_mandate_refs = [];
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow('authority');
    mocks.dot.authority.mission_mandate_refs = ['docs'];
    mocks.rows[0] = {
      ...mocks.rows[0],
      mission_admission: { ...admission, mandate_ref: 'other' },
    };
    expect(() => resolveDotMissionAdmission(mocks.item)).toThrow('differs');
  });
});

describe('planned human admission preparation', () => {
  it('authors the same bound brief before activation without claiming or completing work', () => {
    mocks.state.status = 'planned';
    prepareMissionAdmissionBrief(missionId, mocks.item.item_id);
    const brief = JSON.parse(
      safeReadFile(path.join(mocks.missionDir, 'evidence', 'mission-brief.json'), 'utf8')
    );
    expect(brief.source.ref).toBe(mocks.item.item_id);
    expect(brief.missionAdmission).toEqual(admission);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    prepareMissionAdmissionBrief(missionId, mocks.item.item_id);
  });
});

describe('human admission controller boundary', () => {
  it('refuses direct typed admission in shadow even when no preparation pin exists', () => {
    mocks.autoAllowed = false;
    expect(() =>
      assertMissionAdmissionActivation(missionId, mocks.item.item_id, 'acme', {
        organizationId: 'org-1',
        projectId: 'proj-1',
      })
    ).toThrow('human admission');
  });
  function approved() {
    mocks.state.status = 'planned';
    safeMkdir(path.join(mocks.missionDir, 'evidence'), { recursive: true });
    safeWriteFile(
      path.join(mocks.missionDir, 'evidence', 'mission-brief.json'),
      JSON.stringify(buildMissionAdmissionBrief(mocks.item, admission, missionId))
    );
    const scope = { tenant_slug: 'acme', organization_id: 'org-1', project_id: 'proj-1' };
    const record = {
      id: '00000000-0000-4000-8000-000000000001',
      storageChannel: 'brief',
      channel: 'brief',
      kind: 'mission_gate',
      title: 'Docs',
      summary: 'Update docs',
      requestedBy: 'mission_controller',
      requestedAt: '2026-10-20T00:00:00Z',
      threadTs: missionId,
      correlationId: 'mission-alignment-' + missionId,
      status: 'approved',
      source: { missionId, taskId: mocks.item.item_id },
      scope: {
        ...scope,
        tier: 'confidential',
        mission_id: missionId,
        task_id: mocks.item.item_id,
        scope_kind: 'task',
      },
      accountability: {
        finalDecision: 'human_only',
        payloadHash: computeApprovalPayloadHash(
          buildMissionAdmissionBrief(mocks.item, admission, missionId)
        ),
        effectBinding:
          'mission-admission:' +
          computeApprovalPayloadHash({
            action: 'human_mission_alignment',
            itemId: mocks.item.item_id,
            missionId,
            actionRef: 'action-1',
            scope,
          }),
      },
      decidedBy: 'user:test-approver',
      decidedByType: 'human',
      authenticated: true,
      decidedAuthMethod: 'surface_session',
      decidedByIdentitySource: 'server_resolved',
      decidedAt: '2026-10-20T00:01:00Z',
    } as ApprovalRequestRecord;
    record.verifiedPresentedDigest = computeApprovalPresentedDigest(record);
    mocks.approvals = [record];
    return record;
  }
  it.each(['brief', 'cancelled', 'scope'])(
    'rejects durable %s drift at the final activation boundary',
    (kind) => {
      approved();
      if (kind === 'brief')
        safeWriteFile(
          path.join(mocks.missionDir, 'evidence', 'mission-brief.json'),
          JSON.stringify({
            ...buildMissionAdmissionBrief(mocks.item, admission, missionId),
            intent: 'Changed after claim',
          })
        );
      if (kind === 'cancelled') mocks.state.status = 'paused';
      if (kind === 'scope') mocks.state.organization_id = 'different';
      expect(() => assertHumanMissionAdmissionApproval(mocks.item)).toThrow('evidence changed');
    }
  );
  it('accepts exact human consent but refuses revoked current membership', () => {
    const record = approved();
    expect(assertHumanMissionAdmissionApproval(mocks.item).id).toBe(record.id);
    mocks.memberActive = false;
    expect(() => assertHumanMissionAdmissionApproval(mocks.item)).toThrow('current tenant');
  });
  it.each(['weak', 'agent', 'digest', 'expired', 'content'] as const)(
    'refuses %s consent at activation',
    (kind) => {
      const record = approved();
      if (kind === 'weak') record.decidedAuthMethod = 'local_token';
      if (kind === 'agent') record.decidedInAgentSession = 'worker';
      if (kind === 'digest') record.verifiedPresentedDigest = 'changed';
      if (kind === 'expired') record.expiresAt = '2000-01-01T00:00:00Z';
      if (kind === 'content') mocks.item.description = 'Different outcome';
      expect(() => assertHumanMissionAdmissionApproval(mocks.item)).toThrow();
    }
  );
  it('requires the exact uncompleted apply claim for controller activation', () => {
    const record = approved();
    mocks.item.metadata = {
      ...mocks.item.metadata,
      mission_alignment_preparation: { fingerprint: 'pinned' },
    };
    const activate = () =>
      assertMissionAdmissionActivation(missionId, mocks.item.item_id, 'acme', {
        organizationId: 'org-1',
        projectId: 'proj-1',
      });
    expect(activate).toThrow('apply claim');
    record.applyClaim = {
      claimId: 'claim',
      startedAt: '2026-10-20T00:02:00Z',
      startedBy: 'mission_controller',
    };
    mocks.item.lease_id = 'lease';
    mocks.item.status = 'in_progress';
    mocks.item.current_attempt_id = 'attempt';
    mocks.item.claimed_by_peer_id = 'mission_controller';
    expect(activate).toThrow('apply claim');
    expect(() =>
      withHumanMissionAdmissionApply(
        {
          workItemId: mocks.item.item_id,
          requestId: record.id,
          claimId: 'claim',
          leaseId: 'lease',
          attemptId: 'attempt',
        },
        activate
      )
    ).not.toThrow();
    mocks.leaseActive = false;
    expect(() =>
      withHumanMissionAdmissionApply(
        {
          workItemId: mocks.item.item_id,
          requestId: record.id,
          claimId: 'claim',
          leaseId: 'lease',
          attemptId: 'attempt',
        },
        activate
      )
    ).toThrow('apply claim');
  });
});
