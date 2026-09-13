import type { VisualReviewReport } from './visual-review.js';

export type ArtifactVerificationStage =
  'job' | 'file' | 'content' | 'visual_review' | 'human_approval';
export type ArtifactVerificationStageStatus = 'pending' | 'passed' | 'failed' | 'skipped';
export type ArtifactVerificationStatus = 'pending' | 'ready_for_approval' | 'approved' | 'blocked';

export interface ArtifactVerificationStageResult {
  stage: ArtifactVerificationStage;
  status: ArtifactVerificationStageStatus;
  detail: string;
}

export interface ArtifactVerificationInput {
  job: { status: 'queued' | 'running' | 'completed' | 'failed' };
  file: { exists: boolean; path?: string };
  content: { status: 'pending' | 'passed' | 'failed'; detail?: string };
  visual_review: VisualReviewReport;
  human_approval: { status: 'pending' | 'approved' | 'rejected' };
}

export interface ArtifactVerificationSummary {
  status: ArtifactVerificationStatus;
  publication_allowed: boolean;
  stages: ArtifactVerificationStageResult[];
}

/** KA-06: distinguish job receipt, artifact production, review, and approval. */
export function evaluateArtifactVerification(
  input: ArtifactVerificationInput
): ArtifactVerificationSummary {
  const stages: ArtifactVerificationStageResult[] = [
    {
      stage: 'job',
      status:
        input.job.status === 'completed'
          ? 'passed'
          : input.job.status === 'failed'
            ? 'failed'
            : 'pending',
      detail: `job:${input.job.status}`,
    },
    {
      stage: 'file',
      status: input.file.exists ? 'passed' : 'pending',
      detail: input.file.exists ? input.file.path || 'artifact exists' : 'artifact not generated',
    },
    {
      stage: 'content',
      status: input.content.status,
      detail: input.content.detail || `content:${input.content.status}`,
    },
    {
      stage: 'visual_review',
      status:
        input.visual_review.status === 'reviewed'
          ? input.visual_review.error_count > 0
            ? 'failed'
            : 'passed'
          : input.visual_review.status,
      detail:
        input.visual_review.status === 'reviewed'
          ? `${input.visual_review.images_reviewed} image(s) reviewed`
          : input.visual_review.skipped_reason || `visual review:${input.visual_review.status}`,
    },
    {
      stage: 'human_approval',
      status:
        input.human_approval.status === 'approved'
          ? 'passed'
          : input.human_approval.status === 'rejected'
            ? 'failed'
            : 'pending',
      detail: `approval:${input.human_approval.status}`,
    },
  ];

  const prerequisiteStages = stages.slice(0, 4);
  const prerequisiteFailed = prerequisiteStages.some((stage) =>
    ['failed', 'skipped'].includes(stage.status)
  );
  const prerequisitePending = prerequisiteStages.some((stage) => stage.status === 'pending');
  const status: ArtifactVerificationStatus = prerequisiteFailed
    ? 'blocked'
    : prerequisitePending
      ? 'pending'
      : input.human_approval.status === 'approved'
        ? 'approved'
        : input.human_approval.status === 'rejected'
          ? 'blocked'
          : 'ready_for_approval';

  return { status, publication_allowed: status === 'approved', stages };
}
