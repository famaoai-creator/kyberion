import { describe, expect, it } from 'vitest';
import { buildChronosNextActions, summarizeMissionSeedAssessment } from './control_plane_cli.js';

describe('control_plane_cli next actions', () => {
  it('prioritizes flagged mission seeds before promotable seeds', () => {
    const actions = buildChronosNextActions({
      pendingApprovals: 0,
      memoryCandidates: [],
      missionSeeds: [
        {
          seed_id: 'MSD-1',
          title: 'Flagged seed',
          metadata: {
            mission_seed_assessment: {
              eligible: false,
              reason: 'Mission seed lacks a strong source linkage or bootstrap hint.',
            },
          },
        },
        {
          seed_id: 'MSD-2',
          title: 'Eligible seed',
          metadata: {
            mission_seed_assessment: {
              eligible: true,
              reason: 'Mission seed is linked to source work and has a concrete bootstrap hint.',
            },
          },
        },
      ],
    });

    expect(actions[0]?.next_action_type).toBe('inspect_evidence');
    expect(actions[0]?.reason).toMatch(/flagged by assessment/i);
    expect(actions[1]?.next_action_type).toBe('promote_mission_seed');
  });

  it('summarizes mission seed assessment for overview json', () => {
    const summary = summarizeMissionSeedAssessment([
      {
        seed_id: 'MSD-1',
        metadata: {
          mission_seed_assessment: {
            eligible: false,
            reason: 'Needs review',
          },
        },
      },
      {
        seed_id: 'MSD-2',
        metadata: {
          mission_seed_assessment: {
            eligible: true,
            reason: 'Looks good',
          },
        },
        promoted_mission_id: 'MSN-2',
      },
      {
        seed_id: 'MSD-3',
      },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.flagged).toBe(1);
    expect(summary.eligible).toBe(1);
    expect(summary.unassessed).toBe(1);
    expect(summary.promotable).toBe(1);
    expect(summary.flagged_seed_ids).toEqual(['MSD-1']);
    expect(summary.eligible_seed_ids).toEqual(['MSD-2']);
    expect(summary.promoted_seed_ids).toEqual(['MSD-2']);
  });
});
