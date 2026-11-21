/** Real scoped mission/WorkItem/manifest/receipt integration; transport and model execution are synthetic. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import {
  safeRmSync as outerRemove,
  safeReadFile as outerRead,
  safeWriteFile as outerWrite,
} from '../secure-io.js';
import type {
  MissionDevelopmentDeps,
  MissionDevelopmentSpec,
} from './mission-development-continuation.js';
import type { VcsDevelopmentPr, VcsDevelopmentCiProof } from '../vcs/development-proof.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
const original = process.cwd();
const root = path.join(original, 'active/shared/tmp', `mission-development-${randomUUID()}`);
const missionId = 'MSN-DEVELOPMENT-CONTINUATION-FIXTURE';
let core: typeof import('./mission-development-continuation.js');
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let coordination: typeof import('../workforce/work-coordination.js');
let resolver: typeof import('../path-resolver.js');
let artifacts: typeof import('../workforce/artifact-review.js');
let approval: typeof import('../governance/external-operation.js');
let reader: typeof import('../vcs/development-loop.js');
let prompt: typeof import('./mission-workitem-dispatch-execution.js');
let proofGate: typeof import('./mission-development-proof.js');
let workflows: typeof import('./mission-workflow-catalog.js');
let dir: string;
const spec: MissionDevelopmentSpec = {
  cwd: '.',
  repository_url: 'https://github.com/fixture/repo',
  source_edit_paths: ['libs/core/example.ts'],
  implementation_task_id: 'implementation-task',
  review_task_id: 'review-task',
  title: 'Implement fixture',
  body_file: 'evidence/pr-body.md',
  max_repairs: 2,
};
const revision: VcsDevelopmentPr = {
  repository: spec.repository_url,
  number: 12,
  url: `${spec.repository_url}/pull/12`,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  headBranch: 'agent/kyberion-development',
  baseBranch: 'main',
  state: 'open',
  draft: false,
};
let ci: VcsDevelopmentCiProof;
let prExists: boolean;
let model: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let deps: MissionDevelopmentDeps;
const run = <T>(body: () => T) => authority.withExecutionContext('mission_controller', body);
const tasks = () =>
  parseSafeJsonInput(
    String(io.safeReadFile(path.join(dir, 'NEXT_TASKS.json'))),
    'fixture task board'
  ) as Array<Record<string, unknown>>;
const tick = () =>
  run(() =>
    core.advanceMissionDevelopment({ missionId, development: spec, assertCurrent: () => {} }, deps)
  );
beforeAll(async () => {
  seedFirstJobTestRoot(original, root);
  const manifest = 'libs/actuators/vcs-actuator/manifest.json';
  outerWrite(path.join(root, manifest), outerRead(path.join(original, manifest)), { mkdir: true });
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const name of [
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_ORGANIZATION',
    'KYBERION_PROJECT_ID',
    'KYBERION_TASK_ID',
    'KYBERION_STANCE',
  ])
    vi.stubEnv(name, '');
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  coordination = await import('../workforce/work-coordination.js');
  resolver = await import('../path-resolver.js');
  artifacts = await import('../workforce/artifact-review.js');
  approval = await import('../governance/external-operation.js');
  reader = await import('../vcs/development-loop.js');
  prompt = await import('./mission-workitem-dispatch-execution.js');
  proofGate = await import('./mission-development-proof.js');
  workflows = await import('./mission-workflow-catalog.js');
  core = await import('./mission-development-continuation.js');
  coordination.setWorkCoordinationNamespace(`development-${randomUUID()}`);
}, 60000);
beforeEach(() =>
  run(() => {
    coordination.clearWorkCoordinationStore();
    dir = resolver.pathResolver.missionDir(missionId, 'public');
    io.safeMkdir(path.join(dir, 'evidence/reviews'), { recursive: true });
    io.safeWriteFile(
      path.join(dir, 'mission-state.json'),
      JSON.stringify({
        mission_id: missionId,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        org_role: 'tester',
        confidence_score: 1,
        relationships: {
          project: { project_id: 'PRJ-DEVELOPMENT-FIXTURE', relationship_type: 'belongs_to' },
        },
        git: {
          branch: revision.headBranch,
          start_commit: revision.baseSha,
          latest_commit: revision.headSha,
          checkpoints: [],
        },
        history: [],
      })
    );
    io.safeWriteFile(path.join(dir, 'evidence/pr-body.md'), 'Synthetic fixture body');
    io.safeWriteFile(
      path.join(dir, 'NEXT_TASKS.json'),
      JSON.stringify([
        {
          task_id: spec.implementation_task_id,
          target_path: 'evidence/implementation.md',
          status: 'completed',
          assigned_to: { role: 'implementer', agent_id: 'implementer' },
        },
        {
          task_id: spec.review_task_id,
          status: 'planned',
          assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
          review_target: spec.implementation_task_id,
        },
        {
          task_id: 'ux-review',
          phase: 'self_review',
          status: 'planned',
          assigned_to: { role: 'reviewer', agent_id: 'ux-reviewer' },
          review_target: 'design',
        },
        { task_id: 'delivery', phase: 'delivery', status: 'planned' },
      ])
    );
    for (const [id, taskId, status, actor] of [
      ['implementation', spec.implementation_task_id, 'done', 'implementer'],
      ['review', spec.review_task_id, 'ready', 'independent-reviewer'],
      ['ux', 'ux-review', 'ready', 'ux-reviewer'],
      ['delivery', 'delivery', 'ready', 'implementer'],
    ] as const)
      coordination.createWorkItem({
        itemId: id,
        title: id,
        description: 'Synthetic scoped development fixture',
        projectId: 'PRJ-DEVELOPMENT-FIXTURE',
        status,
        assigneePeerId: actor,
        context: {
          mission_id: missionId,
          project_id: 'PRJ-DEVELOPMENT-FIXTURE',
          task_id: taskId,
          work_shape: 'improvement_experiment',
        },
        metadata: {
          task_id: taskId,
          mission_id: missionId,
          team_role: actor === 'implementer' ? 'implementer' : 'reviewer',
        },
      });
    prExists = false;
    ci = { state: 'success', policyDigest: 'c'.repeat(64), requiredChecks: ['CI'], reasons: [] };
    model = vi.fn(async () => ({ mission_id: missionId, records: [] }));
    publish = vi.fn((mutation) => {
      if (mutation.operation === 'pr_create') prExists = true;
      return { status: 0, stdout: '', stderr: '' };
    });
    deps = {
      workspace: () => 'ready',
      sourceWorkspace: () => undefined,
      git: (args) => ({
        status: 0,
        stderr: '',
        stdout:
          args[0] === 'branch'
            ? revision.headBranch
            : args[0] === 'rev-parse'
              ? revision.headSha
              : args.includes('diff')
                ? 'diff --git a/libs/core/example.ts b/libs/core/example.ts\n+fixture\n'
                : '',
      }),
      repository: () => ({ url: spec.repository_url, slug: 'fixture/repo', host: 'github.com' }),
      prs: () =>
        prExists ? [{ number: 12, title: spec.title, headRefOid: revision.headSha }] : [],
      pr: () => ({ ...revision }),
      ci: () => ({ ...ci }),
      review: (input, pr, proof, options) =>
        reader.verifyPreparedWorkItemReview(input, pr, proof, {
          ...options,
          run: (_command, args) => ({
            status: 0,
            stderr: '',
            stdout: args.includes('diff')
              ? 'diff --git a/libs/core/example.ts b/libs/core/example.ts\n+fixture\n'
              : '',
          }),
        }),
      publish: publish as NonNullable<MissionDevelopmentDeps['publish']>,
      dispatch: model as NonNullable<MissionDevelopmentDeps['dispatch']>,
      reconcile: () => ({
        status: 'merged',
        nextAction: 'Verified immutable fixture merge',
        knownMergeCommitSha: 'd'.repeat(40),
      }),
    };
  })
);
afterAll(() => {
  if (coordination)
    run(() => {
      coordination.clearWorkCoordinationStore();
      coordination.clearWorkCoordinationNamespace();
    });
  process.chdir(original);
  vi.unstubAllEnvs();
  outerRemove(root, { recursive: true, force: true });
});
async function prepareReview() {
  const first = await tick();
  expect(first.status, first.reason).toBe('running'); // push
  expect((await tick()).status).toBe('running'); // create
  expect((await tick()).reason).toContain('manifest');
}
function approveReview() {
  run(() => {
    const manifest = path.join(
      dir,
      `evidence/development/${spec.implementation_task_id}/revision.json`
    );
    const artifactPath = resolver.pathResolver.toRepoRelative(manifest);
    const sha256 = artifacts.hashArtifactForReview(manifest);
    const receipt = artifacts.buildArtifactReviewReceipt({
      reviewId: 'revision-review',
      missionId,
      reviewTaskId: spec.review_task_id,
      reviewTargetTaskId: spec.implementation_task_id,
      artifact: { path: artifactPath, sha256, kind: 'code' },
      reviewerAgentId: 'independent-reviewer',
      reviewerTeamRole: 'reviewer',
      specialistRoles: ['code-reviewer'],
      independentFrom: ['implementer'],
      findings: [],
      acceptanceCriteria: ['Review exact revision and CI policy'],
    });
    io.safeWriteFile(path.join(dir, 'evidence/reviews/receipt.json'), JSON.stringify(receipt));
    io.safeWriteFile(
      path.join(dir, 'NEXT_TASKS.json'),
      JSON.stringify(
        tasks().map((task) =>
          task.task_id === spec.review_task_id
            ? {
                ...task,
                status: 'completed',
                artifact_review_receipt: 'evidence/reviews/receipt.json',
                artifact_review_profile: {
                  artifact_kind: 'code',
                  artifact_path: artifactPath,
                  artifact_sha256: sha256,
                  required_reviewer_roles: ['code-reviewer'],
                  independence_required: true,
                  implementer_agent_ids: ['implementer'],
                },
              }
            : task.task_id === 'ux-review'
              ? { ...task, status: 'completed' }
              : task
        )
      )
    );
    coordination.updateWorkItem({ itemId: 'review', status: 'done' });
    coordination.updateWorkItem({ itemId: 'ux', status: 'done' });
    const verdict = deps.review!(
      {
        cwd: root,
        ref: '12',
        workItemId: 'implementation',
        reviewTaskId: spec.review_task_id,
        requireSourceDiff: true,
      },
      revision,
      ci,
      { missionGate: false }
    );
    expect(verdict.ok, verdict.reason).toBe(true);
  });
}
describe('continuous owner development stage', () => {
  function preparePrerequisiteWait(awaitingApproval = true) {
    run(() => {
      io.safeWriteFile(
        path.join(dir, 'NEXT_TASKS.json'),
        JSON.stringify([
          { task_id: 'planning', status: 'planned' },
          ...tasks().map((task) =>
            task.task_id === spec.implementation_task_id
              ? {
                  ...task,
                  status: 'planned',
                  dependencies: ['planning'],
                  source_edit_paths: spec.source_edit_paths,
                  source_edit_requires_approval: false,
                }
              : task
          ),
        ])
      );
      coordination.updateWorkItem({ itemId: 'implementation', status: 'ready' });
      coordination.createWorkItem({
        itemId: 'planning',
        title: 'Planning prerequisite',
        description: 'Synthetic prerequisite waiting for an operator',
        projectId: 'PRJ-DEVELOPMENT-FIXTURE',
        status: 'blocked',
        context: {
          mission_id: missionId,
          project_id: 'PRJ-DEVELOPMENT-FIXTURE',
          task_id: 'planning',
        },
        metadata: awaitingApproval
          ? { awaiting_approval: true, approval_request_id: 'planning-approval' }
          : {},
      });
    });
  }
  it.each([true, false])(
    'surfaces prerequisite waits after canonical dispatch (approval=%s)',
    async (approvalWait) => {
      preparePrerequisiteWait(approvalWait);
      const result = await tick();
      expect(result, result.reason).toMatchObject({
        status: approvalWait ? 'pending_approval' : 'blocked',
        ...(approvalWait ? { approval_request_id: 'planning-approval' } : {}),
        evidence_refs: expect.arrayContaining(['workitem:planning']),
      });
      expect(model).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      expect(
        run(() => coordination.getWorkItem('implementation')!.metadata?.mission_development)
      ).toBeUndefined();
    }
  );
  it('uses refreshed prerequisite state after canonical dispatch resolves an approval', async () => {
    preparePrerequisiteWait();
    model.mockImplementation(async () => {
      coordination.updateWorkItem({ itemId: 'planning', status: 'done', metadata: {} });
      return { mission_id: missionId, records: [] };
    });
    const result = await tick();
    expect(result, result.reason).toMatchObject({ status: 'running' });
    expect(model).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
  it('surfaces an approval first encountered during the bounded prerequisite dispatch', async () => {
    preparePrerequisiteWait();
    run(() => coordination.updateWorkItem({ itemId: 'planning', status: 'ready', metadata: {} }));
    model.mockImplementation(async () => {
      coordination.updateWorkItem({
        itemId: 'planning',
        status: 'blocked',
        metadata: { awaiting_approval: true, approval_request_id: 'new-planning-approval' },
      });
      return { mission_id: missionId, records: [] };
    });
    expect(await tick()).toMatchObject({
      status: 'pending_approval',
      approval_request_id: 'new-planning-approval',
      evidence_refs: expect.arrayContaining(['workitem:planning']),
    });
    expect(model).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(['mission_id', 'tenant_slug', 'organization_id', 'project_id', 'task_id'] as const)(
    'does not report a prerequisite wait from another %s',
    async (key) => {
      preparePrerequisiteWait();
      const realItems = coordination.listWorkItems;
      deps.items = (...args) =>
        realItems(...args).map((item) =>
          item.item_id === 'planning'
            ? { ...item, context: { ...item.context, [key]: 'other-scope' } }
            : item
        );
      const result = await tick();
      expect(result, result.reason).toMatchObject({ status: 'running' });
      expect(model).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ itemIds: ['implementation'] })
      );
      expect(publish).not.toHaveBeenCalled();
    }
  );
  it('repairs canonically refuted implementation output before committing or publishing', async () => {
    run(() => {
      coordination.updateWorkItem({
        itemId: 'implementation',
        status: 'review',
        metadata: {
          ...coordination.getWorkItem('implementation')?.metadata,
          last_independent_reviewer_status: 'refuted',
          last_independent_reviewer_excerpt: 'Required error handling is missing',
        },
      });
    });
    expect((await tick()).reason).toContain('Repair queued');
    expect(publish).not.toHaveBeenCalled();
    expect(run(() => coordination.getWorkItem('implementation'))?.status).toBe('ready');
  });
  it('waits for pending implementation acceptance without publishing or consuming repairs', async () => {
    run(() => coordination.updateWorkItem({ itemId: 'implementation', status: 'review' }));
    expect((await tick()).reason).toContain('Waiting for canonical implementation acceptance');
    expect(publish).not.toHaveBeenCalled();
    expect(run(() => coordination.getWorkItem('implementation'))?.status).toBe('review');
  });
  it('publishes then produces a real hash-bound manifest and dispatches only its independent reviewer', async () => {
    await prepareReview();
    expect(publish.mock.calls.map(([mutation]) => mutation.operation)).toEqual([
      'push',
      'pr_create',
    ]);
    expect((await tick()).status).toBe('running');
    expect(model).toHaveBeenCalledWith(
      expect.objectContaining({ mission_id: missionId }),
      expect.objectContaining({ itemIds: ['review'], limit: 1, rounds: 1 })
    );
    approveReview();
    expect((await tick()).status).toBe('completed');
  });
  it('waits for CI without spending repair budget or rerunning model tasks', async () => {
    await prepareReview();
    ci.state = 'pending';
    expect((await tick()).reason).toContain('Waiting');
    expect(model).not.toHaveBeenCalled();
    expect(
      run(() => coordination.getWorkItem('implementation')!.metadata?.mission_development)
    ).toMatchObject({ repairs: 0 });
  });
  it('fetches a missing immutable baseline once from the pinned repository and resumes the source review', async () => {
    await tick();
    await tick();
    const read = deps.git!;
    let fetched = false;
    deps.git = (args, cwd) => {
      if (args[0] === 'fetch') {
        fetched = true;
        expect(args[1]).toBe(spec.repository_url);
        expect(args[2]).toBe(revision.baseSha);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('diff') && !fetched)
        return { status: 1, stdout: '', stderr: 'Object unavailable' };
      return read(args, cwd);
    };
    expect((await tick()).reason).toContain('Fetched');
    expect((await tick()).reason).toContain('manifest');
    expect(fetched).toBe(true);
  });
  it('requeues repair on the original WorkItem and rejects exhaustion', async () => {
    await prepareReview();
    ci.state = 'failure';
    expect((await tick()).reason).toContain('Repair queued');
    expect(run(() => coordination.getWorkItem('implementation')!.status)).toBe('ready');
    expect(tasks().find((task) => task.task_id === spec.implementation_task_id)?.status).toBe(
      'planned'
    );
    expect(
      run(() => coordination.getWorkItem('implementation')!.metadata?.mission_development)
    ).toMatchObject({ repairs: 1 });
    expect(tasks().find((task) => task.task_id === spec.implementation_task_id)?.target_path).toBe(
      'evidence/implementation.md'
    );
    const repairPrompt = run(() =>
      prompt.buildWorkItemPromptBody({
        missionId,
        item: coordination.getWorkItem('implementation')!,
      })
    );
    expect(repairPrompt).toContain('ci_failure');
    expect(repairPrompt).toContain('CI');
    expect(repairPrompt).toContain('do not rewrite owner-generated revision manifests');
  });
  it('does not misclassify a pending global UX review as a failed code review or dispatch delivery', async () => {
    await prepareReview();
    approveReview();
    run(() => {
      io.safeWriteFile(
        path.join(dir, 'NEXT_TASKS.json'),
        JSON.stringify(
          tasks().map((task) =>
            task.task_id === 'ux-review' ? { ...task, status: 'planned' } : task
          )
        )
      );
      coordination.updateWorkItem({ itemId: 'ux', status: 'ready' });
    });
    const reconcile = vi.fn(deps.reconcile!);
    deps.reconcile = reconcile;
    expect((await tick()).reason).toContain('Remaining mission');
    expect(reconcile).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ itemIds: ['ux'] })
    );
    expect(
      run(() => coordination.getWorkItem('implementation')!.metadata?.mission_development)
    ).toMatchObject({ repairs: 0 });
  });
  it('blocks refuted quality output even when its task board row is reviewed', async () => {
    await prepareReview();
    approveReview();
    run(() =>
      io.safeWriteFile(
        path.join(dir, 'NEXT_TASKS.json'),
        JSON.stringify(
          tasks().map((task) =>
            task.task_id === 'ux-review' ? { ...task, status: 'reviewed' } : task
          )
        )
      )
    );
    run(() =>
      coordination.updateWorkItem({
        itemId: 'ux',
        status: 'review',
        metadata: {
          ...coordination.getWorkItem('ux')!.metadata,
          last_independent_reviewer_status: 'refuted',
        },
      })
    );
    const reconcile = vi.fn(deps.reconcile!);
    deps.reconcile = reconcile;
    expect(await tick()).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('ux-review was refuted'),
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
  it('preserves quality approval and active-attempt waits without merging or repairing', async () => {
    await prepareReview();
    approveReview();
    const reconcile = vi.fn(deps.reconcile!);
    deps.reconcile = reconcile;
    run(() =>
      coordination.updateWorkItem({
        itemId: 'ux',
        status: 'blocked',
        metadata: {
          ...coordination.getWorkItem('ux')!.metadata,
          awaiting_approval: true,
          approval_request_id: 'ux-approval',
        },
      })
    );
    expect(await tick()).toMatchObject({
      status: 'pending_approval',
      approval_request_id: 'ux-approval',
    });
    run(() => coordination.updateWorkItem({ itemId: 'ux', status: 'in_progress', metadata: {} }));
    expect(await tick()).toMatchObject({
      status: 'running',
      reason: expect.stringContaining('quality attempt is still active'),
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(
      run(() => coordination.getWorkItem('implementation')!.metadata?.mission_development)
    ).toMatchObject({ repairs: 0 });
  });
  it('records actual trusted CI through the canonical owner evidence path before TESTS_PASSED and review readiness', async () => {
    run(() => {
      const catalog = workflows.loadMissionWorkflowCatalog();
      const phase = catalog.templates
        .find((entry) => entry.id === 'code-change-aidlc')!
        .phases.find((entry) => typeof entry !== 'string' && entry.id === 'test');
      if (!phase || typeof phase === 'string')
        throw new Error('Fixture standard test phase missing');
      const contract = phase.default_tasks!.find((entry) => entry.task_id_suffix === 'test-run')!;
      const stateFile = path.join(dir, 'mission-state.json');
      const state = parseSafeJsonInput(
        String(io.safeReadFile(stateFile)),
        'fixture state'
      ) as Record<string, unknown>;
      io.safeWriteFile(
        stateFile,
        JSON.stringify({
          ...state,
          process_template: {
            workflow_id: 'code-change-aidlc',
            pattern: 'sequential',
            phases: ['execution', 'test', 'self_review', 'delivery'],
          },
        })
      );
      const board = tasks();
      board.push({
        task_id: 'test-test-run',
        origin: 'process_template',
        phase: 'test',
        status: 'planned',
        assigned_to: { role: 'tester', agent_id: 'fixture-tester' },
        dependencies: [spec.implementation_task_id],
        deliverable: contract.deliverable,
        acceptance_criteria: contract.acceptance_criteria,
      });
      io.safeWriteFile(
        path.join(dir, 'NEXT_TASKS.json'),
        JSON.stringify(
          board.map((row) =>
            row.task_id === spec.review_task_id ? { ...row, dependencies: ['test-test-run'] } : row
          )
        )
      );
      coordination.createWorkItem({
        itemId: 'verification',
        title: 'Standard test contract',
        description: 'Required CI verification',
        status: 'ready',
        projectId: 'PRJ-DEVELOPMENT-FIXTURE',
        dependencies: ['implementation'],
        metadata: { task_id: 'test-test-run', team_role: 'tester' },
        context: {
          mission_id: missionId,
          project_id: 'PRJ-DEVELOPMENT-FIXTURE',
          task_id: 'test-test-run',
          work_shape: 'improvement_experiment',
        },
      });
      coordination.updateWorkItem({ itemId: 'review', dependencies: ['verification'] });
      for (const args of [
        ['init', '-q'],
        ['config', 'user.name', 'Fixture'],
        ['config', 'user.email', 'fixture@example.invalid'],
        ['config', 'commit.gpgsign', 'false'],
        ['add', '--', 'mission-state.json', 'NEXT_TASKS.json'],
        ['commit', '-qm', 'fixture mission'],
      ]) {
        const result = io.safeExecResult('git', args, { cwd: dir });
        expect(result.status, result.stderr).toBe(0);
      }
    });
    await tick();
    await tick();
    const verified = await tick();
    expect(verified.status, verified.reason).toBe('running');
    expect(verified.ci_verified, verified.reason).toBe(true);
    const report = run(() => String(io.safeReadFile(path.join(dir, 'evidence/test-report.md'))));
    expect(report).toContain(revision.headSha);
    expect(report).toContain(ci.policyDigest);
    expect(report).toContain('did not run local test commands');
    expect(run(() => coordination.getWorkItem('verification')!.status)).toBe('done');
    expect(tasks().find((row) => row.task_id === 'test-test-run')?.status).toBe('completed');
    const transport = {
      repository: deps.repository,
      sourceWorkspace: deps.sourceWorkspace,
      pr: deps.pr,
      ci: deps.ci,
      head: () => revision.headSha,
    };
    expect(
      await run(() =>
        proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'ci', transport)
      )
    ).toEqual({ ok: true });
    expect(
      (
        await run(() =>
          proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'ci', {
            ...transport,
            head: () => 'e'.repeat(40),
          })
        )
      ).ok
    ).toBe(false);
    ci.state = 'pending';
    expect(
      await run(() =>
        proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'ci', transport)
      )
    ).toMatchObject({ ok: false, waiting: true });
  });
  it('advances the real canonical verification dependency before dispatching the reviewer in a phased code-change graph', async () => {
    await prepareReview();
    run(() => {
      coordination.createWorkItem({
        itemId: 'verification',
        title: 'Verify implementation',
        description: 'Run approved validation',
        status: 'ready',
        projectId: 'PRJ-DEVELOPMENT-FIXTURE',
        dependencies: ['implementation'],
        context: {
          mission_id: missionId,
          project_id: 'PRJ-DEVELOPMENT-FIXTURE',
          task_id: 'test-test-run',
          work_shape: 'improvement_experiment',
        },
      });
      coordination.updateWorkItem({ itemId: 'review', dependencies: ['verification'] });
      const board = tasks();
      board.push({
        task_id: 'test-test-run',
        phase: 'test',
        status: 'planned',
        dependencies: [spec.implementation_task_id],
      });
      io.safeWriteFile(
        path.join(dir, 'NEXT_TASKS.json'),
        JSON.stringify(
          board.map((task) =>
            task.task_id === spec.review_task_id
              ? { ...task, phase: 'self_review', dependencies: ['test-test-run'] }
              : task
          )
        )
      );
    });
    deps.dispatch = async (state, options) => {
      const selected = prompt.selectWorkItems(state, options);
      expect(selected.map((item) => item.item_id)).toEqual(['verification']);
      run(() => {
        coordination.updateWorkItem({ itemId: 'verification', status: 'done' });
        io.safeWriteFile(
          path.join(dir, 'NEXT_TASKS.json'),
          JSON.stringify(
            tasks().map((task) =>
              task.task_id === 'test-test-run' ? { ...task, status: 'completed' } : task
            )
          )
        );
      });
    };
    expect((await tick()).status).toBe('running');
    deps.dispatch = async (state, options) => {
      const selected = prompt.selectWorkItems(state, options);
      expect(selected.map((item) => item.item_id)).toEqual(['review']);
    };
    expect((await tick()).status).toBe('running');
  });
  it('retries an exact approved publication but quarantines unknown effects', async () => {
    publish.mockImplementationOnce(() => {
      throw new approval.ExternalOperationApprovalRequired({
        allowed: false,
        status: 'pending',
        requestId: 'fixture-approval',
        message: 'Approve',
      });
    });
    expect(await tick()).toMatchObject({
      status: 'pending_approval',
      approval_request_id: 'fixture-approval',
    });
    expect((await tick()).reason).toContain('pushed');
    publish.mockImplementationOnce(() => ({ status: 1, stdout: '', stderr: 'uncertain' }));
    expect((await tick()).status).toBe('blocked');
    const count = publish.mock.calls.length;
    expect((await tick()).reason).toContain('uncertain');
    expect(publish).toHaveBeenCalledTimes(count);
  });
  it('offers a read-only phase-gate proof bound to the real WorkItem specification and an immutable merge receipt', async () => {
    await prepareReview();
    approveReview();
    const transport = {
      repository: deps.repository,
      reconcile: deps.reconcile,
      sourceWorkspace: deps.sourceWorkspace,
    };
    // The host verifier, rather than a phase engine callback, owns the whole
    // mission's independent review requirement even if reconciliation is green.
    const fullBoard = run(() => tasks());
    run(() =>
      io.safeWriteFile(
        path.join(dir, 'NEXT_TASKS.json'),
        JSON.stringify(
          fullBoard.map((task) =>
            task.task_id === spec.review_task_id
              ? { ...task, artifact_review_receipt: undefined }
              : task
          )
        )
      )
    );
    expect(
      await run(() =>
        proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'review', transport)
      )
    ).toMatchObject({
      ok: false,
      reason: `Artifact review gate failed for ${spec.review_task_id}: review receipt is missing.`,
    });
    run(() => io.safeWriteFile(path.join(dir, 'NEXT_TASKS.json'), JSON.stringify(fullBoard)));
    expect(
      await run(() =>
        proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'review', transport)
      )
    ).toEqual({ ok: true });
    expect(
      await run(() =>
        proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'publication', transport)
      )
    ).toEqual({ ok: true });
    expect(
      (
        await run(() =>
          proofGate.verifyMissionDevelopmentPublication(
            missionId,
            { ...spec, title: 'Drift' },
            'publication',
            transport
          )
        )
      ).ok
    ).toBe(false);
    expect(
      (
        await run(() =>
          proofGate.verifyMissionDevelopmentPublication(missionId, spec, 'publication', {
            ...transport,
            reconcile: () => ({ status: 'ready', nextAction: 'Not merged' }),
          })
        )
      ).ok
    ).toBe(false);
  });
  it('never completes on a merge label without the immutable merge receipt', async () => {
    await prepareReview();
    approveReview();
    deps.reconcile = () => ({ status: 'merged', nextAction: 'Missing receipt' });
    expect((await tick()).status).toBe('blocked');
  });
  it('rejects repository drift and malformed persisted budget before effects', async () => {
    deps.repository = () => ({
      url: 'https://github.com/foreign/repo',
      slug: 'foreign/repo',
      host: 'github.com',
    });
    expect((await tick()).status).toBe('blocked');
    expect(publish).not.toHaveBeenCalled();
  });
  it('routes mission-scoped factory branches to workspace while blocking invalid branches', async () => {
    const invalid = await run(() =>
      core.advanceMissionDevelopment(
        { missionId, development: { ...spec, branch: 'main' }, assertCurrent: () => {} },
        deps
      )
    );
    expect(invalid.status).toBe('blocked');
    expect(invalid.reason).toContain('Invalid development branch');
    const seen: unknown[] = [];
    const baseWorkspace = deps.workspace;
    deps.workspace = vi.fn((arg) => {
      seen.push(arg);
      return baseWorkspace ? baseWorkspace(arg) : 'unchanged';
    });
    await run(() =>
      core.advanceMissionDevelopment(
        {
          missionId,
          development: { ...spec, branch: 'agent/factory-docs-01' },
          assertCurrent: () => {},
        },
        deps
      )
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual(expect.objectContaining({ branch: 'agent/factory-docs-01' }));
  });
  it('enforces attached factory delivery envelopes before dispatching workspace mutations', async () => {
    const { createFactoryDeliveryEnvelope } =
      await import('../governance/factory-delivery-envelope.js');
    const validEnvelope = createFactoryDeliveryEnvelope({
      mission_id: missionId,
      tenant_slug: 'acme',
      authority_kind: 'alignment_brief',
      alignment_approval_ref: 'apr-factory-1',
      development_branch: 'agent/factory-docs-01',
      scope_in: spec.source_edit_paths,
      allowed_paths: spec.source_edit_paths,
      merge_mode: 'veto_window',
    });

    const spyWorkspace = vi.fn(deps.workspace ?? (() => 'unchanged' as const));
    deps.workspace = spyWorkspace;

    await run(() =>
      core.advanceMissionDevelopment(
        {
          missionId,
          development: {
            ...spec,
            branch: 'agent/factory-docs-01',
            factory_envelope: validEnvelope,
          },
          assertCurrent: () => {},
        },
        deps
      )
    );
    expect(spyWorkspace).toHaveBeenCalled();

    spyWorkspace.mockClear();
    const branchMismatch = await run(() =>
      core.advanceMissionDevelopment(
        {
          missionId,
          development: {
            ...spec,
            branch: 'agent/factory-docs-02',
            factory_envelope: validEnvelope,
          },
          assertCurrent: () => {},
        },
        deps
      )
    );
    expect(branchMismatch.status).toBe('blocked');
    expect(branchMismatch.reason).toContain('Factory delivery envelope');
    expect(spyWorkspace).not.toHaveBeenCalled();

    const tampered = await run(() =>
      core.advanceMissionDevelopment(
        {
          missionId,
          development: {
            ...spec,
            branch: 'agent/factory-docs-01',
            factory_envelope: { ...validEnvelope, allowed_paths: ['docs/**'] },
          },
          assertCurrent: () => {},
        },
        deps
      )
    );
    expect(tampered.status).toBe('blocked');
    expect(tampered.reason).toContain('Factory delivery envelope');
    expect(spyWorkspace).not.toHaveBeenCalled();
  });
  it('plans bounded CI autofix, persists failure signatures, halts duplicates/shadow/non-auto/semantic-sync', async () => {
    const { createFactoryDeliveryEnvelope } =
      await import('../governance/factory-delivery-envelope.js');
    const { computeFactoryCiSignature } = await import('../governance/factory-ci-autofix.js');
    const tenant = 'acme';
    const tenantMissionId = 'MSN-FACTORY-CI-FIXTURE';
    const branchName = 'agent/factory-ci-1';
    const tenantDir = resolver.pathResolver.missionDir(tenantMissionId, 'confidential', tenant);
    const envelope = createFactoryDeliveryEnvelope({
      mission_id: tenantMissionId,
      tenant_slug: tenant,
      authority_kind: 'alignment_brief',
      alignment_approval_ref: 'apr-ci-1',
      development_branch: branchName,
      scope_in: spec.source_edit_paths,
      allowed_paths: spec.source_edit_paths,
      max_ci_repair_attempts: 3,
      merge_mode: 'veto_window',
    });
    const tenantSpec: MissionDevelopmentSpec = {
      ...spec,
      branch: branchName,
      max_repairs: 3,
      factory_envelope: envelope,
    };
    const graduatedPolicy = {
      version: '1.0.0',
      tenants: {
        [tenant]: {
          enabled: true,
          graduated_actions: ['ci_autofix_attempt' as const, 'main_sync_clean' as const],
        },
      },
    };
    const resetTenantFixture = () => {
      vi.stubEnv('KYBERION_TIER', 'confidential');
      vi.stubEnv('KYBERION_TENANT', tenant);
      prExists = false;
      ci = {
        state: 'failure',
        policyDigest: 'c'.repeat(64),
        requiredChecks: ['op-registry'],
        reasons: ['op-registry drift detected'],
      };
      run(() => {
        coordination.clearWorkCoordinationStore();
        io.safeMkdir(path.join(tenantDir, 'evidence/development'), { recursive: true });
        io.safeWriteFile(path.join(tenantDir, 'evidence/pr-body.md'), 'Tenant PR body');
        io.safeWriteFile(
          path.join(tenantDir, 'mission-state.json'),
          JSON.stringify({
            mission_id: tenantMissionId,
            tier: 'confidential',
            tenant_slug: tenant,
            status: 'active',
            execution_mode: 'local',
            priority: 1,
            org_role: 'tester',
            confidence_score: 1,
            relationships: {
              project: { project_id: 'PRJ-DEVELOPMENT-FIXTURE', relationship_type: 'belongs_to' },
            },
            git: {
              branch: branchName,
              start_commit: revision.baseSha,
              latest_commit: revision.headSha,
              checkpoints: [],
            },
            history: [],
          })
        );
        io.safeWriteFile(
          path.join(tenantDir, 'NEXT_TASKS.json'),
          JSON.stringify([
            {
              task_id: spec.implementation_task_id,
              target_path: 'evidence/implementation.md',
              source_edit_paths: spec.source_edit_paths,
              source_edit_requires_approval: false,
              status: 'completed',
              assigned_to: { role: 'implementer', agent_id: 'implementer' },
            },
            {
              task_id: spec.review_task_id,
              status: 'planned',
              assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
              review_target: spec.implementation_task_id,
            },
            { task_id: 'delivery', phase: 'delivery', status: 'planned' },
          ])
        );
        for (const [id, taskId, status, actor] of [
          ['implementation', spec.implementation_task_id, 'done', 'implementer'],
          ['review', spec.review_task_id, 'ready', 'independent-reviewer'],
          ['delivery', 'delivery', 'ready', 'implementer'],
        ] as const) {
          coordination.createWorkItem({
            itemId: id,
            title: id,
            description: 'Tenant factory CI fixture',
            projectId: 'PRJ-DEVELOPMENT-FIXTURE',
            status,
            assigneePeerId: actor,
            context: {
              mission_id: tenantMissionId,
              tenant_slug: tenant,
              project_id: 'PRJ-DEVELOPMENT-FIXTURE',
              task_id: taskId,
              work_shape: 'improvement_experiment',
            },
            metadata: {
              task_id: taskId,
              mission_id: tenantMissionId,
              team_role: actor === 'implementer' ? 'implementer' : 'reviewer',
            },
          });
        }
      });
    };

    try {
      resetTenantFixture();
      const recordedRepairs: unknown[] = [];
      const baseGit = deps.git!;
      const localDeps: MissionDevelopmentDeps = {
        ...deps,
        pr: () => ({ ...revision, headBranch: branchName }),
        git: (args, cwd) => {
          if (args[0] === 'branch') return { status: 0, stdout: branchName, stderr: '' };
          return baseGit(args, cwd);
        },
        artifact: (filePath, payload, meta) => {
          recordedRepairs.push(payload);
          io.safeMkdir(path.dirname(filePath), { recursive: true });
          io.safeWriteFile(filePath, JSON.stringify(payload, null, 2));
          void meta;
        },
        factoryPolicy: graduatedPolicy,
      };
      const tickFactory = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: tenantSpec, assertCurrent: () => {} },
            localDeps
          )
        );

      // Push -> pr_create -> first CI failure triggers bounded autofix plan
      const firstTick = await tickFactory();
      expect(firstTick.status, firstTick.reason).toBe('running');
      const secondTick = await tickFactory();
      expect(secondTick.status, secondTick.reason).toBe('running');
      const repaired = await tickFactory();
      expect(repaired.status).toBe('running');
      expect(repaired.reason).toContain('Repair queued');
      expect(recordedRepairs[0]).toMatchObject({
        observations: {
          factory_ci_autofix: {
            action: 'run_resolve_generated',
            primary_class: 'generated-drift',
          },
        },
      });
      const afterFirst = run(
        () => coordination.getWorkItem('implementation')!.metadata?.mission_development
      ) as { repairs: number; ci_failure_signatures?: string[] };
      expect(afterFirst.repairs).toBe(1);
      expect(afterFirst.ci_failure_signatures?.length).toBe(1);

      // Simulate repair completion without changing failure signature -> immediate duplicate stop
      run(() => {
        coordination.updateWorkItem({
          itemId: 'implementation',
          expectedVersion: coordination.getWorkItem('implementation')!.version,
          status: 'done',
        });
        io.safeWriteFile(
          path.join(tenantDir, 'NEXT_TASKS.json'),
          JSON.stringify(
            (
              parseSafeJsonInput(
                String(io.safeReadFile(path.join(tenantDir, 'NEXT_TASKS.json'))),
                'tenant next tasks'
              ) as Array<Record<string, unknown>>
            ).map((row) =>
              row.task_id === spec.implementation_task_id ? { ...row, status: 'completed' } : row
            )
          )
        );
      });
      const duplicateStop = await tickFactory();
      expect(duplicateStop.status).toBe('blocked');
      expect(duplicateStop.reason).toContain('Repeated CI failure signature');
      const afterDuplicate = run(
        () => coordination.getWorkItem('implementation')!.metadata?.mission_development
      ) as { repairs: number };
      expect(afterDuplicate.repairs).toBe(1);

      // Shadow mode (without graduated policy) blocks without consuming repair budget
      resetTenantFixture();
      const shadowDeps: MissionDevelopmentDeps = {
        ...localDeps,
        factoryPolicy: { version: '1.0.0', tenants: {} },
      };
      const tickShadow = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: tenantSpec, assertCurrent: () => {} },
            shadowDeps
          )
        );
      await tickShadow();
      await tickShadow();
      const shadowStop = await tickShadow();
      expect(shadowStop.status).toBe('blocked');
      expect(shadowStop.reason).toContain('shadow_mode');

      // Ratchet non-auto failure class escalates immediately
      resetTenantFixture();
      const ratchetDeps: MissionDevelopmentDeps = {
        ...localDeps,
        ciTriage: () => [
          {
            class: 'ratchet/registration',
            signature: computeFactoryCiSignature(['ratchet/registration', 'orphans']),
            title: 'orphans ratchet failed',
            gate: 'orphans',
            next: ['pnpm check -- --only orphans'],
          },
        ],
      };
      const tickRatchet = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: tenantSpec, assertCurrent: () => {} },
            ratchetDeps
          )
        );
      await tickRatchet();
      await tickRatchet();
      const ratchetStop = await tickRatchet();
      expect(ratchetStop.status).toBe('blocked');
      expect(ratchetStop.reason).toContain('ratchet/registration');

      // Semantic main-sync conflict escalates before queuing CI repairs
      resetTenantFixture();
      const semanticSyncDeps: MissionDevelopmentDeps = {
        ...localDeps,
        syncBaseSha: () => 'e'.repeat(40),
        git: (args, cwd) => {
          if (args[0] === 'branch') return { status: 0, stdout: branchName, stderr: '' };
          if (args.includes('merge-tree')) {
            return {
              status: 1,
              stdout: `${'f'.repeat(40)}\nlibs/core/example.ts\n`,
              stderr: '',
            };
          }
          return baseGit(args, cwd);
        },
      };
      const tickSync = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: tenantSpec, assertCurrent: () => {} },
            semanticSyncDeps
          )
        );
      await tickSync();
      await tickSync();
      const syncBlocked = await tickSync();
      expect(syncBlocked.status).toBe('blocked');
      expect(syncBlocked.reason).toContain('Semantic or protected conflicts');
    } finally {
      vi.stubEnv('KYBERION_TIER', 'public');
      vi.stubEnv('KYBERION_TENANT', '');
      run(() => io.safeRmSync(tenantDir, { recursive: true, force: true }));
    }
  });
  it('enforces Track 3 merge tiers, veto windows, post-merge revert planning, and convergence plans', async () => {
    const { createFactoryDeliveryEnvelope } =
      await import('../governance/factory-delivery-envelope.js');
    const tenant = 'acme';
    const tenantMissionId = 'MSN-FACTORY-MERGE-FIXTURE';
    const branchName = 'agent/factory-merge-1';
    const tenantDir = resolver.pathResolver.missionDir(tenantMissionId, 'confidential', tenant);
    const graduatedPolicy = {
      version: '1.0.0',
      tenants: {
        [tenant]: {
          enabled: true,
          graduated_actions: [
            'pr_merge_low' as const,
            'pr_merge_medium' as const,
            'auto_revert_on_main_failure' as const,
          ],
        },
      },
    };

    const approveTenantReview = (reviewSpec: MissionDevelopmentSpec) =>
      run(() => {
        const manifest = path.join(
          tenantDir,
          `evidence/development/${reviewSpec.implementation_task_id}/revision.json`
        );
        const artifactPath = resolver.pathResolver.toRepoRelative(manifest);
        const sha256 = artifacts.hashArtifactForReview(manifest);
        const receipt = artifacts.buildArtifactReviewReceipt({
          reviewId: 'factory-revision-review',
          missionId: tenantMissionId,
          reviewTaskId: reviewSpec.review_task_id,
          reviewTargetTaskId: reviewSpec.implementation_task_id,
          artifact: { path: artifactPath, sha256, kind: 'code' },
          reviewerAgentId: 'independent-reviewer',
          reviewerTeamRole: 'reviewer',
          specialistRoles: ['code-reviewer'],
          independentFrom: ['implementer'],
          findings: [],
          acceptanceCriteria: ['Review exact revision and CI policy'],
        });
        io.safeMkdir(path.join(tenantDir, 'evidence/reviews'), { recursive: true });
        io.safeWriteFile(
          path.join(tenantDir, 'evidence/reviews/receipt.json'),
          JSON.stringify(receipt)
        );
        const currentTasks = parseSafeJsonInput(
          String(io.safeReadFile(path.join(tenantDir, 'NEXT_TASKS.json'))),
          'tenant next tasks'
        ) as Array<Record<string, unknown>>;
        io.safeWriteFile(
          path.join(tenantDir, 'NEXT_TASKS.json'),
          JSON.stringify(
            currentTasks.map((task) =>
              task.task_id === reviewSpec.review_task_id
                ? {
                    ...task,
                    status: 'completed',
                    artifact_review_receipt: 'evidence/reviews/receipt.json',
                    artifact_review_profile: {
                      artifact_kind: 'code',
                      artifact_path: artifactPath,
                      artifact_sha256: sha256,
                      required_reviewer_roles: ['code-reviewer'],
                      independence_required: true,
                      implementer_agent_ids: ['implementer'],
                    },
                  }
                : task
            )
          )
        );
        coordination.updateWorkItem({ itemId: 'review', status: 'done' });
      });

    const seedTenantMission = (
      targetSpec: MissionDevelopmentSpec,
      missionStatus: string = 'active'
    ) => {
      vi.stubEnv('KYBERION_TIER', 'confidential');
      vi.stubEnv('KYBERION_TENANT', tenant);
      prExists = false;
      ci = {
        state: 'success',
        policyDigest: 'c'.repeat(64),
        requiredChecks: ['CI'],
        reasons: [],
      };
      run(() => {
        coordination.clearWorkCoordinationStore();
        io.safeRmSync(tenantDir, { recursive: true, force: true });
        io.safeMkdir(path.join(tenantDir, 'evidence/development'), { recursive: true });
        io.safeWriteFile(path.join(tenantDir, 'evidence/pr-body.md'), 'Tenant Track 3 PR body');
        io.safeWriteFile(
          path.join(tenantDir, 'mission-state.json'),
          JSON.stringify({
            mission_id: tenantMissionId,
            tier: 'confidential',
            tenant_slug: tenant,
            status: missionStatus,
            execution_mode: 'local',
            priority: 1,
            org_role: 'tester',
            confidence_score: 1,
            relationships: {
              project: { project_id: 'PRJ-DEVELOPMENT-FIXTURE', relationship_type: 'belongs_to' },
            },
            git: {
              branch: branchName,
              start_commit: revision.baseSha,
              latest_commit: revision.headSha,
              checkpoints: [],
            },
            history: [],
          })
        );
        io.safeWriteFile(
          path.join(tenantDir, 'NEXT_TASKS.json'),
          JSON.stringify([
            {
              task_id: targetSpec.implementation_task_id,
              target_path: 'evidence/implementation.md',
              source_edit_paths: targetSpec.source_edit_paths,
              source_edit_requires_approval: false,
              status: 'completed',
              assigned_to: { role: 'implementer', agent_id: 'implementer' },
            },
            {
              task_id: targetSpec.review_task_id,
              status: 'planned',
              assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
              review_target: targetSpec.implementation_task_id,
            },
            { task_id: 'delivery', phase: 'delivery', status: 'planned' },
          ])
        );
        for (const [id, taskId, status, actor] of [
          ['implementation', targetSpec.implementation_task_id, 'done', 'implementer'],
          ['review', targetSpec.review_task_id, 'ready', 'independent-reviewer'],
          ['delivery', 'delivery', 'ready', 'implementer'],
        ] as const) {
          coordination.createWorkItem({
            itemId: id,
            title: id,
            description: 'Tenant factory merge fixture',
            projectId: 'PRJ-DEVELOPMENT-FIXTURE',
            status,
            assigneePeerId: actor,
            context: {
              mission_id: tenantMissionId,
              tenant_slug: tenant,
              project_id: 'PRJ-DEVELOPMENT-FIXTURE',
              task_id: taskId,
              work_shape: 'improvement_experiment',
            },
            metadata: {
              task_id: taskId,
              mission_id: tenantMissionId,
              team_role: actor === 'implementer' ? 'implementer' : 'reviewer',
            },
          });
        }
      });
    };

    try {
      const baseGit = deps.git!;

      // 1. Low-risk envelope + graduated pr_merge_low -> auto_merge + protected active convergence plan
      const lowSpec: MissionDevelopmentSpec = {
        ...spec,
        source_edit_paths: ['docs/guide.md'],
        branch: branchName,
        factory_envelope: createFactoryDeliveryEnvelope({
          mission_id: tenantMissionId,
          tenant_slug: tenant,
          authority_kind: 'alignment_brief',
          alignment_approval_ref: 'apr-low-1',
          development_branch: branchName,
          scope_in: ['docs/**'],
          allowed_paths: ['docs/**'],
          merge_mode: 'auto_low_risk',
        }),
      };
      seedTenantMission(lowSpec, 'active');
      const lowReconcile = vi.fn(() => ({
        status: 'merged' as const,
        nextAction: 'Merged low-risk PR',
        knownMergeCommitSha: 'e'.repeat(40),
      }));
      const lowDeps: MissionDevelopmentDeps = {
        ...deps,
        pr: () => ({ ...revision, headBranch: branchName }),
        git: (args, cwd) => {
          if (args[0] === 'branch') return { status: 0, stdout: branchName, stderr: '' };
          if (args.includes('diff'))
            return {
              status: 0,
              stdout: 'diff --git a/docs/guide.md b/docs/guide.md\n+doc\n',
              stderr: '',
            };
          return baseGit(args, cwd);
        },
        review: (inputArg, prArg, proofArg, options) =>
          reader.verifyPreparedWorkItemReview(inputArg, prArg, proofArg, {
            ...options,
            run: (_command, args) => ({
              status: 0,
              stderr: '',
              stdout: args.includes('diff')
                ? 'diff --git a/docs/guide.md b/docs/guide.md\n+doc\n'
                : '',
            }),
          }),
        reconcile: lowReconcile,
        factoryPolicy: graduatedPolicy,
        operationsHalted: false,
      };
      const tickLow = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: lowSpec, assertCurrent: () => {} },
            lowDeps
          )
        );
      await tickLow(); // push
      await tickLow(); // pr_create
      await tickLow(); // prepare review manifest
      approveTenantReview(lowSpec);
      const lowCompleted = await tickLow();
      expect(lowReconcile).toHaveBeenCalledOnce();
      expect(lowCompleted.status).toBe('completed');
      expect(lowCompleted.factory_merge_decision).toMatchObject({
        action: 'auto_merge',
        tier: 'low',
        action_id: 'pr_merge_low',
      });
      expect(lowCompleted.factory_convergence_plan).toMatchObject({
        mission_id: tenantMissionId,
        ready_for_cleanup: false,
        mission_terminal: false,
      });

      // 2. Medium-risk envelope -> Turn 1 opens/persists veto window without reconcile; Turn 2 elapsed auto-merges
      const mediumSpec: MissionDevelopmentSpec = {
        ...spec,
        source_edit_paths: ['libs/core/example.ts'],
        branch: branchName,
        factory_envelope: createFactoryDeliveryEnvelope({
          mission_id: tenantMissionId,
          tenant_slug: tenant,
          authority_kind: 'alignment_brief',
          alignment_approval_ref: 'apr-med-1',
          development_branch: branchName,
          scope_in: ['libs/core/example.ts'],
          allowed_paths: ['libs/core/example.ts'],
          merge_mode: 'auto_low_risk',
        }),
      };
      seedTenantMission(mediumSpec, 'active');
      const medReconcile = vi.fn(() => ({
        status: 'merged' as const,
        nextAction: 'Merged medium-risk PR after veto elapsed',
        knownMergeCommitSha: 'f'.repeat(40),
      }));
      let currentNow = new Date('2026-11-22T01:00:00.000Z');
      let deliverVeto = false;
      const medDeps: MissionDevelopmentDeps = {
        ...deps,
        pr: () => ({ ...revision, headBranch: branchName }),
        git: (args, cwd) => {
          if (args[0] === 'branch') return { status: 0, stdout: branchName, stderr: '' };
          return baseGit(args, cwd);
        },
        reconcile: medReconcile,
        factoryPolicy: graduatedPolicy,
        operationsHalted: false,
        now: () => currentNow,
        vetoState: (_pr, currentWindow) => {
          if (deliverVeto && currentWindow) {
            return {
              window: {
                ...currentWindow,
                deliveredAt: '2026-11-22T01:05:00.000Z',
                proceedsAt: '2026-11-22T03:05:00.000Z',
              },
            };
          }
          return { window: currentWindow };
        },
      };
      const tickMed = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: mediumSpec, assertCurrent: () => {} },
            medDeps
          )
        );
      await tickMed(); // push
      await tickMed(); // pr_create
      await tickMed(); // prepare review manifest
      approveTenantReview(mediumSpec);

      const vetoOpened = await tickMed();
      expect(medReconcile).not.toHaveBeenCalled();
      expect(vetoOpened.status).toBe('running');
      expect(vetoOpened.factory_merge_decision).toMatchObject({
        action: 'open_veto_window',
        tier: 'medium',
        action_id: 'pr_merge_medium',
        veto_state: 'awaiting_delivery',
      });
      const persisted = run(
        () => coordination.getWorkItem('implementation')!.metadata?.mission_development
      ) as { factory_veto_head_sha?: string; factory_veto_window?: { windowMinutes: number } };
      expect(persisted.factory_veto_head_sha).toBe(revision.headSha);
      expect(persisted.factory_veto_window?.windowMinutes).toBe(120);

      deliverVeto = true;
      currentNow = new Date('2026-11-22T04:00:00.000Z');
      const medCompleted = await tickMed();
      expect(medReconcile).toHaveBeenCalledOnce();
      expect(medCompleted.status).toBe('completed');
      expect(medCompleted.factory_merge_decision).toMatchObject({
        action: 'auto_merge',
        action_id: 'pr_merge_medium',
        veto_state: 'elapsed',
      });

      // 3. Post-merge failure with rerun reproduction -> returns blocked with open_revert_pr plan
      seedTenantMission(lowSpec, 'active');
      const failReconcile = vi.fn(() => ({
        status: 'post_merge_failed' as const,
        nextAction: 'Main CI failed after merge',
        knownMergeCommitSha: 'e'.repeat(40),
      }));
      const revertDeps: MissionDevelopmentDeps = {
        ...lowDeps,
        reconcile: failReconcile,
        postMergeRevertContext: () => ({
          failureReproducedOnRerun: true,
          revertAttemptsUsed: 0,
          applyDemotion: false,
        }),
      };
      const tickRevert = () =>
        run(() =>
          core.advanceMissionDevelopment(
            { missionId: tenantMissionId, development: lowSpec, assertCurrent: () => {} },
            revertDeps
          )
        );
      await tickRevert();
      await tickRevert();
      await tickRevert();
      approveTenantReview(lowSpec);
      const revertBlocked = await tickRevert();
      expect(revertBlocked.status).toBe('blocked');
      expect(revertBlocked.factory_revert_plan).toMatchObject({
        action: 'open_revert_pr',
        allowed: true,
        revert_branch: `agent/factory-revert-${'e'.repeat(10)}`,
      });
    } finally {
      vi.stubEnv('KYBERION_TIER', 'public');
      vi.stubEnv('KYBERION_TENANT', '');
      run(() => io.safeRmSync(tenantDir, { recursive: true, force: true }));
    }
  });
});
