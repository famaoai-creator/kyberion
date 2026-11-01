/** Real store/schema review admission; no mocked pass flags, external effects, or live missions. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import {
  safeRmSync as outerRemove,
  safeReadFile as outerRead,
  safeWriteFile as outerWrite,
} from '../secure-io.js';
import type { VcsDevelopmentPr, VcsDevelopmentCiProof } from './development-proof.js';
import type { VcsCommandRunner } from './git.js';
const originalRoot = process.cwd();
const root = path.join(originalRoot, 'active/shared/tmp', 'development-review-' + randomUUID());
let io: typeof import('../secure-io.js');
let authority: typeof import('../authority.js');
let coordination: typeof import('../workforce/work-coordination.js');
let artifacts: typeof import('../workforce/artifact-review.js');
let reader: typeof import('./development-loop.js');
let resolver: typeof import('../path-resolver.js');
let nextTasks: typeof import('../mission/mission-next-task-reader.js');
let proof: typeof import('./development-proof.js');
const missionId = 'MSN-DEVELOPMENT-REVIEW-FIXTURE';
const workItemId = 'development-item';
const input = { cwd: root, ref: '123', workItemId, reviewTaskId: 'review-task' };
const revision: VcsDevelopmentPr = {
  repository: 'https://github.com/fixture/repo',
  number: 123,
  url: 'https://github.com/fixture/repo/pull/123',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  headBranch: 'agent/kyberion-development',
  baseBranch: 'main',
  state: 'open',
  draft: false,
};
const ci: VcsDevelopmentCiProof = {
  state: 'success',
  policyDigest: 'c'.repeat(64),
  requiredChecks: ['CI'],
  reasons: [],
};
let missionPath: string;
const remote: VcsCommandRunner = (_command, args) => {
  let value: unknown;
  if (args[0] === 'repo') value = { nameWithOwner: 'fixture/repo', url: revision.repository };
  else if (args[0] === 'pr')
    value = {
      number: revision.number,
      url: revision.url,
      state: 'OPEN',
      isDraft: false,
      headRefOid: revision.headSha,
      baseRefOid: revision.baseSha,
      headRefName: revision.headBranch,
      baseRefName: revision.baseBranch,
    };
  else if (args[1] === 'graphql')
    value = { data: { repository: { pullRequest: { mergeQueueEntry: null } } } };
  else if (args[1]?.includes('/protection/'))
    value = { strict: true, checks: [{ context: 'CI', app_id: 1 }] };
  else if (args[1]?.includes('/rules/')) value = [];
  else if (args[1]?.includes('/git/trees/'))
    value = { truncated: false, tree: [{ path: '.github', type: 'tree', sha: 'c'.repeat(40) }] };
  else if (args[1]?.includes('/check-runs'))
    value = {
      total_count: 1,
      check_runs: [
        {
          name: 'CI',
          head_sha: revision.headSha,
          app: { id: 1, slug: 'github-actions' },
          status: 'completed',
          conclusion: 'success',
          check_suite: { id: 2 },
        },
      ],
    };
  else if (args[1]?.includes('/actions/runs'))
    value = {
      total_count: 1,
      workflow_runs: [
        { head_sha: revision.headSha, check_suite_id: 2, path: '.github/workflows/ci.yml' },
      ],
    };
  else if (args[1]?.includes('/contents/')) value = { type: 'file', sha: 'c'.repeat(40) };
  else return { status: 1, stdout: '', stderr: 'Unexpected fixture read' };
  return { status: 0, stdout: JSON.stringify(value), stderr: '' };
};
const run = <T>(body: () => T) => authority.withExecutionContext('mission_controller', body);
beforeAll(async () => {
  seedFirstJobTestRoot(originalRoot, root);
  const manifest = 'libs/actuators/vcs-actuator/manifest.json';
  outerWrite(path.join(root, manifest), outerRead(path.join(originalRoot, manifest)), {
    mkdir: true,
  });
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const name of [
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION',
    'KYBERION_PROJECT_ID',
    'KYBERION_TASK_ID',
    'KYBERION_SUDO',
    'KYBERION_SUDO_SCOPE',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(name, '');
  vi.stubEnv('KYBERION_TIER', 'public');
  vi.resetModules();
  io = await import('../secure-io.js');
  authority = await import('../authority.js');
  coordination = await import('../workforce/work-coordination.js');
  artifacts = await import('../workforce/artifact-review.js');
  reader = await import('./development-loop.js');
  resolver = await import('../path-resolver.js');
  nextTasks = await import('../mission/mission-next-task-reader.js');
  proof = await import('./development-proof.js');
  coordination.setWorkCoordinationNamespace('development-review-' + randomUUID());
}, 60000);
beforeEach(() =>
  run(() => {
    coordination.clearWorkCoordinationStore();
    missionPath = resolver.pathResolver.missionDir(missionId, 'public');
    io.safeMkdir(path.join(missionPath, 'deliverables'), { recursive: true });
    io.safeMkdir(path.join(missionPath, 'evidence/reviews'), { recursive: true });
    io.safeWriteFile(
      path.join(missionPath, 'mission-state.json'),
      JSON.stringify({
        mission_id: missionId,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: {
          branch: 'agent/kyberion-development',
          start_commit: 'b'.repeat(40),
          latest_commit: 'a'.repeat(40),
          checkpoints: [],
        },
        history: [],
      })
    );
    coordination.createWorkItem({
      itemId: workItemId,
      title: 'Prepared development',
      description: 'Bound canonical review fixture',
      status: 'review',
      assigneePeerId: 'implementation-agent',
      context: {
        mission_id: missionId,
        task_id: 'implementation-task',
        work_shape: 'improvement_experiment',
      },
    });
    const actualCi = proof.readVcsDevelopmentCiProof(revision, { cwd: root }, remote);
    expect(actualCi.state).toBe('success');
    Object.assign(ci, actualCi);
    const manifestPath = path.join(missionPath, 'deliverables/revision.json');
    io.safeWriteFile(
      manifestPath,
      JSON.stringify({
        kind: 'vcs-development-revision',
        version: 1,
        repository: revision.repository,
        head_sha: revision.headSha,
        base_sha: revision.baseSha,
        head_branch: revision.headBranch,
        base_branch: revision.baseBranch,
        work_item_id: workItemId,
        ci_policy_sha256: ci.policyDigest,
      })
    );
    const relative = resolver.pathResolver.toRepoRelative(manifestPath);
    const digest = artifacts.hashArtifactForReview(manifestPath);
    const receipt = artifacts.buildArtifactReviewReceipt({
      reviewId: 'review-fixture',
      missionId,
      reviewTaskId: 'review-task',
      reviewTargetTaskId: 'implementation-task',
      artifact: { path: relative, sha256: digest, kind: 'code' },
      reviewerAgentId: 'independent-reviewer',
      reviewerTeamRole: 'reviewer',
      specialistRoles: ['code-reviewer'],
      independentFrom: ['implementation-agent'],
      findings: [],
      acceptanceCriteria: ['Exact revision and CI policy independently reviewed'],
    });
    artifacts.assertValidArtifactReviewReceipt(receipt);
    io.safeWriteFile(
      path.join(missionPath, 'evidence/reviews/receipt.json'),
      JSON.stringify(receipt)
    );
    const tasks = nextTasks.validateMissionNextTaskObjects([
      {
        task_id: 'review-task',
        status: 'completed',
        assigned_to: { role: 'reviewer', agent_id: 'independent-reviewer' },
        review_target: 'implementation-task',
        artifact_review_receipt: 'evidence/reviews/receipt.json',
        artifact_review_profile: {
          artifact_path: relative,
          artifact_sha256: digest,
          artifact_kind: 'code',
          required_reviewer_roles: ['code-reviewer'],
          independence_required: true,
          implementer_agent_ids: ['implementation-agent'],
        },
      },
    ]);
    io.safeWriteFile(path.join(missionPath, 'NEXT_TASKS.json'), JSON.stringify(tasks));
  })
);
afterAll(() => {
  if (coordination)
    run(() => {
      coordination.clearWorkCoordinationStore();
      coordination.clearWorkCoordinationNamespace();
    });
  process.chdir(originalRoot);
  vi.unstubAllEnvs();
  outerRemove(root, { recursive: true, force: true });
});
describe('canonical prepared WorkItem review admission', () => {
  it('admits the real default prepared host using canonical typed transport and stored independent review', () =>
    run(() => {
      const publication = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
      expect(
        reader.runPreparedVcsDevelopment({ ...input, dryRun: true }, publication, remote).status
      ).toBe('ready');
      expect(publication).not.toHaveBeenCalled();
    }));
  it('admits a real mission WorkItem and independently built schema-valid receipt for exact revision and CI policy', () =>
    run(() => {
      expect(reader.verifyPreparedWorkItemReview(input, revision, ci)).toEqual({ ok: true });
    }));
  it.each(['repository', 'headSha', 'baseSha'] as const)(
    'rejects changed %s against the reviewed manifest',
    (key) =>
      run(() => {
        const changed = {
          ...revision,
          [key]: key === 'repository' ? 'https://github.com/foreign/repo' : 'd'.repeat(40),
        };
        expect(reader.verifyPreparedWorkItemReview(input, changed, ci).ok).toBe(false);
      })
  );
  it('rejects changed CI policy and reassigned WorkItem', () =>
    run(() => {
      expect(
        reader.verifyPreparedWorkItemReview(input, revision, {
          ...ci,
          policyDigest: 'e'.repeat(64),
        }).ok
      ).toBe(false);
      coordination.updateWorkItem({ itemId: workItemId, assigneePeerId: 'new-implementer' });
      expect(reader.verifyPreparedWorkItemReview(input, revision, ci).ok).toBe(false);
    }));
  it('rejects foreign mission lineage', () =>
    run(() => {
      coordination.updateWorkItem({
        itemId: workItemId,
        context: {
          ...coordination.getWorkItem(workItemId)!.context,
          mission_id: 'MSN-FOREIGN-REVIEW-FIXTURE',
          task_id: 'implementation-task',
          work_shape: 'improvement_experiment',
        },
      });
      expect(reader.verifyPreparedWorkItemReview(input, revision, ci).ok).toBe(false);
    }));
});
