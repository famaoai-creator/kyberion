import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EnsureContinuousMissionInput,
  AdvanceContinuousMissionInput,
  EnsureContinuousProjectInput,
} from '@agent/core/organization/continuous-work-owner';
import {
  createContinuousOwnerPorts,
  type ContinuousOwnerAdapterDeps,
} from './continuous_work_owner.js';
import type { ContinuousOwnerProcessOptions } from './continuous_owner_process.js';
import type { AlignmentDecisionReport } from './mission_alignment_decision.js';
import type { WorkItem } from '@agent/core/workforce/work-coordination-types';
import { continuousDevelopmentAlignmentScope } from '@agent/core/organization/continuous-development-consent';

const managed = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./continuous_owner_process.js', () => ({ runContinuousOwnerProcess: managed.run }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  managed.run.mockReset();
});

const scope = { tier: 'public' as const, organization_id: 'org-simple' };
const projectInput: EnsureContinuousProjectInput = {
  assertCurrent: () => {},
  project_id: 'project-simple',
  name: 'Operations',
  summary: 'Improve reliability',
  objective_ids: ['reliability'],
  scope,
  operation_key: 'project-creation',
};
const missionInput: EnsureContinuousMissionInput = {
  assertCurrent: () => {},
  mission_id: 'MSN-CONTINUOUS-TEST',
  project_id: projectInput.project_id,
  key: 'diagnose',
  title: 'Inspect failures',
  goal: 'Restore reliability',
  success_condition: 'No recurring failures',
  prerequisites: ['MSN-PREREQUISITE'],
  scope,
  operation_key: 'mission-creation',
};
const advanceInput: AdvanceContinuousMissionInput = {
  assertCurrent: () => {},
  mission_id: missionInput.mission_id,
  project_id: missionInput.project_id,
  scope,
  operation_key: 'advance-round-1',
  creation_key: missionInput.operation_key,
};
const root = '/workspace/kyberion';
const directory = path.join(root, 'active/missions/public', missionInput.mission_id);
const developmentSpec = {
  cwd: '.',
  repository_url: 'https://github.com/owner/repository',
  source_edit_paths: ['libs/core/example.ts'],
  implementation_task_id: 'execution-implement',
  review_task_id: 'self_review-code-review',
  title: 'fix: restore reliability',
  body_file: 'evidence/pr-body.md',
};

function harness(options: { present?: boolean; status?: string; gated?: boolean } = {}) {
  let present = options.present ?? true;
  let status = options.status ?? 'active';
  let projectPresent = true;
  const files = new Map<string, unknown>();
  const projectRecord = {
    ...projectInput,
    tier: scope.tier,
    organization_id: scope.organization_id,
    metadata: { continuous_operation_key: projectInput.operation_key },
  };
  const state = () => ({
    mission_id: missionInput.mission_id,
    status,
    tier: scope.tier,
    organization_id: scope.organization_id,
    relationships: { project: { project_id: projectInput.project_id } },
    process_template: {
      phase_specs: options.gated
        ? [
            { id: 'alignment', exit_gate: { id: 'ALIGNMENT_APPROVED' } },
            { id: 'execution', exit_gate: { id: 'EXECUTION_DONE' } },
            { id: 'review', exit_gate: { id: 'REVIEW_DONE' } },
          ]
        : [],
    },
  });
  let currentState = state();
  let tasks: Record<string, unknown>[] = [
    { task_id: 'task-1', phase: 'execution', status: 'planned' },
  ];
  const exec = vi.fn(
    async (_command: string, args: string[], _options: ContinuousOwnerProcessOptions) => {
      if (args[1] === 'create') {
        present = true;
        projectPresent = true;
      }
      if (args[1] === 'start' || (args[1] === 'gate-pass' && args[3] === 'ALIGNMENT_APPROVED')) {
        status = 'active';
        currentState = state();
      }
      return { stdout: '', stderr: '', status: 0 };
    }
  );
  const openApproval = vi.fn(() => ({
    missionId: missionInput.mission_id,
    requestId: 'approval-1',
    created: true,
    payloadHash: 'bound-hash',
    briefPath: path.join(directory, 'evidence/mission-brief.json'),
  }));
  const assessApproval = vi.fn((): AlignmentDecisionReport => ({
    missionId: missionInput.mission_id,
    satisfied: true,
    verdict: 'approved' as const,
    requestId: 'approval-1',
    reasons: [],
  }));
  const workItems = vi.fn((): WorkItem[] => []);
  const updateItem = vi.fn((input) => input as WorkItem);
  const deps: ContinuousOwnerAdapterDeps = {
    rootDir: root,
    exec,
    project: () =>
      projectPresent
        ? (projectRecord as unknown as ReturnType<
            NonNullable<ContinuousOwnerAdapterDeps['project']>
          >)
        : null,
    mission: () =>
      currentState as unknown as ReturnType<NonNullable<ContinuousOwnerAdapterDeps['mission']>>,
    missionPath: () => (present ? directory : undefined),
    read: (file) => files.get(file),
    write: (file, value) => {
      files.set(file, value);
    },
    exists: (file) => file.endsWith('.js') || files.has(file),
    openApproval,
    assessApproval,
    brief: (file) =>
      files.get(file) as ReturnType<NonNullable<ContinuousOwnerAdapterDeps['brief']>>,
    tasks: () => tasks,
    missionScope: (_input, run) => run(),
    configureDevelopmentGates: vi.fn(),
    board: (_dir, update) => {
      const next = typeof update === 'function' ? update(tasks) : update;
      if (next) tasks = next;
      return next !== undefined;
    },
    // A superseded row with task_id 'proven' carries the mission-side proof.
    supersedeProven: (_missionId, taskId) => taskId === 'proven',
    workItems,
    updateItem,
  };
  const initialBrief = {
    missionId: missionInput.mission_id,
    title: missionInput.title,
    intent: missionInput.goal,
    tier: scope.tier,
    projectId: missionInput.project_id,
    victoryConditions: [missionInput.success_condition],
    source: { kind: 'continuous_operations', ref: missionInput.operation_key },
    gate: { approvalRequired: true },
  };
  if (present) files.set(path.join(directory, 'evidence/mission-brief.json'), initialBrief);
  files.set(path.join(directory, 'evidence/continuous-owner.json'), {
    operation_key: missionInput.operation_key,
    ...(present
      ? { brief_hash: createHash('sha256').update(JSON.stringify(initialBrief)).digest('hex') }
      : {}),
  });
  return {
    deps,
    exec,
    files,
    openApproval,
    assessApproval,
    workItems,
    updateItem,
    ports: createContinuousOwnerPorts(deps),
    bindDevelopment() {
      const file = path.join(directory, 'evidence/continuous-owner.json');
      const briefFile = path.join(directory, 'evidence/mission-brief.json');
      const brief = {
        ...(files.get(briefFile) as Record<string, unknown>),
        scope: {
          in: [missionInput.goal, ...continuousDevelopmentAlignmentScope(developmentSpec, scope)],
          out: ['Unapproved external effects', 'Cross-tenant access'],
        },
      };
      files.set(briefFile, brief);
      files.set(file, {
        ...(files.get(file) as Record<string, unknown>),
        development: developmentSpec,
        brief_hash: createHash('sha256').update(JSON.stringify(brief)).digest('hex'),
        development_hash: createHash('sha256')
          .update(JSON.stringify(developmentSpec))
          .digest('hex'),
      });
    },
    setProjectPresent(value: boolean) {
      projectPresent = value;
    },
    setState(value: object) {
      currentState = { ...currentState, ...value };
    },
    setTasks(value: Record<string, unknown>[]) {
      tasks = value;
    },
  };
}

