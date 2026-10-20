import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  expireWorkItemLeases,
} from '@agent/core/workforce/work-coordination';
import {
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  listApprovalRequests,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  cancelApprovalRequest,
  expireApprovalRequest,
  approvalStoreRoots,
} from '@agent/core/governance/approval-store';
import { revokeApprovalRequest } from '@agent/core/governance/approval-revocation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import { continueHumanMissionAdmission } from './mission_admission_continuation.js';

const h = vi.hoisted(() => ({
  state: undefined as undefined | Record<string, unknown>,
  dir: '',
  covered: true,
  memberActive: true,
  fail: '' as string,
  shadow: true,
}));
vi.mock('@agent/core/organization/member-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/organization/member-registry')>()),
  resolveAccountableHuman: () => ({
    status: h.memberActive ? 'active' : 'suspended',
    memberships: [{ tenant_slug: 'acme', role: 'approver' }],
  }),
}));
vi.mock('@agent/core/mission/mission-state', () => ({ loadState: () => h.state }));
vi.mock('@agent/core/path-resolver', async (original) => ({
  ...(await original<typeof import('@agent/core/path-resolver')>()),
  findMissionPath: () => (h.state ? h.dir : undefined),
}));
vi.mock('@agent/core/mission/mission-admission', async (original) => {
  const real = await original<typeof import('@agent/core/mission/mission-admission')>();
  return {
    ...real,
    recordVerifiedMissionAdmissionApproval: () => undefined,
    resolveDotMissionAdmission: (item: ReturnType<typeof createWorkItem>) => {
      if (!h.covered) throw new Error('mandate revoked');
      return item.metadata!.mission_admission;
    },
    resolveDotMissionAdmissionScope: () => ({
      tenant_slug: 'acme',
      organization_id: 'org-1',
      project_id: 'proj-1',
    }),
    prepareMissionAdmissionBrief: async (_mission: string, id: string) => {
      const item = getWorkItem(id)!;
      safeMkdir(path.join(h.dir, 'evidence'), { recursive: true });
      safeWriteFile(
        path.join(h.dir, 'evidence/mission-brief.json'),
        JSON.stringify(
          real.buildMissionAdmissionBrief(
            item,
            item.metadata!.mission_admission as never,
            String(item.metadata!.mission_id)
          )
        )
      );
    },
  };
});
// Preserve real decision/claim/receipt storage; avoid unrelated notification/mandate observation effects.
vi.mock('./mission-alignment-gate/alignment-approval.js', () => ({
  openAlignmentApproval: (
    missionId: string,
    options: {
      requestedBy: string;
      binding: { source: object; scope: object; effectBinding: string; expiresAt: string };
    }
  ) => {
    const item = getWorkItem(String((options.binding.source as { taskId: string }).taskId))!;
    const brief = {
      missionId,
      title: item.title,
      intent: item.description,
      tier: 'confidential',
      scope: { in: ['docs/test.md'] },
      gate: { riskLevel: 1, approvalRequired: true },
      estimate: { cost: '0 JPY' },
      missionAdmission: item.metadata!.mission_admission,
      source: { kind: 'dot_work_item', ref: item.item_id, tenantSlug: 'acme' },
    };
    const record = createApprovalRequest('infrastructure_sentinel', {
      channel: 'brief',
      storageChannel: 'brief',
      threadTs: missionId,
      correlationId: 'mission-alignment-' + missionId,
      requestedBy: options.requestedBy,
      kind: 'mission_gate',
      draft: { title: item.title, summary: item.description },
      source: options.binding.source,
      scope: options.binding.scope,
      expiresAt: options.binding.expiresAt,
      accountability: {
        finalDecision: 'human_only',
        payloadHash: computeApprovalPayloadHash(brief),
        effectBinding: options.binding.effectBinding,
      },
    });
    return { requestId: record.id };
  },
}));
// Human authentication is explicit; this test is not an agent pretending to be a decider.
vi.mock('@agent/core/agent-execution-context', async (original) => ({
  ...(await original<typeof import('@agent/core/agent-execution-context')>()),
  detectAgentExecutionContext: () => ({ isAgent: false, signals: [], principal: 'human' }),
}));

