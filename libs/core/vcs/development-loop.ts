/** Prepared WorkItem promotion. Implementation and repairs stay with the existing
 * mission executor; this host never interprets caller pass flags as authority. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { missionPathOrNull } from '../mission-lookup.js';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { readTextFile } from '../foundation/text.js';
import { assertSafeRepositoryPath, safeExecResult } from '../secure-io.js';
import { findMissionPath, pathResolver } from '../path-resolver.js';
import { getWorkItem } from '../workforce/work-coordination.js';
import { loadArtifactReviewReceipt } from '../workforce/artifact-review.js';
import { loadMissionNextTaskObjectsAtPath } from '../mission/mission-next-task-reader.js';
import { validateMissionArtifactReviewGate } from '../mission/mission-governance.js';
import {
  readVcsDevelopmentPr,
  readVcsDevelopmentCiProof,
  readVcsDevelopmentMergedCiProof,
  type VcsDevelopmentPr,
  type VcsDevelopmentCiProof,
} from './development-proof.js';
import type { VcsCommandRunner, VcsCommandResult } from './git.js';
import type { VcsHostMutation } from './publication-host.js';

export interface PreparedDevelopmentInput {
  cwd: string;
  ref: string;
  workItemId: string;
  reviewTaskId: string;
  dryRun?: boolean;
}
export interface DevelopmentLoopPorts {
  snapshot(): VcsDevelopmentPr;
  ci(pr: VcsDevelopmentPr): VcsDevelopmentCiProof;
  review(
    pr: VcsDevelopmentPr,
    ci: VcsDevelopmentCiProof
  ): { ok: boolean; reason?: string; reviewedBaseSha?: string };
  promote(pr: VcsDevelopmentPr): VcsCommandResult;
  verifyMerged?(pr: VcsDevelopmentPr): VcsDevelopmentCiProof;
}
export interface DevelopmentLoopResult {
  status:
    | 'ready'
    | 'waiting'
    | 'repair_required'
    | 'review_required'
    | 'blocked'
    | 'queued'
    | 'merged'
    | 'post_merge_waiting'
    | 'post_merge_failed'
    | 'post_merge_unverified';
  nextAction: string;
  revision?: VcsDevelopmentPr;
  policyDigest?: string;
  knownMergeCommitSha?: string;
}
const same = (a: VcsDevelopmentPr, b: VcsDevelopmentPr) =>
  ['repository', 'number', 'headSha', 'baseSha', 'headBranch', 'baseBranch'].every(
    (k) => a[k as keyof typeof a] === b[k as keyof typeof b]
  );

/** One bounded reconciliation step; pending CI/merge queues consume no repairs.
 * Re-entry rereads remote and receipt facts rather than reusing prior success. */
