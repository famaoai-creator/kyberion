import type { AnalysisFindingCandidate } from './analysis-findings.js';
import type { ReviewExecutionTargetBinding } from './analysis-intent-support.js';

export interface AnalysisExecutionContract {
  contract_kind: 'analysis_follow_up_execution';
  analysis_kind?: string;
  target_kind?: string;
  review_target?: string;
  repository_id?: string;
  repository_root_path?: string;
  target_path?: string;
  pr_number?: number;
  recommended_action: 'review' | 'remediation' | 'verification' | 'analysis';
  primary_finding_id?: string;
  primary_finding_title?: string;
  boundary?: {
    llm_role: string;
    knowledge_role: string;
    compiler_role: string;
    executor_role: string;
  };
}

export function buildAnalysisExecutionContract(input: {
  analysisKind?: string;
  reviewExecutionTarget?: ReviewExecutionTargetBinding;
  findings?: AnalysisFindingCandidate[];
  actionType?: 'review' | 'remediation' | 'verification';
}): AnalysisExecutionContract {
  const primaryFinding = input.findings?.find((finding) =>
    input.actionType ? finding.action_type === input.actionType : true,
  ) || input.findings?.[0];

  return {
    contract_kind: 'analysis_follow_up_execution',
    analysis_kind: input.analysisKind,
    target_kind: input.reviewExecutionTarget?.target_kind,
    review_target: input.reviewExecutionTarget?.review_target,
    repository_id: input.reviewExecutionTarget?.repository_id,
    repository_root_path: input.reviewExecutionTarget?.repository_root_path,
    target_path: input.reviewExecutionTarget?.target_path,
    pr_number: input.reviewExecutionTarget?.pr_number,
    recommended_action: input.actionType || primaryFinding?.action_type || 'analysis',
    primary_finding_id: primaryFinding?.finding_id,
    primary_finding_title: primaryFinding?.title,
    boundary: {
      llm_role: 'draft findings language and summaries only',
      knowledge_role: 'define process, outcomes, and specialist routing',
      compiler_role: 'bind targets, impact bands, and execution contract',
      executor_role: 'persist artifacts and create governed follow-up seeds',
    },
  };
}
