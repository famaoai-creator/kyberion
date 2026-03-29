import { describe, expect, it } from 'vitest';
import { buildAnalysisFindingCandidates } from './analysis-findings.js';

describe('analysis-findings', () => {
  it('builds review and verification findings for incident-informed review', () => {
    const findings = buildAnalysisFindingCandidates({
      analysisKind: 'incident_informed_review',
      impactBands: [
        { ref: 'active/projects/demo/tracks/TRK-1/review.md', band: 'green', reason: 'active track' },
        { ref: 'knowledge/public/incidents/post-mortem-20260228.md', band: 'amber', reason: 'incident' },
      ],
      snippets: [
        { ref: 'knowledge/public/incidents/post-mortem-20260228.md', title: 'Incident', excerpt: 'Example' },
      ],
      reviewExecutionTarget: {
        target_kind: 'pull_request',
        review_target: 'pull_request:128',
        repository_id: 'REPO-DEMO',
      },
    });

    expect(findings).toHaveLength(2);
    expect(findings[0]?.action_type).toBe('review');
    expect(findings[1]?.action_type).toBe('verification');
    expect(findings[0]?.refs.length).toBeGreaterThan(0);
  });
});
