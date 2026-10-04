import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOT_ACTION_ID,
  DOT_HANDOFF_ACTION_ID,
  MAX_DOT_PROPOSALS_PER_WAKE,
  collectDotProposals,
  normalizeDotProposal,
  parseDotProposalsFromText,
} from './dot-proposals.js';

describe('normalizeDotProposal', () => {
  it('defaults the action id and keeps only declared fields', () => {
    const proposal = normalizeDotProposal({
      title: 'Tick overdue operations',
      objective: 'Run the overdue operation tick and record the result.',
      work_shape: 'task_session',
      unexpected: 'dropped',
    });
    expect(proposal).toEqual({
      action_id: DEFAULT_DOT_ACTION_ID,
      title: 'Tick overdue operations',
      objective: 'Run the overdue operation tick and record the result.',
      work_shape: 'task_session',
    });
  });

  it('switches the default action to the handoff action when handoff_to is set', () => {
    const proposal = normalizeDotProposal({
      title: 'Investigate CI',
      objective: 'Look at the red main build.',
      work_shape: 'task_session',
      handoff_to: 'repo-guardian',
    });
    expect(proposal.action_id).toBe(DOT_HANDOFF_ACTION_ID);
    expect(proposal.handoff_to).toBe('repo-guardian');
  });

  it('ignores a dot-chosen action id', () => {
    const proposal = normalizeDotProposal({
      title: 't',
      objective: 'o',
      work_shape: 'task_session',
      action_id: 'some_low_risk_policy_action',
    });
    expect(proposal.action_id).toBe(DEFAULT_DOT_ACTION_ID);
  });

  it('rejects unknown shapes, decisions, and malformed ids', () => {
    expect(() =>
      normalizeDotProposal({ title: 't', objective: 'o', work_shape: 'deploy' })
    ).toThrow(/work_shape/);
    expect(() =>
      normalizeDotProposal({
        title: 't',
        objective: 'o',
        work_shape: 'task_session',
        requested_decision: 'never',
      })
    ).toThrow(/requested_decision/);
    expect(() =>
      normalizeDotProposal({ title: ' ', objective: 'o', work_shape: 'task_session' })
    ).toThrow(/title/);
  });
});

describe('collectDotProposals', () => {
  it('caps proposals per wake and reports the rest as errors', () => {
    const many = Array.from({ length: MAX_DOT_PROPOSALS_PER_WAKE + 2 }, (_, i) => ({
      title: `t${i}`,
      objective: 'o',
      work_shape: 'task_session',
    }));
    const result = collectDotProposals(many);
    expect(result.proposals).toHaveLength(MAX_DOT_PROPOSALS_PER_WAKE);
    expect(result.errors).toHaveLength(2);
  });
});

describe('parseDotProposalsFromText', () => {
  it('parses every fenced block and reports invalid ones', () => {
    const reply = [
      'Findings: two overdue operations.',
      '```dot-proposals',
      '[{"title":"Tick ops","objective":"Tick the overdue ops.","work_shape":"task_session"}]',
      '```',
      '```dot-proposals',
      '{not json}',
      '```',
    ].join('\n');
    const result = parseDotProposalsFromText(reply);
    expect(result.proposals.map((p) => p.title)).toEqual(['Tick ops']);
    expect(result.errors[0]).toMatch(/invalid JSON/);
  });

  it('returns nothing for a reply without a fence', () => {
    expect(parseDotProposalsFromText('all healthy')).toEqual({ proposals: [], errors: [] });
  });
});
