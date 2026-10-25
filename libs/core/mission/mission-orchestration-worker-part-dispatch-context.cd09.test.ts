import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextSecurityScope } from '../context-security-scope.js';
import { ConfidentialTaskDecisionValues } from '../customer-decision/task-decision-values.js';

// CD-09 tier gate (human decision 2026-10-25): a resumed task's confirmed
// customer decisions reach its prompt only when the mission's context pack
// may carry that tenant's confidential data. The pack (its security scope)
// and the mission state are fixtures; the prompt builder, the gate and the
// compaction step are real.
const mocks = vi.hoisted(() => ({
  provisionTaskKnowledge: vi.fn(),
  loadMissionStateSnapshot: vi.fn(),
  maybeCompactDispatchSections: vi.fn(),
}));

vi.mock('../task/task-knowledge-provisioning.js', () => ({
  provisionTaskKnowledge: mocks.provisionTaskKnowledge,
}));

vi.mock('./mission-orchestration-phase-gates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-orchestration-phase-gates.js')>()),
  loadMissionStateSnapshot: mocks.loadMissionStateSnapshot,
}));

vi.mock('./mission-orchestration-worker-part-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./mission-orchestration-worker-part-context.js')>();
  mocks.maybeCompactDispatchSections.mockImplementation(actual.maybeCompactDispatchSections);
  return {
    ...actual,
    maybeCompactDispatchSections: (
      ...args: Parameters<typeof actual.maybeCompactDispatchSections>
    ) => mocks.maybeCompactDispatchSections(...args),
  };
});

const MISSION = 'MSN-CD09-GATE';
const TENANT = 'acme-corp';
const SENTINEL = 'ship-on-nov-first-SENTINEL';
const PACK_TEXT = `## Mission context pack\n${'context line\n'.repeat(30)}PACK-END`;

function scope(overrides: Partial<ContextSecurityScope> = {}): ContextSecurityScope {
  return {
    tenant_slug: TENANT,
    tenant_id: TENANT,
    mission_id: MISSION,
    read_tiers: ['public', 'confidential'],
    write_tier: 'confidential',
    purpose: 'implementer',
    external_egress: 'deny',
    ...overrides,
  };
}

function values(projectId?: string) {
  return new ConfidentialTaskDecisionValues(
    {
      tenantSlug: TENANT,
      caseId: 'case-a',
      consumer: `mission-${MISSION}.task-1`,
      ...(projectId ? { projectId } : {}),
    },
    [
      {
        proposal_id: 'tp-0123456789abcdef',
        agenda_id: 'agd-test0001',
        entry_id: 'release',
        item: 'RELEASE',
        key: 'release.go',
        question: 'May we release?',
        decision_id: 'D-0001',
        value: { approved: true, note: SENTINEL },
      },
    ]
  );
}

const task = {
  task_id: 'task-1',
  status: 'planned',
  assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
  description: 'Implement the widget procedure',
  deliverable: 'deliverables/widget.md',
} as const;

