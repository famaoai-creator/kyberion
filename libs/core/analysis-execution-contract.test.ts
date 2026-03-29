import { describe, expect, it } from 'vitest';
import { buildAnalysisExecutionContract } from './analysis-execution-contract.js';

describe('analysis-execution-contract', () => {
  it('builds an execution contract from review target binding and findings', () => {
    const contract = buildAnalysisExecutionContract({
      analysisKind: 'incident_informed_review',
      reviewExecutionTarget: {
        target_kind: 'pull_request',
        review_target: 'pull_request:128',
        repository_id: 'REPO-DEMO',
        repository_root_path: 'active/projects/demo',
        pr_number: 128,
      },
      actionType: 'review',
      findings: [
        {
          finding_id: 'finding-pr-128-review',
          title: 'Review prior incident exposure for pull_request:128',
          severity: 'high',
          action_type: 'review',
          rationale: 'Example',
          refs: ['knowledge/public/incidents/post-mortem-20260228.md'],
        },
      ],
    });

    expect(contract).toMatchObject({
      contract_kind: 'analysis_follow_up_execution',
      analysis_kind: 'incident_informed_review',
      target_kind: 'pull_request',
      review_target: 'pull_request:128',
      repository_id: 'REPO-DEMO',
      pr_number: 128,
      recommended_action: 'review',
      primary_finding_id: 'finding-pr-128-review',
    });
  });
});
