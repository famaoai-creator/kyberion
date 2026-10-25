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
    { task_id: 'task-1', phase: 'execution', status: 'pending' },
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
    ports: createContinuousOwnerPorts(deps),
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
