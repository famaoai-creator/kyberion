export type AnalysisImpactBand = 'green' | 'amber' | 'gray';

export interface AnalysisImpactItem {
  ref: string;
  band: AnalysisImpactBand;
  reason: string;
}

export function classifyAnalysisImpactBands(input: {
  refs: string[];
  projectId?: string;
  trackId?: string;
  reviewTarget?: string;
  targetScope?: string;
}): AnalysisImpactItem[] {
  const projectId = String(input.projectId || '').trim();
  const trackId = String(input.trackId || '').trim();
  const reviewTarget = String(input.reviewTarget || '').trim();
  const targetScope = String(input.targetScope || '').trim();

  return input.refs.map((ref) => {
    if (reviewTarget && ref.includes(reviewTarget)) {
      return { ref, band: 'green' as const, reason: 'directly matches the inferred review target' };
    }
    if (trackId && ref.includes(trackId)) {
      return { ref, band: 'green' as const, reason: 'belongs to the active track scope' };
    }
    if (projectId && ref.includes(projectId)) {
      return { ref, band: 'green' as const, reason: 'belongs to the active project scope' };
    }
    if (targetScope && ref.includes(targetScope)) {
      return { ref, band: 'green' as const, reason: 'belongs to the inferred remediation scope' };
    }
    if (ref.startsWith('knowledge/public/incidents/')) {
      return { ref, band: 'amber' as const, reason: 'incident knowledge should inform review but still requires operator judgment' };
    }
    if (ref.startsWith('knowledge/')) {
      return { ref, band: 'gray' as const, reason: 'broader knowledge is informative but not directly bound to the target' };
    }
    return { ref, band: 'amber' as const, reason: 'governed reference requires confirmation before execution fan-out' };
  });
}