export function reconcileVcsDevelopment(
  ports: DevelopmentLoopPorts,
  dryRun = true
): DevelopmentLoopResult {
  const pr = ports.snapshot();
  const result = (
    status: DevelopmentLoopResult['status'],
    nextAction: string,
    policyDigest?: string
  ): DevelopmentLoopResult => ({
    status,
    nextAction,
    revision: pr,
    ...(policyDigest ? { policyDigest } : {}),
  });
  if (pr.headBranch !== 'agent/kyberion-development' || pr.baseBranch !== 'main')
    return {
      ...result('blocked', 'Unexpected development branch lineage'),
      ...(pr.mergeCommitSha ? { knownMergeCommitSha: pr.mergeCommitSha } : {}),
    };
  if (pr.state === 'merged') {
    const ci = ports.ci(pr),
      review = ports.review(pr, ci);
    if (!review.ok)
      return {
        ...result(
          'review_required',
          review.reason || 'Verify original WorkItem and independent review lineage'
        ),
        ...(pr.mergeCommitSha ? { knownMergeCommitSha: pr.mergeCommitSha } : {}),
      };
    return verifyMerged(ports, pr, review.reviewedBaseSha, ci.policyDigest);
  }
  if (pr.queued)
    return result(
      'queued',
      'PR is already queued; reconcile remote merge state without re-enqueueing'
    );
  if (
    pr.state !== 'open' ||
    pr.draft ||
    pr.headBranch !== 'agent/kyberion-development' ||
    pr.baseBranch !== 'main'
  )
    return result(
      'blocked',
      'Prepare an open non-draft PR from agent/kyberion-development to main'
    );
  const ci = ports.ci(pr);
  if (ci.state === 'pending')
    return result('waiting', 'Reconcile after required CI finishes', ci.policyDigest);
  if (ci.state === 'failure')
    return result(
      'repair_required',
      'Dispatch repair through the existing claimed mission WorkItem executor',
      ci.policyDigest
    );
  if (ci.state !== 'success') return result('blocked', ci.reasons.join('; '));
  const review = ports.review(pr, ci);
  if (!review.ok)
    return result(
      'review_required',
      review.reason || 'Record independent review of the current revision and CI policy',
      ci.policyDigest
    );
  if (dryRun)
    return result('ready', 'Advance with the installed publication charter', ci.policyDigest);
  const latest = ports.snapshot();
  if (!same(pr, latest) || latest.state !== 'open' || latest.draft)
    return result('review_required', 'Revision changed; rerun CI and independent review');
  const fresh = ports.ci(latest);
  if (fresh.state !== 'success' || fresh.policyDigest !== ci.policyDigest)
    return result('blocked', 'CI policy or check evidence changed; reconcile again');
  const liveReview = ports.review(latest, fresh);
  if (!liveReview.ok)
    return result(
      'review_required',
      liveReview.reason || 'Independent review changed before publication'
    );
  if (latest.queued) return result('queued', 'PR already queued; do not repeat promotion');
  const effect = ports.promote(latest);
  if (effect.error || effect.status !== 0)
    return result(
      'blocked',
      'Promotion did not succeed; inspect the governed external-operation receipt before retrying'
    );
  const after = ports.snapshot();
  if (
    pr.repository !== after.repository ||
    pr.number !== after.number ||
    pr.headSha !== after.headSha ||
    pr.headBranch !== after.headBranch ||
    pr.baseBranch !== after.baseBranch
  )
    return result('blocked', 'Remote revision changed during promotion; verify the remote result');
  if (after.state === 'merged')
    return verifyMerged(ports, after, liveReview.reviewedBaseSha, fresh.policyDigest);
  return result(
    'queued',
    'Reconcile remote merge state; acceptance is not proof of merge',
    ci.policyDigest
  );
}

export function runPreparedVcsDevelopment(
  input: PreparedDevelopmentInput,
  publicationHost: (mutation: VcsHostMutation) => VcsCommandResult,
  run: VcsCommandRunner = safeExecResult
): DevelopmentLoopResult {
  const options = { cwd: input.cwd };
  return reconcileVcsDevelopment(
    {
      snapshot: () => readVcsDevelopmentPr(input.ref, options, run),
      ci: (pr) => readVcsDevelopmentCiProof(pr, options, run),
      verifyMerged: (pr) => readVcsDevelopmentMergedCiProof(pr, options, run),
      review: (pr, ci) => verifyPreparedWorkItemReview(input, pr, ci),
      promote: (pr) =>
        publicationHost({
          operation: 'pr_merge',
          params: {
            ...options,
            ref: String(pr.number),
            method: 'squash',
            expectedHeadSha: pr.headSha,
            expectedBaseSha: pr.baseSha,
          },
        }),
    },
    input.dryRun !== false
  );
}