describe('continuous work production owner ports', () => {
  it.each(['public', 'confidential', 'personal'] as const)(
    'binds the canonical mission handoff before advancing %s work',
    async (tier) => {
      const h = harness();
      const selected = {
        tier,
        organization_id: scope.organization_id,
        ...(tier === 'confidential' ? { tenant_slug: 'acme' } : {}),
      };
      const observed: unknown[] = [];
      h.deps.missionScope = (input) => {
        observed.push(input);
        throw new Error('scope handoff refused');
      };
      await expect(h.ports.advanceMission({ ...advanceInput, scope: selected })).rejects.toThrow(
        'scope handoff refused'
      );
      expect(observed).toEqual([
        {
          mission_id: advanceInput.mission_id,
          scope: selected,
          assertCurrent: advanceInput.assertCurrent,
        },
      ]);
      expect(h.exec).not.toHaveBeenCalled();
    }
  );
  it('configures typed development gates from the pinned descriptor before alignment is requested', async () => {
    const h = harness({ present: false });
    await h.ports.ensureMission({ ...missionInput, development: developmentSpec });
    expect(h.files.get(path.join(directory, 'evidence/continuous-owner.json'))).toMatchObject({
      development: developmentSpec,
    });
    const brief = h.files.get(path.join(directory, 'evidence/mission-brief.json')) as {
      scope: { in: string[] };
    };
    expect(brief.scope.in).toContain(
      `Exact approved source file: ${developmentSpec.source_edit_paths[0]}`
    );
    expect(
      brief.scope.in.some((line) =>
        line.includes(
          'Automatic effects: implement, test, repair, push, create PR, independent review, merge'
        )
      )
    ).toBe(true);
    expect(brief.scope.in.some((line) => line.includes('evidence/continuous-owner.json'))).toBe(
      true
    );
    expect(h.deps.configureDevelopmentGates).toHaveBeenCalledWith({
      missionId: missionInput.mission_id,
      development: developmentSpec,
      assertCurrent: missionInput.assertCurrent,
    });
    expect(vi.mocked(h.deps.configureDevelopmentGates!).mock.invocationCallOrder[0]).toBeLessThan(
      h.openApproval.mock.invocationCallOrder[0]!
    );
  });
  it('passes existing verified publication references to the actual delivery prompt without changing acceptance criteria', async () => {
    const h = harness();
    h.bindDevelopment();
    h.setTasks([
      {
        task_id: 'delivery-deliver',
        phase: 'delivery',
        description: 'Submit the reviewed PR',
        status: 'requested',
      },
    ]);
    const delivery = {
      item_id: 'WI-DELIVERY',
      version: 1,
      status: 'ready',
      description: 'Submit the reviewed PR',
      context: {
        mission_id: missionInput.mission_id,
        task_id: 'delivery-deliver',
        project_id: missionInput.project_id,
        organization_id: scope.organization_id,
      },
      metadata: { acceptance_criteria: ['PR already exists'] },
    } as unknown as WorkItem;
    const foreign = {
      ...delivery,
      item_id: 'WI-FOREIGN',
      context: { ...delivery.context!, tenant_slug: 'other' },
    };
    h.workItems.mockReturnValue([delivery, foreign]);
    const evidence = ['https://github.com/owner/repository/pull/1', `commit:${'a'.repeat(40)}`];
    h.deps.development = vi.fn(async () => ({
      status: 'completed' as const,
      reason: 'Immutable merge verified',
      evidence_refs: evidence,
    }));
    await h.ports.advanceMission({ ...advanceInput, development: developmentSpec });
    const update = h.updateItem.mock.calls.find(
      ([value]) => value.itemId === delivery.item_id
    )?.[0];
    expect(update).toMatchObject({
      expectedVersion: 1,
      metadata: { acceptance_criteria: ['PR already exists'] },
    });
    expect(h.updateItem.mock.calls.some(([value]) => value.itemId === foreign.item_id)).toBe(false);
    const { buildWorkItemPromptBody } =
      await import('@agent/core/mission/mission-workitem-dispatch-execution');
    const prompt = buildWorkItemPromptBody({
      missionId: missionInput.mission_id,
      item: { ...delivery, description: update!.description!, metadata: update!.metadata },
    });
    expect(prompt).toContain('Do not create another PR, push, merge, or repeat publication');
    expect(prompt).toContain(evidence[0]);
    expect(prompt).toContain(evidence[1]);
    expect(h.deps.tasks!('unused', missionInput.mission_id)?.[0]?.description).toContain(
      'VERIFIED_DEVELOPMENT_PUBLICATION'
    );
  });
  it('routes development execution through the supervised controller with exact WorkItem ids', async () => {
    const h = harness();
    h.bindDevelopment();
    h.setTasks([{ task_id: 'execution-implement', phase: 'execution', status: 'requested' }]);
    managed.run.mockResolvedValue({ stdout: '', stderr: '', status: 0 });
    const module = await import('@agent/core/mission/mission-development-continuation');
    vi.spyOn(module, 'advanceMissionDevelopment').mockImplementation(async (_input, ports) => {
      await ports!.dispatch!(h.deps.mission!(advanceInput.mission_id)!, {
        itemIds: ['WI-IMPLEMENTATION'],
        limit: 1,
      });
      return {
        status: 'running',
        reason: 'Reconcile the actual child result next turn',
        evidence_refs: [],
      };
    });
    const ports = createContinuousOwnerPorts({ ...h.deps, exec: undefined });
    const abort = new AbortController();
    expect(
      await ports.advanceMission({
        ...advanceInput,
        development: developmentSpec,
        signal: abort.signal,
      })
    ).toMatchObject({ status: 'running' });
    expect(managed.run).toHaveBeenCalledOnce();
    expect(managed.run).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(root, 'dist/scripts/mission_controller.bundle.js'),
        'dispatch-workitems',
        advanceInput.mission_id,
        '--dispatch-item-ids',
        'WI-IMPLEMENTATION',
        '--dispatch-limit',
        '1',
        '--dispatch-rounds',
        '1',
        '--dispatch-statuses',
        'ready,backlog',
        '--dispatch-final-status',
        'done',
      ],
      expect.objectContaining({
        cwd: root,
        signal: abort.signal,
        timeoutMs: 120_000,
        maxOutputMB: 2,
      })
    );
  });
  it('refuses a development controller dispatch without exact WorkItem narrowing', async () => {
    const h = harness();
    h.bindDevelopment();
    const module = await import('@agent/core/mission/mission-development-continuation');
    vi.spyOn(module, 'advanceMissionDevelopment').mockImplementation(async (_input, ports) => {
      await ports!.dispatch!(h.deps.mission!(advanceInput.mission_id)!, {});
      return { status: 'running', reason: 'unreachable', evidence_refs: [] };
    });
    await expect(
      h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
    ).rejects.toThrow('exact mission WorkItems');
    expect(h.exec.mock.calls.some((call) => call[1][1] === 'dispatch-workitems')).toBe(false);
  });
  it('requires the exact pinned development spec before any continuation effect', async () => {
    const h = harness();
    h.bindDevelopment();
    h.deps.development = vi.fn();
    await expect(
      h.ports.advanceMission({
        ...advanceInput,
        development: { ...developmentSpec, title: 'Unreviewed title' },
      })
    ).rejects.toThrow('development specification drift');
    expect(h.deps.development).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });
  it.each(['active', 'completed', 'archived'])(
    'does not accept completed task files as merged development proof in %s missions',
    async (status) => {
      const h = harness({ status });
      h.bindDevelopment();
      h.setTasks([{ task_id: 'delivery', phase: 'delivery', status: 'completed' }]);
      h.setState({ verification: { status: 'verified' } });
      h.deps.development = vi.fn(async () => ({
        status: 'running' as const,
        reason: 'Awaiting immutable merged commit CI',
        evidence_refs: ['pr:1'],
      }));
      expect(
        await h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
      ).toMatchObject({ status: 'running' });
      expect(
        h.exec.mock.calls.some((call) =>
          ['verify', 'distill', 'dispatch-workitems'].includes(call[1][1]!)
        )
      ).toBe(false);
    }
  );
  it('keeps existing prerequisite dispatch reachable before implementation exists', async () => {
    const h = harness();
    h.bindDevelopment();
    h.deps.development = vi.fn(async () => ({
      status: 'running' as const,
      reason: 'Prepare canonical implementation WorkItem',
      evidence_refs: [],
      allow_task_dispatch: true,
    }));
    expect(
      await h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
    ).toMatchObject({ status: 'running' });
    expect(h.exec.mock.calls.some((call) => call[1][1] === 'dispatch-workitems')).toBe(true);
  });
  it('retains exact runtime approval waiting without dispatching delivery', async () => {
    const h = harness();
    h.bindDevelopment();
    h.deps.development = vi.fn(async () => ({
      status: 'pending_approval' as const,
      reason: 'Publication needs owner approval',
      evidence_refs: [],
      approval_request_id: 'publication-approval',
    }));
    expect(
      await h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
    ).toMatchObject({ status: 'pending_approval', approval_request_id: 'publication-approval' });
    expect(h.exec.mock.calls.some((call) => call[1][1] === 'dispatch-workitems')).toBe(false);
  });
  it('withholds the delivery phase gate until immutable development proof is complete', async () => {
    const h = harness();
    h.bindDevelopment();
    h.setTasks([{ task_id: 'delivery', phase: 'delivery', status: 'completed' }]);
    h.setState({
      process_template: { phase_specs: [{ id: 'delivery', exit_gate: { id: 'DELIVERED' } }] },
    });
    h.deps.development = vi.fn(async () => ({
      status: 'running' as const,
      reason: 'CI pending',
      evidence_refs: [],
    }));
    await h.ports.advanceMission({ ...advanceInput, development: developmentSpec });
    expect(h.exec.mock.calls.some((call) => call[1][1] === 'gate-pass')).toBe(false);
    h.deps.development = vi.fn(async () => ({
      status: 'completed' as const,
      reason: 'Immutable merge proof verified',
      evidence_refs: ['merge:verified'],
    }));
    await h.ports.advanceMission({ ...advanceInput, development: developmentSpec });
    expect(
      h.exec.mock.calls.some((call) => call[1][1] === 'gate-pass' && call[1][3] === 'DELIVERED')
    ).toBe(true);
  });
  it('keeps merged development with pending postmerge CI in the continuation instead of invoking its review phase gate', async () => {
    const h = harness();
    h.bindDevelopment();
    h.setTasks([{ task_id: 'self_review-code-review', phase: 'self_review', status: 'completed' }]);
    h.setState({
      process_template: {
        phase_specs: [{ id: 'self_review', exit_gate: { id: 'CODE_REVIEW_PASSED' } }],
      },
    });
    h.deps.development = vi.fn(async () => ({
      status: 'running' as const,
      reason: 'Known merge is waiting for required postmerge CI',
      evidence_refs: [`commit:${'a'.repeat(40)}`],
    }));
    expect(
      await h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
    ).toMatchObject({ status: 'running' });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.deps.development).toHaveBeenCalledOnce();
  });
  it.each(['pending', 'waiting', 'green', 'raced', 'invalid'] as const)(
    'keeps TESTS bound to current CI (%s), never a stale closed report',
    async (mode) => {
      const h = harness();
      h.bindDevelopment();
      h.setTasks([{ task_id: 'test-test-run', phase: 'test', status: 'completed' }]);
      h.setState({
        process_template: { phase_specs: [{ id: 'test', exit_gate: { id: 'TESTS_PASSED' } }] },
      });
      h.deps.development = vi.fn(async () => ({
        status: 'running' as const,
        reason: 'CI reconciliation',
        evidence_refs: [],
        ci_verified: mode !== 'pending',
      }));
      h.deps.developmentProof = vi.fn(async () =>
        mode === 'waiting'
          ? { ok: false, waiting: true, reason: 'Required CI changed' }
          : { ok: true }
      );
      if (mode === 'raced' || mode === 'invalid')
        h.exec.mockImplementation(async () => ({
          stdout: '',
          stderr: `${mode === 'raced' ? '[DEVELOPMENT_CI_WAITING] ' : ''}Machine-only gate checks failed: ${missionInput.mission_id}/TESTS_PASSED`,
          status: 1,
        }));
      if (mode === 'invalid')
        await expect(
          h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
        ).rejects.toThrow();
      else
        expect(
          await h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
        ).toMatchObject({ status: 'running' });
      expect(h.exec.mock.calls.filter((call) => call[1][1] === 'gate-pass')).toHaveLength(
        mode === 'pending' || mode === 'waiting' ? 0 : 1
      );
      expect(h.exec.mock.calls.some((call) => call[1][1] === 'dispatch-workitems')).toBe(false);
    }
  );
  it('does not classify invalid CI proof as ordinary waiting', async () => {
    const h = harness();
    h.bindDevelopment();
    h.setTasks([{ task_id: 'test-test-run', phase: 'test', status: 'completed' }]);
    h.setState({
      process_template: { phase_specs: [{ id: 'test', exit_gate: { id: 'TESTS_PASSED' } }] },
    });
    h.deps.development = vi.fn(async () => ({
      status: 'running' as const,
      reason: 'CI evidence',
      evidence_refs: [],
      ci_verified: true,
    }));
    h.deps.developmentProof = vi.fn(async () => ({
      ok: false,
      reason: 'Development gate scope drift',
    }));
    expect(
      await h.ports.advanceMission({ ...advanceInput, development: developmentSpec })
    ).toMatchObject({ status: 'blocked' });
    expect(h.exec).not.toHaveBeenCalled();
  });
  it('rechecks original authority after a completed child before writing evidence or opening approval', async () => {
    const h = harness({ present: false });
    let revoked = false;
    const assertCurrent = vi.fn(() => {
      if (revoked) throw new Error('Original authority revoked');
    });
    h.exec.mockImplementation(async () => {
      revoked = true;
      return { stdout: '', stderr: '', status: 0 };
    });
    const write = vi.fn();
    const ports = createContinuousOwnerPorts({ ...h.deps, write });
    await expect(ports.ensureMission({ ...missionInput, assertCurrent })).rejects.toThrow(
      'authority revoked'
    );
    expect(h.exec).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(h.openApproval).not.toHaveBeenCalled();
  });
  it('does not spawn another controller after authority is revoked during the previous command', async () => {
    const h = harness({ status: 'planned', gated: true });
    let revoked = false;
    const original = h.exec.getMockImplementation()!;
    h.exec.mockImplementation(async (...args) => {
      const result = await original(...args);
      revoked = true;
      return result;
    });
    await expect(
      h.ports.advanceMission({
        ...advanceInput,
        assertCurrent: () => {
          if (revoked) throw new Error('Original authority revoked');
        },
      })
    ).rejects.toThrow('authority revoked');
    expect(h.exec).toHaveBeenCalledOnce();
  });
  it.each([1, 2, 3])(
    'rechecks authority before each evidence write and approval after write %s',
    async (revokeAfterWrite) => {
      const h = harness({ present: false });
      let writes = 0;
      let revoked = false;
      const write = vi.fn((file: string, value: unknown) => {
        h.files.set(file, value);
        writes++;
        if (writes === revokeAfterWrite) revoked = true;
      });
      const ports = createContinuousOwnerPorts({ ...h.deps, write });
      await expect(
        ports.ensureMission({
          ...missionInput,
          assertCurrent: () => {
            if (revoked) throw new Error('Original authority revoked');
          },
        })
      ).rejects.toThrow('authority revoked');
      expect(write).toHaveBeenCalledTimes(revokeAfterWrite);
      expect(h.openApproval).not.toHaveBeenCalled();
    }
  );
  it('checks live original authority immediately before the managed child seam', async () => {
    const h = harness();
    await expect(
      h.ports.advanceMission({
        ...advanceInput,
        assertCurrent: () => {
          throw new Error('Original authority revoked');
        },
      })
    ).rejects.toThrow('authority revoked');
    expect(h.exec).not.toHaveBeenCalled();
  });
  it('reuses the exact scoped project without child creation and rejects metadata or scope collisions', async () => {
    const h = harness();
    expect(await h.ports.ensureProject(projectInput)).toEqual({
      project_id: projectInput.project_id,
    });
    expect(h.exec).not.toHaveBeenCalled();
    for (const input of [
      { ...projectInput, operation_key: 'different-creation' },
      { ...projectInput, summary: 'Changed goal' },
      { ...projectInput, scope: { ...scope, organization_id: 'another-org' } },
    ])
      await expect(h.ports.ensureProject(input)).rejects.toThrow('identity mismatch');
    expect(h.exec).not.toHaveBeenCalled();
  });
  it('creates projects through the controller with scope and origin metadata', async () => {
    const h = harness();
    h.setProjectPresent(false);
    await h.ports.ensureProject(projectInput);
    const [command, args, child] = h.exec.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual([
      path.join(root, 'dist/scripts/project_controller.js'),
      'create',
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        '--project-id',
        projectInput.project_id,
        '--organization-id',
        scope.organization_id,
        '--tier',
        'public',
        '--metadata',
        JSON.stringify({ continuous_operation_key: projectInput.operation_key }),
        '--objective-ids',
        'reliability',
      ])
    );
    expect(child.env.KYBERION_ORGANIZATION_ID).toBe(scope.organization_id);
  });
  it('creates a scoped mission, durable origin and hash-bound approval brief; changed replay is rejected', async () => {
    const h = harness({ present: false });
    await h.ports.ensureMission(missionInput);
    const args = h.exec.mock.calls[0][1];
    expect(args).toEqual(
      expect.arrayContaining([
        'create',
        missionInput.mission_id,
        '--tier',
        'public',
        '--organization-id',
        scope.organization_id,
        '--project-id',
        missionInput.project_id,
        '--prerequisites',
        'MSN-PREREQUISITE',
      ])
    );
    const marker = h.files.get(path.join(directory, 'evidence/continuous-owner.json'));
    expect(marker).toMatchObject({
      operation_key: missionInput.operation_key,
      project_id: missionInput.project_id,
      scope,
      request_hash: createHash('sha256')
        .update(JSON.stringify({ ...missionInput, signal: undefined }))
        .digest('hex'),
    });
    const brief = h.files.get(path.join(directory, 'evidence/mission-brief.json'));
    expect(brief).toMatchObject({
      missionId: missionInput.mission_id,
      projectId: missionInput.project_id,
      intent: missionInput.goal,
      victoryConditions: [missionInput.success_condition],
      source: { kind: 'continuous_operations', ref: missionInput.operation_key },
      gate: { approvalRequired: true },
    });
    expect(h.openApproval).toHaveBeenCalledWith(missionInput.mission_id, {
      requestedBy: 'continuous-owner',
    });
    await h.ports.ensureMission(missionInput);
    expect(h.exec).toHaveBeenCalledOnce();
    await expect(
      h.ports.ensureMission({ ...missionInput, success_condition: 'Different result' })
    ).rejects.toThrow('specification drift');
    expect(h.openApproval).toHaveBeenCalledTimes(2);
  });
  it('passes the confidential tenant context to the child without inheriting the parent mission or customer stance', async () => {
    const h = harness({ present: false });
    const tenantScope = {
      tier: 'confidential' as const,
      tenant_slug: 'kyberion-service-studio',
      organization_id: scope.organization_id,
    };
    h.setState({ tier: tenantScope.tier, tenant_slug: tenantScope.tenant_slug });
    vi.stubEnv('MISSION_ID', 'MSN-PARENT');
    vi.stubEnv('KYBERION_CUSTOMER', 'parent-customer');
    vi.stubEnv('KYBERION_PROJECT_ID', 'parent-project');
    await h.ports.ensureMission({ ...missionInput, scope: tenantScope });
    const [, args, child] = h.exec.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        '--tier',
        'confidential',
        '--tenant-slug',
        tenantScope.tenant_slug,
        '--organization-id',
        scope.organization_id,
        '--project-id',
        projectInput.project_id,
      ])
    );
    expect(child.env).toMatchObject({
      KYBERION_TENANT: tenantScope.tenant_slug,
      KYBERION_ORGANIZATION_ID: scope.organization_id,
    });
    expect(child.env.MISSION_ID).toBeUndefined();
    expect(child.env.KYBERION_CUSTOMER).toBeUndefined();
    expect(child.env.KYBERION_PROJECT_ID).toBeUndefined();
  });
  it.each(['pending', 'rejected'] as const)(
    'does not dispatch when alignment is %s',
    async (verdict) => {
      const h = harness();
      h.assessApproval.mockReturnValue({
        missionId: missionInput.mission_id,
        satisfied: false,
        verdict,
        requestId: 'approval-1',
        reasons: ['Waiting for the owner'],
      } as ReturnType<NonNullable<ContinuousOwnerAdapterDeps['assessApproval']>>);
      expect(await h.ports.advanceMission(advanceInput)).toMatchObject({
        status: verdict === 'rejected' ? 'blocked' : 'pending_approval',
      });
      expect(h.exec).not.toHaveBeenCalled();
    }
  );
  it.each([true, false])(
    'activates an approved planned mission with gated=%s then bounded native dispatch',
    async (gated) => {
      const h = harness({ status: 'planned', gated });
      await h.ports.advanceMission(advanceInput);
      const commands = h.exec.mock.calls.map((call) => call[1].slice(1));
      expect(commands[0]).toEqual(
        gated
          ? ['gate-pass', missionInput.mission_id, 'ALIGNMENT_APPROVED', '--machine-only']
          : [
              'start',
              missionInput.mission_id,
              '--goal',
              missionInput.goal,
              '--success-condition',
              missionInput.success_condition,
            ]
      );
      expect(commands[1]).toEqual([
        'dispatch-tickets',
        missionInput.mission_id,
        '--ticket-targets',
        'workitem',
      ]);
      expect(commands[2]).toEqual([
        'dispatch-workitems',
        missionInput.mission_id,
        '--dispatch-limit',
        '1',
        '--dispatch-rounds',
        '1',
        '--dispatch-statuses',
        'ready',
        '--dispatch-final-status',
        'done',
      ]);
    }
  );
  it('passes only gates whose own phase contracts have all completed', async () => {
    const h = harness({ gated: true });
    h.setTasks([
      { task_id: 'done', phase: 'execution', status: 'completed' },
      { task_id: 'proven', phase: 'execution', status: 'superseded' },
      { task_id: 'open-review', phase: 'review', status: 'pending' },
    ]);
    await h.ports.advanceMission(advanceInput);
    const gates = h.exec.mock.calls
      .map((call) => call[1])
      .filter((args) => args[1] === 'gate-pass')
      .map((args) => args[3]);
    expect(gates).toEqual(['EXECUTION_DONE']);
    for (const [, args] of h.exec.mock.calls.filter((call) => call[1][1] === 'gate-pass'))
      expect(args).toContain('--machine-only');
  });
  it.each([2, 3, -1, 'invalid'])(
    'blocks exhausted or invalid rework %s with recovery evidence',
    async (count) => {
      const h = harness();
      h.workItems.mockReturnValue([
        {
          item_id: 'needs-review',
          status: 'review',
          version: 4,
          context: {
            ...scope,
            mission_id: missionInput.mission_id,
            project_id: missionInput.project_id,
          },
          metadata: { rework_count: count },
        } as unknown as WorkItem,
      ]);
      const result = await h.ports.advanceMission(advanceInput);
      expect(result).toMatchObject({
        status: 'blocked',
        evidence_refs: ['mission:' + missionInput.mission_id, 'workitem:needs-review'],
      });
      expect(result.reason).toContain(
        'child WorkItem and its blocked continuous-owner WorkItem to ready'
      );
      expect(h.updateItem).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: 'needs-review',
          status: 'blocked',
          expectedVersion: 4,
          rootDir: root,
          metadata: expect.objectContaining({
            rework_count: count,
            blocked_reason: expect.stringContaining('operator intervention'),
          }),
        })
      );
      expect(h.exec.mock.calls.some((call) => call[1][1] === 'verify')).toBe(false);
    }
  );
  it('requeues eligible work only within its exact typed scope and reports existing blockers', async () => {
    const h = harness();
    const context = {
      ...scope,
      mission_id: missionInput.mission_id,
      project_id: missionInput.project_id,
    };
    const item = {
      item_id: 'retry',
      status: 'review',
      version: 2,
      context,
      metadata: { rework_count: 1 },
    };
    h.workItems.mockReturnValue([
      item,
      { ...item, item_id: 'other-tenant', context: { ...context, tenant_slug: 'other' } },
      {
        ...item,
        item_id: 'label-only',
        context: undefined,
        labels: [`mission:${missionInput.mission_id}`],
      },
    ] as unknown as WorkItem[]);
    expect(await h.ports.advanceMission(advanceInput)).toMatchObject({ status: 'running' });
    expect(h.updateItem).toHaveBeenCalledTimes(1);
    expect(h.updateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ready',
        metadata: expect.objectContaining({ rework_count: 2 }),
      })
    );
    h.updateItem.mockClear();
    h.workItems.mockReturnValue([{ ...item, status: 'blocked' }] as unknown as WorkItem[]);
    expect(await h.ports.advanceMission(advanceInput)).toMatchObject({ status: 'blocked' });
    expect(h.updateItem).not.toHaveBeenCalled();
  });
  it('keeps the continuous owner waiting while a child runtime approval is pending', async () => {
    const h = harness();
    h.workItems.mockReturnValue([
      {
        item_id: 'approval-child',
        status: 'blocked',
        version: 1,
        context: {
          ...scope,
          mission_id: missionInput.mission_id,
          project_id: missionInput.project_id,
        },
        metadata: { awaiting_approval: true, approval_request_id: 'approval-runtime' },
      } as unknown as WorkItem,
    ]);
    expect(await h.ports.advanceMission(advanceInput)).toMatchObject({
      status: 'pending_approval',
      approval_request_id: 'approval-runtime',
    });
    expect(h.updateItem).not.toHaveBeenCalled();
  });

  it('continues existing work without calling native ticket creation when no planned tasks remain', async () => {
    const h = harness();
    h.setTasks([{ task_id: 'reviewed', status: 'reviewed' }]);
    h.exec.mockImplementation(async (_command, args) => {
      if (args[1] === 'dispatch-tickets') throw new Error('No planned tasks available');
      return { stdout: '', stderr: '', status: 0 };
    });
    expect(await h.ports.advanceMission(advanceInput)).toMatchObject({ status: 'running' });
    expect(h.exec.mock.calls.map((call) => call[1][1])).toEqual(['dispatch-workitems']);
  });
  it('rejects any brief mutation before approval, phase transitions or task dispatch', async () => {
    const h = harness({ status: 'planned', gated: true });
    const file = path.join(directory, 'evidence/mission-brief.json');
    const original = h.files.get(file) as Record<string, unknown>;
    h.files.set(file, { ...original, title: 'Mutated after approval' });
    await expect(h.ports.advanceMission(advanceInput)).rejects.toThrow('brief drift');
    expect(h.assessApproval).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });
  it('fails closed when a mission lacks the original brief pin', async () => {
    const h = harness();
    h.files.set(path.join(directory, 'evidence/continuous-owner.json'), {
      operation_key: missionInput.operation_key,
    });
    await expect(h.ports.advanceMission(advanceInput)).rejects.toThrow('missing immutable pin');
    expect(h.exec).not.toHaveBeenCalled();
  });
  it.each([
    { tasks: [], verification: { status: 'verified' }, result: 'blocked' },
    { tasks: [{ status: 'pending' }], verification: { status: 'verified' }, result: 'blocked' },
    { tasks: [{ status: 'completed' }], verification: { status: 'pending' }, result: 'blocked' },
    { tasks: [{ status: 'completed' }], verification: { status: 'verified' }, result: 'completed' },
    // A superseded contract (supersede-task, human-approved) is closed; its
    // replacement must still complete.
    {
      tasks: [{ task_id: 'proven', status: 'superseded' }, { status: 'completed' }],
      verification: { status: 'verified' },
      result: 'completed',
    },
    // An unproven superseded status (hand-edited, no approved request) is pending.
    {
      tasks: [{ task_id: 'forged', status: 'superseded' }, { status: 'completed' }],
      verification: { status: 'verified' },
      result: 'blocked',
    },
    {
      tasks: [{ task_id: 'proven', status: 'superseded' }, { status: 'pending' }],
      verification: { status: 'verified' },
      result: 'blocked',
    },
    {
      tasks: [{ task_id: 'proven', status: 'superseded' }],
      verification: { status: 'verified' },
      result: 'blocked',
    },
  ])(
    'requires all contracts and verified evidence before accepting terminal success: $result',
    async ({ tasks, verification, result }) => {
      const h = harness({ status: 'completed' });
      h.setTasks(tasks);
      h.setState({ verification });
      expect(await h.ports.advanceMission(advanceInput)).toMatchObject({ status: result });
      expect(h.exec).not.toHaveBeenCalled();
      expect(h.assessApproval).not.toHaveBeenCalled();
    }
  );
  it('rejects creation ownership mismatch even with a matching advance round key', async () => {
    const h = harness();
    await expect(
      h.ports.advanceMission({ ...advanceInput, creation_key: advanceInput.operation_key })
    ).rejects.toThrow('owner identity');
    expect(h.exec).not.toHaveBeenCalled();
  });
  it.each(['completed', 'archived'])(
    'recovers pending learning before accepting a %s child',
    async (status) => {
      const h = harness({ status });
      h.setTasks([{ status: 'completed' }]);
      h.setState({ verification: { status: 'verified' } });
      const outboxPath = path.join(directory, 'evidence/memory-promotion-outbox.json');
      const outbox = { version: 1, mission_id: missionInput.mission_id, status: 'pending' };
      h.files.set(outboxPath, outbox);
      h.exec.mockImplementation(async (_command, args) => {
        expect(args.slice(1)).toEqual(['distill', missionInput.mission_id]);
        h.files.set(outboxPath, { ...outbox, status: 'delivered' });
        return { stdout: '', stderr: '', status: 0 };
      });
      expect(await h.ports.advanceMission(advanceInput)).toMatchObject({ status: 'completed' });
      expect(h.exec).toHaveBeenCalledTimes(1);
      expect(h.assessApproval).not.toHaveBeenCalled();
    }
  );
  it('does not release a completed child while learning registration is still pending', async () => {
    const h = harness({ status: 'completed' });
    h.setTasks([{ status: 'completed' }]);
    h.setState({ verification: { status: 'verified' } });
    h.files.set(path.join(directory, 'evidence/memory-promotion-outbox.json'), {
      version: 1,
      mission_id: missionInput.mission_id,
      status: 'pending',
    });
    await expect(h.ports.advanceMission(advanceInput)).rejects.toThrow(
      'learning registration remains pending'
    );
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it('never invokes the managed child seam for a pre-aborted command and propagates the live signal', async () => {
    const h = harness({ status: 'active' });
    const controller = new AbortController();
    controller.abort();
    const productionPorts = createContinuousOwnerPorts({ ...h.deps, exec: undefined });
    await expect(
      productionPorts.advanceMission({ ...advanceInput, signal: controller.signal })
    ).rejects.toThrow('aborted');
    expect(managed.run).not.toHaveBeenCalled();
    const live = new AbortController();
    managed.run.mockResolvedValue({ stdout: '', stderr: '', status: 0 });
    await productionPorts.advanceMission({ ...advanceInput, signal: live.signal });
    expect(managed.run).toHaveBeenCalledTimes(2);
    for (const call of managed.run.mock.calls) expect(call[2].signal).toBe(live.signal);
  });
  it('stops the next command when its lease signal expires during a child command', async () => {
    const h = harness({ status: 'planned', gated: true });
    const controller = new AbortController();
    h.exec.mockImplementation(async () => {
      controller.abort();
      return { stdout: '', stderr: '', status: 0 };
    });
    await expect(
      h.ports.advanceMission({ ...advanceInput, signal: controller.signal })
    ).rejects.toThrow('expired');
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.exec.mock.calls[0][1][1]).toBe('gate-pass');
  });
});
