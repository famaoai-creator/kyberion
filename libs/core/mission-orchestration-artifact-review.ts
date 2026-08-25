import * as nodePath from 'node:path';
import {
  buildArtifactReviewReceipt,
  hashArtifactForReview,
  inferArtifactReviewKind,
} from './artifact-review.js';
import { missionDir, pathResolver } from './path-resolver.js';
import { resolveMissionTeamReceiver } from './mission-team-plan-composer.js';
import { resolveArtifactReviewerProfile } from './mission-review-gates.js';
import { missionClassOf, missionRiskProfileOf } from './mission-orchestration-phase-gates.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { PlannedNextTask } from './mission-orchestration-worker-contracts.js';

export function resolveReviewTargetForTask(task: PlannedNextTask): string | undefined {
  if (typeof task.review_target === 'string' && task.review_target.trim()) {
    return task.review_target.trim();
  }
  const deliverable = String(task.deliverable || '').trim();
  const match = deliverable.match(/(?:^|\/)REVIEW-(.+)\.md$/u);
  return match?.[1] ? match[1] : undefined;
}

export function resolveReviewArtifact(input: {
  missionId: string;
  reviewTask: PlannedNextTask;
  tasks: PlannedNextTask[];
}): {
  targetTask: PlannedNextTask;
  absolutePath?: string;
  repositoryPath?: string;
  kind: 'doc' | 'deck' | 'code' | 'media';
  sha256?: string;
  implementerAgentIds: string[];
} | null {
  const reviewTarget = resolveReviewTargetForTask(input.reviewTask);
  if (!reviewTarget) return null;
  const targetTask = input.tasks.find((task) => task.task_id === reviewTarget);
  if (!targetTask) return null;
  const missionPath = missionDir(input.missionId, 'public');
  const diffPath = nodePath.join(missionPath, 'evidence', 'prs', reviewTarget, 'diff.patch');
  const resultArtifacts = (targetTask.last_result?.artifacts || [])
    .map((artifact) => String(artifact?.path || '').trim())
    .filter(Boolean);
  const reconciledArtifacts = (targetTask.reconciliation?.evidence || [])
    .filter((evidence) => evidence.kind === 'artifact')
    .map((evidence) => String(evidence.path || '').trim())
    .filter(Boolean);
  const candidates = [
    diffPath,
    ...resultArtifacts,
    ...reconciledArtifacts,
    String(targetTask.target_path || '').trim(),
    String(targetTask.deliverable || '').trim(),
  ].filter(Boolean);
  let absolutePath: string | undefined;
  for (const candidate of candidates) {
    const possiblePaths = nodePath.isAbsolute(candidate)
      ? [candidate]
      : [nodePath.join(missionPath, candidate), pathResolver.rootResolve(candidate)];
    absolutePath = possiblePaths.find((possible) => safeExistsSync(possible));
    if (absolutePath) break;
  }
  const kind = inferArtifactReviewKind(
    String(targetTask.target_path || absolutePath || targetTask.deliverable || '')
  );
  const targetRole = String(targetTask.assigned_to?.role || '').trim();
  const resolvedAgent =
    targetRole && !targetTask.assigned_to?.agent_id
      ? resolveMissionTeamReceiver({ missionId: input.missionId, teamRole: targetRole })?.agent_id
      : undefined;
  const implementerAgentIds = Array.from(
    new Set(
      [targetTask.assigned_to?.agent_id, resolvedAgent].filter((value): value is string =>
        Boolean(value)
      )
    )
  );
  return {
    targetTask,
    ...(absolutePath
      ? {
          absolutePath,
          repositoryPath: pathResolver.toRepoRelative(absolutePath),
          sha256: hashArtifactForReview(absolutePath),
        }
      : {}),
    kind,
    implementerAgentIds,
  };
}

export function prepareArtifactReviewTask(input: {
  missionId: string;
  reviewTask: PlannedNextTask;
  tasks: PlannedNextTask[];
}): ReturnType<typeof resolveReviewArtifact> {
  const artifact = resolveReviewArtifact(input);
  if (!artifact) return null;
  input.reviewTask.artifact_review_profile = {
    ...resolveArtifactReviewerProfile({
      artifactKind: artifact.kind,
      missionClass: missionClassOf(input.missionId),
      riskProfile:
        missionRiskProfileOf(input.missionId) || artifact.targetTask.risk || input.reviewTask.risk,
    }),
    ...(artifact.repositoryPath ? { artifact_path: artifact.repositoryPath } : {}),
    ...(artifact.sha256 ? { artifact_sha256: artifact.sha256 } : {}),
    implementer_agent_ids: artifact.implementerAgentIds,
  };
  return artifact;
}