let itemId: string;
let missionId: string;
let run: ReturnType<typeof vi.fn<(args: string[]) => Promise<void>>>;
beforeEach(() => {
  const id = randomUUID();
  setWorkCoordinationNamespace('human-admission-' + id);
  h.state = undefined;
  h.covered = true;
  h.memberActive = true;
  h.fail = '';
  h.dir = pathResolver.sharedTmp('human-admission-' + id);
  missionId = 'MSN-TEST-' + id.toUpperCase();
  itemId = 'admission-' + id;
  createWorkItem({
    itemId,
    title: 'Update documentation',
    description: 'Document the bounded test outcome',
    status: 'blocked',
    context: { tenant_slug: 'acme', organization_id: 'org-1', project_id: 'proj-1' },
    metadata: {
      requested_work_shape: 'mission',
      admission_only: true,
      mission_id: missionId,
      action_ref: id,
      dot_id: 'dot-test',
      mission_admission: {
        mandate_ref: 'docs',
        mandate_facts: {
          work_type: 'docs',
          paths: ['docs/test.md'],
          estimated_cost: 0,
          currency: 'JPY',
          external_effects: [],
          risk_level: 1,
        },
      },
    },
  });
  run = vi.fn(async (args: string[]) => {
    if (args[0] === 'create') {
      h.state = {
        status: 'planned',
        tier: 'confidential',
        tenant_slug: 'acme',
        organization_id: 'org-1',
        relationships: { project: { project_id: 'proj-1' } },
      };
      safeMkdir(h.dir, { recursive: true });
      if (h.fail === 'create') throw new Error('partial create');
    } else {
      if (h.fail === 'before_start') throw new Error('unknown activation outcome');
      h.state!.status = 'active';
      if (h.fail === 'after_start') throw new Error('process died after activation');
    }
  });
});
afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  const roots = approvalStoreRoots();
  safeRmSync(pathResolver.resolve(roots.coordination + '/brief'), {
    recursive: true,
    force: true,
  });
  safeRmSync(pathResolver.resolve(roots.observability + '/brief'), {
    recursive: true,
    force: true,
  });
  safeRmSync(h.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tick = () => continueHumanMissionAdmission(itemId, { runController: run });
const prepare = () => continueHumanMissionAdmission(itemId, { runController: run, prepare: true });
async function pending() {
  const result = await prepare();
  expect(result.status).toBe('pending_approval');
  return loadApprovalRequest('brief', result.requestId!)!;
}
function decide(id: string, decision: 'approved' | 'rejected' = 'approved') {
  const record = loadApprovalRequest('brief', id)!;
  return decideApprovalRequest('infrastructure_sentinel', {
    channel: 'brief',
    requestId: id,
    decision,
    decidedBy: 'user:test-owner',
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    deciderIdentitySource: 'server_resolved',
    presentedDigest: computeApprovalPresentedDigest(record),
    deciderPrincipal: {
      actor: 'human',
      source: 'session',
      provider: 'test',
      principalId: 'test-owner',
    } as never,
  });
}

describe('same-work human mission admission', () => {
  it('does not prepare from an ordinary watchdog sweep or a metadata pin alone', async () => {
    expect((await tick()).status).toBe('held');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses stale server snapshot version before any controller effect', async () => {
    expect(
      (
        await continueHumanMissionAdmission(itemId, {
          prepare: true,
          expectedVersion: -1,
          runController: run,
        })
      ).status
    ).toBe('held');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses alternate read roots instead of writing claims in another store', async () => {
    expect(
      await continueHumanMissionAdmission(itemId, {
        rootDir: h.dir,
        prepare: true,
        runController: run,
      })
    ).toMatchObject({ status: 'held' });
    expect(run).not.toHaveBeenCalled();
  });
  it('serializes concurrent explicit preparation into one request and one create', async () => {
    const [a, b] = await Promise.all([prepare(), prepare()]);
    expect(a.status).toBe('pending_approval');
    expect(b.requestId).toBe(a.requestId);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reconciles expired ownership only from an exact active receipt', async () => {
    const record = await pending();
    decide(record.id);
    h.fail = 'after_start';
    expect((await tick()).status).toBe('reconciliation_required');
    expireWorkItemLeases(new Date(Date.now() + 86400_000).toISOString());
    h.fail = '';
    expect((await tick()).status).toBe('completed');
    expect(getWorkItem(itemId)?.status).toBe('done');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('refuses changed approved brief without activating or reopening', async () => {
    const record = await pending();
    decide(record.id);
    safeWriteFile(
      path.join(h.dir, 'evidence/mission-brief.json'),
      JSON.stringify({ missionId, intent: 'drift' })
    );
    expect((await tick()).status).toBe('reconciliation_required');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('parks once, then activates the same work once with real durable claims and receipts', async () => {
    const record = await pending();
    expect((await tick()).requestId).toBe(record.id);
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['create']);
    decide(record.id);
    expect(await tick()).toMatchObject({ status: 'completed', requestId: record.id });
    expect(getWorkItem(itemId)?.status).toBe('done');
    expect(loadApprovalRequest('brief', record.id)).toMatchObject({
      applyClaim: { startedBy: 'mission_controller' },
      applyResult: { result: 'success' },
    });
    expect((await tick()).status).toBe('completed');
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['create', 'start']);
  });
  it.each(['rejected', 'cancelled', 'expired', 'revoked'] as const)(
    'never reopens %s on repeated sweeps',
    async (terminal) => {
      const record = await pending();
      if (terminal === 'rejected') decide(record.id, 'rejected');
      else if (terminal === 'cancelled')
        cancelApprovalRequest('infrastructure_sentinel', {
          channel: 'brief',
          requestId: record.id,
        });
      else if (terminal === 'expired')
        expireApprovalRequest('infrastructure_sentinel', {
          channel: 'brief',
          requestId: record.id,
        });
      else {
        decide(record.id);
        revokeApprovalRequest('infrastructure_sentinel', {
          channel: 'brief',
          requestId: record.id,
          revokedBy: 'user:test-owner',
        });
      }
      expect((await tick()).status).toBe('held');
      expect((await tick()).status).toBe('held');
      expect(run).toHaveBeenCalledTimes(1);
      expect(
        listApprovalRequests({ storageChannels: ['brief'] }).filter(
          (r) => r.source?.missionId === missionId
        )
      ).toHaveLength(1);
    }
  );
  it('invalidates changed content and does not request another decision', async () => {
    const record = await pending();
    decide(record.id);
    updateWorkItem({ itemId, description: 'Different outcome' });
    expect((await tick()).status).toBe('held');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('holds a partial create instead of repeating it', async () => {
    h.fail = 'create';
    expect((await prepare()).status).toBe('reconciliation_required');
    h.fail = '';
    expect((await tick()).status).toBe('reconciliation_required');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reconciles activation after a crash without a second start', async () => {
    const record = await pending();
    decide(record.id);
    h.fail = 'after_start';
    expect((await tick()).status).toBe('reconciliation_required');
    h.fail = '';
    expect((await tick()).status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('retains a claim for unknown activation outcomes', async () => {
    const record = await pending();
    decide(record.id);
    h.fail = 'before_start';
    expect((await tick()).status).toBe('reconciliation_required');
    h.fail = '';
    expect((await tick()).status).toBe('reconciliation_required');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not execute a cancelled original WorkItem', async () => {
    const record = await pending();
    decide(record.id);
    updateWorkItem({ itemId, status: 'archived' });
    expect((await tick()).status).toBe('held');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('refuses an approver whose current membership is suspended', async () => {
    const record = await pending();
    decide(record.id);
    h.memberActive = false;
    expect((await tick()).status).toBe('reconciliation_required');
    expect(run).toHaveBeenCalledTimes(1);
    expect(loadApprovalRequest('brief', record.id)?.applyClaim).toBeUndefined();
  });
  it('does not act when the current mandate is revoked', async () => {
    const record = await pending();
    decide(record.id);
    h.covered = false;
    await expect(tick()).rejects.toThrow('mandate revoked');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
