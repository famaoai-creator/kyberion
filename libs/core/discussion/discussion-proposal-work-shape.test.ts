import { describe, expect, it } from 'vitest';
import { discussionProposalWorkShape } from './discussion-outcomes.js';

/*
 * R3 of the intent resolver unification plan: a discussion proposal's
 * organization work shape comes from the resolver entry reading the agreed
 * proposal, not a hard-coded `solution_project`.
 */
const room = { scope: {} };

describe('discussion proposal work shape', () => {
  it('takes a confident shape from the resolver', () => {
    expect(
      discussionProposalWorkShape(room, {
        title: '本番障害を収束させる',
        description: '',
      })
    ).toBe('incident_response');
    expect(
      discussionProposalWorkShape(room, {
        title: '予算の承認フローを決めたい',
        description: '',
      })
    ).toBe('governance_cadence');
  });

  it('keeps the solution_project default for an unclear proposal', () => {
    expect(discussionProposalWorkShape(room, { title: '請求まわり', description: '' })).toBe(
      'solution_project'
    );
    expect(discussionProposalWorkShape(room, { title: '', description: '' })).toBe(
      'solution_project'
    );
  });
});