describe('buildTaskDispatchContext CD-09 tier gate', { timeout: 60_000 }, () => {
  let missionPath = '';
  const savedRole = process.env.MISSION_ROLE;
  beforeAll(async () => {
    process.env.MISSION_ROLE = 'mission_controller';
    const { missionDir } = await import('../path-resolver.js');
    const { safeMkdir, safeWriteFile } = await import('../secure-io.js');
    missionPath = missionDir(MISSION, 'public');
    safeMkdir(missionPath, { recursive: true });
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify({
        mission_id: MISSION,
        tier: 'public',
        status: 'active',
        assigned_persona: 'worker',
        git: { branch: 'main', start_commit: '', latest_commit: '', checkpoints: [] },
        history: [],
      })
    );
  });
  afterAll(async () => {
    const { safeExistsSync, safeRmSync } = await import('../secure-io.js');
    if (missionPath && safeExistsSync(missionPath)) safeRmSync(missionPath, { recursive: true });
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });
  beforeEach(() => {
    mocks.loadMissionStateSnapshot.mockReturnValue({
      mission_id: MISSION,
      tier: 'confidential',
      status: 'active',
      assigned_persona: 'worker',
      history: [],
      relationships: {},
    });
  });

  const build = async (input: {
    securityScope?: ContextSecurityScope | null;
    decisionValues?: ConfidentialTaskDecisionValues;
  }) => {
    mocks.provisionTaskKnowledge.mockResolvedValue({
      pack:
        input.securityScope === null
          ? null
          : {
              context_pack_id: 'pack-1',
              summary: 'fixture pack',
              security_scope: input.securityScope ?? scope(),
            },
      text: PACK_TEXT,
      missionContextPackPath: undefined,
      deliveredKnowledgeRefs: [],
    });
    const { buildTaskDispatchContext } =
      await import('./mission-orchestration-worker-part-dispatch-context.js');
    return buildTaskDispatchContext({
      missionId: MISSION,
      task: { ...task, assigned_to: { ...task.assigned_to } },
      teamRole: 'implementer',
      agentId: 'implementation-architect',
      allTasks: [],
      ...(input.decisionValues ? { customerDecisionValues: input.decisionValues } : {}),
    });
  };

  it('a confidential same-tenant mission: the section follows the context pack, far from the prompt head', async () => {
    const context = await build({ decisionValues: values() });
    expect(context.customerDecisionDelivery).toEqual({
      status: 'delivered',
      decision_ids: ['D-0001'],
    });
    const { prompt } = context;
    const heading = prompt.indexOf('## Confirmed customer decisions (confidential');
    expect(heading).toBeGreaterThan(prompt.indexOf('PACK-END'));
    expect(heading).toBeLessThan(prompt.indexOf('Return exactly one ```task_result```'));
    expect(prompt.indexOf(SENTINEL)).toBeGreaterThan(heading);
    // The excerpts logs and observations take (80 / 240 chars) never reach it.
    expect(prompt.slice(0, 240)).not.toMatch(/SENTINEL|Confirmed customer decisions/u);
    // The compaction step never sees the values.
    expect(JSON.stringify(mocks.maybeCompactDispatchSections.mock.calls)).not.toContain(SENTINEL);
  });

  it.each([
    [
      'a public mission',
      scope({ write_tier: 'public', read_tiers: ['public'] }),
      'mission_tier_public',
    ],
    [
      'a personal mission',
      scope({ write_tier: 'personal', read_tiers: ['public', 'personal'] }),
      'mission_tier_personal',
    ],
    ['a degraded context pack', null, 'context_pack_unavailable'],
    [
      "another tenant's mission",
      scope({ tenant_slug: 'other-corp', tenant_id: 'other-corp' }),
      'tenant_scope_mismatch',
    ],
    ['external egress allowed', scope({ external_egress: 'allow' }), 'external_egress_not_denied'],
  ] as const)('%s: the values are withheld (%s)', async (_label, securityScope, reason) => {
    const warn = vi
      .spyOn((await import('../core.js')).logger, 'warn')
      .mockImplementation(() => undefined);
    const context = await build({ securityScope, decisionValues: values() });
    expect(context.customerDecisionDelivery).toEqual({
      status: 'withheld',
      reason,
      decision_ids: ['D-0001'],
    });
    expect(context.prompt).not.toMatch(/SENTINEL|Confirmed customer decisions/u);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('customer_decision_tier_mismatch'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SENTINEL);
    warn.mockRestore();
  });

  it("a case of another project than the pack's is withheld", async () => {
    const context = await build({
      securityScope: scope({ project_id: 'PRJ-1' }),
      decisionValues: values('PRJ-2'),
    });
    expect(context.customerDecisionDelivery).toMatchObject({
      status: 'withheld',
      reason: 'project_scope_mismatch',
    });
  });

  it('unconfirmed proposals only: ids where the gate passes, a count where it would refuse', async () => {
    const notesOnly = () =>
      new ConfidentialTaskDecisionValues(
        { tenantSlug: TENANT, caseId: 'case-a', consumer: `mission-${MISSION}.task-1` },
        [],
        [{ proposal_id: 'tp-0123456789abcdef', reason: 'changed_after_completion' }]
      );
    const confidential = await build({ decisionValues: notesOnly() });
    expect(confidential.prompt).toContain('tp-0123456789abcdef');
    const publicMission = await build({
      securityScope: scope({ write_tier: 'public', read_tiers: ['public'] }),
      decisionValues: notesOnly(),
    });
    // Not blocked (no value), but no proposal id either.
    expect(publicMission.customerDecisionDelivery).toMatchObject({ status: 'delivered' });
    expect(publicMission.prompt).toContain("1 of this task's customer decisions");
    expect(publicMission.prompt).not.toMatch(/tp-[a-f0-9]/u);
  });

  it('a task without decisions gets no section and no delivery record', async () => {
    const context = await build({});
    expect(context).not.toHaveProperty('customerDecisionDelivery');
    expect(context.prompt).not.toContain('Confirmed customer decisions');
  });
});
