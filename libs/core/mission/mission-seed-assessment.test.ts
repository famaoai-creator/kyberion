import { describe, expect, it } from 'vitest';
import { summarizeMissionSeedAssessment } from './mission-seed-assessment.js';

describe('summarizeMissionSeedAssessment', () => {
  it('counts eligible, flagged, unassessed, and promotable seeds', () => {
    const summary = summarizeMissionSeedAssessment([
      { seed_id: 'seed-eligible', metadata: { mission_seed_assessment: { eligible: true } } },
      {
        seed_id: 'seed-flagged',
        metadata: { mission_seed_assessment: { eligible: false, reason: 'missing evidence' } },
      },
      {
        seed_id: 'seed-promoted',
        promoted_mission_id: 'mission-1',
        metadata: { mission_seed_assessment: { eligible: true } },
      },
      { seed_id: 'seed-unassessed', metadata: {} },
    ]);

    expect(summary).toEqual({
      total: 4,
      eligible: 2,
      flagged: 1,
      unassessed: 1,
      promotable: 2,
      flagged_seed_ids: ['seed-flagged'],
      eligible_seed_ids: ['seed-eligible', 'seed-promoted'],
      promoted_seed_ids: ['seed-promoted'],
    });
  });
});
