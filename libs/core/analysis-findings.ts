import type { AnalysisCorpusSnippet } from './analysis-corpus.js';
import type { AnalysisImpactItem } from './analysis-impact-bands.js';
import type { ReviewExecutionTargetBinding } from './analysis-intent-support.js';

export interface AnalysisFindingCandidate {
  finding_id: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  action_type: 'review' | 'remediation' | 'verification';
  rationale: string;
  refs: string[];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'finding';
}

export function buildAnalysisFindingCandidates(input: {
  analysisKind?: string;
  impactBands: AnalysisImpactItem[];
  snippets: AnalysisCorpusSnippet[];
  reviewExecutionTarget?: ReviewExecutionTargetBinding;
}): AnalysisFindingCandidate[] {
  const findings: AnalysisFindingCandidate[] = [];
  const analysisKind = String(input.analysisKind || '').trim();
  const targetLabel =
    input.reviewExecutionTarget?.review_target ||
    input.reviewExecutionTarget?.repository_id ||
    'governed-target';

  const greenRefs = input.impactBands.filter((item) => item.band === 'green').map((item) => item.ref);
  const amberRefs = input.impactBands.filter((item) => item.band === 'amber').map((item) => item.ref);
  const snippetRefs = input.snippets.slice(0, 3).map((item) => item.ref);

  if (analysisKind === 'incident_informed_review') {
    findings.push({
      finding_id: `finding-${slugify(targetLabel)}-review`,
      title: `Review prior incident exposure for ${targetLabel}`,
      severity: greenRefs.length > 0 ? 'high' : 'medium',
      action_type: 'review',
      rationale: 'The current target should be reviewed against the nearest governed evidence and prior incidents before execution continues.',
      refs: [...new Set([...greenRefs, ...amberRefs, ...snippetRefs])].slice(0, 4),
    });
    findings.push({
      finding_id: `finding-${slugify(targetLabel)}-verify`,
      title: `Verify controls and regression coverage for ${targetLabel}`,
      severity: amberRefs.length > 0 ? 'medium' : 'low',
      action_type: 'verification',
      rationale: 'Incident-linked references imply control checks or regression coverage should be made explicit.',
      refs: [...new Set([...amberRefs, ...greenRefs])].slice(0, 4),
    });
  } else if (analysisKind === 'cross_project_remediation') {
    findings.push({
      finding_id: `finding-${slugify(targetLabel)}-remediate`,
      title: `Remediate propagation gaps for ${targetLabel}`,
      severity: greenRefs.length > 0 ? 'high' : 'medium',
      action_type: 'remediation',
      rationale: 'Governed references indicate a likely propagation gap that should be converted into bounded remediation work.',
      refs: [...new Set([...greenRefs, ...amberRefs, ...snippetRefs])].slice(0, 4),
    });
    findings.push({
      finding_id: `finding-${slugify(targetLabel)}-coverage`,
      title: `Verify propagation coverage for ${targetLabel}`,
      severity: amberRefs.length > 0 ? 'medium' : 'low',
      action_type: 'verification',
      rationale: 'Cross-project fixes should be paired with an explicit verification pass over the governed scope.',
      refs: [...new Set([...amberRefs, ...greenRefs])].slice(0, 4),
    });
  }

  return findings;
}