export function buildArtifactReviewLines(task: PlannedNextTask): string[] {
  const profile = task.artifact_review_profile;
  if (!profile) return [];
  return [
    '## Artifact quality review mandate',
    `- Specialist perspectives: ${profile.required_reviewer_roles.join(', ')}`,
    `- Independence required: ${profile.independence_required}`,
    profile.implementer_agent_ids.length > 0
      ? `- Must be independent from: ${profile.implementer_agent_ids.join(', ')}`
      : '- Implementer identity unavailable; explicitly report any independence uncertainty.',
    profile.artifact_path ? `- Artifact: ${profile.artifact_path}` : '- Artifact path unavailable.',
    profile.artifact_sha256 ? `- Artifact SHA-256: ${profile.artifact_sha256}` : '',
    `- ${profile.rationale}`,
    '- Try to falsify every acceptance criterion. Report concrete defects rather than affirming the author.',
    '- Use must_fix only for defects that block acceptance; should_fix and nit do not block completion.',
    '',
  ].filter(Boolean);
}

export function persistArtifactReviewReceipt(input: {
  missionId: string;
  reviewTask: PlannedNextTask;
  teamRole: 'reviewer' | 'qa';
  reviewerAgentId: string;
  artifact: NonNullable<ReturnType<typeof resolveReviewArtifact>>;
  findings: Array<{
    severity: 'must_fix' | 'should_fix' | 'nit';
    location: string;
    instruction: string;
  }>;
  reviewRound: number;
}): string | null {
  const profile = input.reviewTask.artifact_review_profile;
  if (!profile || !input.artifact.repositoryPath || !input.artifact.sha256) return null;
  const missionPath = missionDir(input.missionId, 'public');
  const relativePath = `evidence/reviews/${input.reviewTask.task_id}-r${input.reviewRound}.json`;
  const receiptPath = nodePath.join(missionPath, relativePath);
  const receipt = buildArtifactReviewReceipt({
    reviewId: `${input.reviewTask.task_id}-r${input.reviewRound}`,
    missionId: input.missionId,
    reviewTaskId: input.reviewTask.task_id,
    reviewTargetTaskId: input.artifact.targetTask.task_id,
    artifact: {
      path: input.artifact.repositoryPath,
      sha256: input.artifact.sha256,
      kind: input.artifact.kind,
    },
    reviewerAgentId: input.reviewerAgentId,
    reviewerTeamRole: input.teamRole,
    specialistRoles: profile.required_reviewer_roles,
    independentFrom: profile.implementer_agent_ids,
    findings: input.findings.map((finding) => ({
      severity: finding.severity === 'must_fix' ? 'blocking' : 'suggestion',
      category: 'artifact_quality',
      description: finding.instruction,
      ...(finding.severity === 'must_fix' ? { required_action: finding.instruction } : {}),
      location: finding.location,
    })),
    acceptanceCriteria: input.reviewTask.acceptance_criteria?.length
      ? input.reviewTask.acceptance_criteria
      : [input.reviewTask.description || `Review ${input.artifact.targetTask.task_id}`],
  });
  safeMkdir(nodePath.dirname(receiptPath), { recursive: true });
  safeWriteFile(receiptPath, JSON.stringify(receipt, null, 2));
  input.reviewTask.artifact_review_receipt = relativePath;
  return relativePath;
}

export function normalizeReviewFindings(
  findings: unknown
): Array<{ severity: 'must_fix' | 'should_fix' | 'nit'; location: string; instruction: string }> {
  if (!Array.isArray(findings)) return [];
  return findings
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const finding = entry as Record<string, unknown>;
      const severity = String(finding.severity || '').trim();
      const location = String(finding.location || '').trim();
      const instruction = String(finding.instruction || '').trim();
      if (
        (severity !== 'must_fix' && severity !== 'should_fix' && severity !== 'nit') ||
        !location ||
        !instruction
      ) {
        return null;
      }
      return { severity, location, instruction };
    })
    .filter(
      (
        entry
      ): entry is {
        severity: 'must_fix' | 'should_fix' | 'nit';
        location: string;
        instruction: string;
      } => Boolean(entry)
    );
}
