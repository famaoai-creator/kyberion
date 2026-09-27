import { describe, expect, it } from 'vitest';
import { assessMissionMemoryCandidate, assessMissionSeedCandidate } from './mission-assessment.js';

describe('mission-assessment', () => {
  it('rejects mission memory candidates without evidence or summary', () => {
    const result = assessMissionMemoryCandidate({
      missionId: 'MSN-1',
      missionType: 'incident_response',
      summary: '',
      evidenceCount: 0,
      tier: 'confidential',
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/evidence/i);
  });

  it('accepts mission memory candidates with evidence and reusable summary', () => {
    const result = assessMissionMemoryCandidate({
      missionId: 'MSN-2',
      missionType: 'incident_response',
      summary: 'Reusable incident containment checklist for future responses.',
      evidenceCount: 2,
      tier: 'confidential',
    });

    expect(result.eligible).toBe(true);
    expect(result.proposedKind).toBe('risk_rule');
  });

  it('rejects mission seeds without source linkage or bootstrap hint', () => {
    const result = assessMissionSeedCandidate({
      projectId: 'PRJ-1',
      missionTypeHint: 'support',
      title: 'Follow-up task',
      summary: 'Do a thing later.',
      status: 'ready',
    });

    expect(result.eligible).toBe(false);
    expect(result.shouldPromote).toBe(false);
  });

  it('accepts promoted bootstrap seeds with source linkage and hint', () => {
    const result = assessMissionSeedCandidate({
      projectId: 'PRJ-2',
      missionTypeHint: 'project_bootstrap',
      title: 'Design architecture',
      summary: 'Design the first architecture slice for the new project.',
      sourceTaskSessionId: 'TSK-1',
      status: 'promoted',
    });

    expect(result.eligible).toBe(true);
    expect(result.shouldPromote).toBe(true);
  });
});