export function verifyPreparedWorkItemReview(
  input: PreparedDevelopmentInput,
  pr: VcsDevelopmentPr,
  ci: VcsDevelopmentCiProof
): { ok: boolean; reason?: string; reviewedBaseSha?: string } {
  try {
    const item = getWorkItem(input.workItemId);
    if (
      !item ||
      !['review', 'done'].includes(item.status) ||
      !item.context?.mission_id ||
      !item.context.task_id ||
      !item.assignee_peer_id
    )
      throw new Error('Prepare a mission-bound assigned WorkItem through the existing executor');
    const missionId = item.context.mission_id;
    const missionPath = missionPathOrNull(findMissionPath, missionId);
    if (!missionPath) throw new Error('Mission is missing');
    const tasks = loadMissionNextTaskObjectsAtPath(
      path.join(missionPath, 'NEXT_TASKS.json'),
      missionId
    ) as Array<{
      task_id: string;
      status: string;
      assigned_to?: { role: string; agent_id: string };
      artifact_review_profile?: unknown;
      review_target?: string;
      artifact_review_receipt?: string;
    }> | null;
    const task = tasks?.find((t) => t.task_id === input.reviewTaskId);
    if (
      !task ||
      !['done', 'completed', 'accepted', 'reviewed'].includes(task.status) ||
      !task.artifact_review_profile ||
      !['reviewer', 'qa'].includes(task.assigned_to?.role) ||
      task.review_target !== item.context.task_id ||
      !task.artifact_review_receipt
    )
      throw new Error('Complete the independent artifact-review task for this WorkItem');
    const receiptPath = path.resolve(missionPath, task.artifact_review_receipt);
    if (!pathResolver.isPathInside(missionPath, receiptPath))
      throw new Error('Receipt is outside mission');
    const receipt = loadArtifactReviewReceipt(assertSafeRepositoryPath(receiptPath));
    if (
      receipt.mission_id.toUpperCase() !== missionId.toUpperCase() ||
      receipt.review_task_id !== input.reviewTaskId ||
      receipt.review_target_task_id !== item.context.task_id ||
      receipt.reviewer.agent_id !== task.assigned_to.agent_id ||
      receipt.reviewer.agent_id === item.assignee_peer_id ||
      !receipt.reviewer.independence_verified ||
      !receipt.reviewer.independent_from.includes(item.assignee_peer_id) ||
      receipt.verdict !== 'approved' ||
      receipt.findings.some((f) => f.severity === 'blocking')
    )
      throw new Error('Independent reviewer identity and approval are required');
    const gate = validateMissionArtifactReviewGate({ missionId, missionPath });
    if (!gate.ok) throw new Error(gate.reason);
    const artifactPath = assertSafeRepositoryPath(pathResolver.rootResolve(receipt.artifact.path));
    const manifest = readReviewedDevelopmentManifest(artifactPath, receipt.artifact.sha256);
    const expected = {
      kind: 'vcs-development-revision',
      version: 1,
      repository: pr.repository,
      head_sha: pr.headSha,
      base_sha:
        pr.state === 'merged' &&
        typeof manifest.base_sha === 'string' &&
        /^[a-f0-9]{40,64}$/i.test(manifest.base_sha)
          ? manifest.base_sha
          : pr.baseSha,
      head_branch: pr.headBranch,
      base_branch: pr.baseBranch,
      work_item_id: input.workItemId,
      ci_policy_sha256: ci.policyDigest,
    };
    if (Object.entries(expected).some(([k, v]) => manifest[k] !== v))
      throw new Error('Review manifest does not bind current revision and CI policy');
    return { ok: true, reviewedBaseSha: String(manifest.base_sha) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Current independent review is unavailable',
    };
  }
}

/** Hash and interpret exactly one immutable byte snapshot, never two path reads. */
export function readReviewedDevelopmentManifest(
  artifactPath: string,
  expectedSha256: string,
  readBytes: (filePath: string) => Buffer = (filePath) =>
    Buffer.from(readTextFile(filePath), 'utf8')
): Record<string, unknown> {
  const bytes = Buffer.from(readBytes(artifactPath));
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256)
    throw new Error('Reviewed manifest changed');
  return parseSafeJsonObjectValue(
    parseSafeJsonInput(bytes.toString('utf8'), 'reviewed development manifest'),
    'reviewed development manifest'
  );
}

function verifyMerged(
  ports: DevelopmentLoopPorts,
  pr: VcsDevelopmentPr,
  reviewedBaseSha?: string,
  reviewedPolicyDigest?: string
): DevelopmentLoopResult {
  if (!pr.mergeCommitSha)
    return {
      status: 'post_merge_unverified',
      nextAction: 'Resolve immutable merge commit before completing the WorkItem',
      revision: pr,
    };
  let proof: VcsDevelopmentCiProof | undefined;
  try {
    if (reviewedBaseSha && /^[a-f0-9]{40,64}$/i.test(reviewedBaseSha))
      proof = ports.verifyMerged?.({ ...pr, baseSha: reviewedBaseSha });
  } catch {
    /* Retain the known effect on transport failure. */
  }
  const status =
    !reviewedPolicyDigest ||
    !proof ||
    proof.policyDigest !== reviewedPolicyDigest ||
    proof.state === 'unverified'
      ? 'post_merge_unverified'
      : proof.state === 'pending'
        ? 'post_merge_waiting'
        : proof.state === 'failure'
          ? 'post_merge_failed'
          : 'merged';
  return {
    status,
    nextAction:
      status === 'merged'
        ? 'Required CI on the immutable merge commit verified'
        : 'Reconcile required CI on the immutable merge commit; do not repeat promotion',
    revision: pr,
    knownMergeCommitSha: pr.mergeCommitSha,
    ...(proof?.policyDigest ? { policyDigest: proof.policyDigest } : {}),
  };
}
