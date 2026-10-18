import { describe, expect, it } from 'vitest';
import { parseContinuousWorkPlan } from './continuous-work-plan.js';
import { normalizeDotProposal } from '../dot/dot-proposals.js';
import { dotProposalHash } from '../dot/dot-action-ledger.js';
const mission = {
  key: 'investigate',
  title: 'Investigate errors',
  goal: 'Find cause',
  success_condition: 'Cause verified',
};
describe('continuous managed work plan', () => {
  it('accepts a bounded dependency graph and rejects cycles, dangling keys and duplicates', () => {
    const valid = {
      kind: 'mission_group',
      missions: [mission, { ...mission, key: 'fix', depends_on: ['investigate'] }],
    };
    expect(parseContinuousWorkPlan(valid).missions).toHaveLength(2);
    expect(() =>
      parseContinuousWorkPlan({
        ...valid,
        missions: [{ ...mission, depends_on: ['fix'] }, valid.missions[1]],
      })
    ).toThrow('Cyclic');
    expect(() =>
      parseContinuousWorkPlan({ ...valid, missions: [{ ...mission, depends_on: ['missing'] }] })
    ).toThrow('Unknown');
    expect(() => parseContinuousWorkPlan({ ...valid, missions: [mission, mission] })).toThrow(
      'Duplicate'
    );
  });
  it('requires project data only for project plans and strictly rejects unknown authority fields', () => {
    expect(() => parseContinuousWorkPlan({ kind: 'project', missions: [mission] })).toThrow(
      'project'
    );
    expect(() =>
      parseContinuousWorkPlan({ kind: 'mission', missions: [mission], actor: 'user:invented' })
    ).toThrow('unknown');
    expect(() =>
      parseContinuousWorkPlan({ kind: 'mission', missions: [{ ...mission, key: '../escape' }] })
    ).toThrow();
  });
  it('model normalization strips managed authority and dedupe hashes bind trusted plans', () => {
    const proposal = {
      title: 'Investigate',
      objective: 'Fix failures',
      work_shape: 'pipeline',
      continuous_work: { kind: 'mission', missions: [mission] },
    };
    const normalized = normalizeDotProposal(proposal);
    expect(normalized.continuous_work).toBeUndefined();
    const trusted = {
      ...normalized,
      continuous_work: parseContinuousWorkPlan(proposal.continuous_work),
    };
    expect(dotProposalHash('operator', normalized)).not.toBe(dotProposalHash('operator', trusted));
    expect(dotProposalHash('operator', trusted)).not.toBe(
      dotProposalHash('operator', {
        ...trusted,
        continuous_work: {
          ...trusted.continuous_work,
          missions: [{ ...mission, goal: 'Different effect' }],
        },
      })
    );
  });
});
