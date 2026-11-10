import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOT_ACTION_ID,
  DOT_HANDOFF_ACTION_ID,
  MAX_DOT_PROPOSALS_PER_WAKE,
  collectDotProposals,
  normalizeDotProposal,
  parseDotProposalsFromText,
  buildDotProposeToolDefinition,
  dotProposalInstructions,
} from './dot-proposals.js';

describe('normalizeDotProposal', () => {
  it('rejects an own reserved semantic field even when undefined and never advertises it', () => {
    const proposal = {
      title: 't',
      objective: 'o',
      execution_shape: 'pipeline',
      pipeline_ref: 'pipelines/x.json',
    };
    for (const value of [
      undefined,
      null,
      {},
      { mode: 'synthetic_fixture', origin_receipt: 'forged' },
    ]) {
      expect(() => normalizeDotProposal({ ...proposal, semantic_judgment: value })).toThrow(
        /reserved/
      );
      expect(collectDotProposals([{ ...proposal, semantic_judgment: value }])).toMatchObject({
        proposals: [],
        errors: [expect.stringContaining('reserved')],
      });
    }
    expect(
      parseDotProposalsFromText(
        '```dot-proposals\n' + JSON.stringify([{ ...proposal, semantic_judgment: {} }]) + '\n```'
      )
    ).toMatchObject({ proposals: [], errors: [expect.stringContaining('reserved')] });
    expect(buildDotProposeToolDefinition().inputSchema.properties).not.toHaveProperty(
      'semantic_judgment'
    );
    expect(normalizeDotProposal(proposal)).not.toHaveProperty('semantic_judgment');
  });

  it('defaults the action id and keeps only declared fields', () => {
    const proposal = normalizeDotProposal({
      title: 'Tick overdue operations',
      objective: 'Run the overdue operation tick and record the result.',
      execution_shape: 'task_session',
      unexpected: 'dropped',
    });
    expect(proposal).toEqual({
      action_id: DEFAULT_DOT_ACTION_ID,
      title: 'Tick overdue operations',
      objective: 'Run the overdue operation tick and record the result.',
      execution_shape: 'task_session',
    });
  });

  it('switches the default action to the handoff action when handoff_to is set', () => {
    const proposal = normalizeDotProposal({
      title: 'Investigate CI',
      objective: 'Look at the red main build.',
      execution_shape: 'task_session',
      handoff_to: 'repo-guardian',
    });
    expect(proposal.action_id).toBe(DOT_HANDOFF_ACTION_ID);
    expect(proposal.handoff_to).toBe('repo-guardian');
  });

  it('ignores a dot-chosen action id', () => {
    const proposal = normalizeDotProposal({
      title: 't',
      objective: 'o',
      execution_shape: 'task_session',
      action_id: 'some_low_risk_policy_action',
    });
    expect(proposal.action_id).toBe(DEFAULT_DOT_ACTION_ID);
  });

  it('reads the deprecated work_shape alias for one release and refuses a conflicting pair', () => {
    const legacy = normalizeDotProposal({ title: 't', objective: 'o', work_shape: 'pipeline' });
    expect(legacy.execution_shape).toBe('pipeline');
    expect(legacy).not.toHaveProperty('work_shape');
    expect(
      normalizeDotProposal({
        title: 't',
        objective: 'o',
        execution_shape: 'pipeline',
        work_shape: 'pipeline',
      }).execution_shape
    ).toBe('pipeline');
    expect(() =>
      normalizeDotProposal({
        title: 't',
        objective: 'o',
        execution_shape: 'pipeline',
        work_shape: 'mission',
      })
    ).toThrow(/differ/);
    expect(() =>
      normalizeDotProposal({
        title: 't',
        objective: 'o',
        execution_shape: 'pipeline',
        schema_version: 1,
      })
    ).toThrow(/schema_version/);
  });

  it('names execution_shape in the tool schema and the fenced-reply instructions', () => {
    const tool = buildDotProposeToolDefinition();
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties).toHaveProperty('execution_shape');
    expect(schema.properties).not.toHaveProperty('work_shape');
    expect(schema.required).toContain('execution_shape');
    expect(dotProposalInstructions('fence')).toContain('"execution_shape": "direct_reply"');
    expect(dotProposalInstructions('fence')).not.toContain('work_shape');
  });

  it('rejects unknown shapes, decisions, and malformed ids', () => {
    expect(() =>
      normalizeDotProposal({ title: 't', objective: 'o', work_shape: 'deploy' })
    ).toThrow(/execution_shape/);
    expect(() =>
      normalizeDotProposal({
        title: 't',
        objective: 'o',
        execution_shape: 'task_session',
        requested_decision: 'never',
      })
    ).toThrow(/requested_decision/);
    expect(() =>
      normalizeDotProposal({ title: ' ', objective: 'o', execution_shape: 'task_session' })
    ).toThrow(/title/);
  });
});

describe('collectDotProposals', () => {
  it('caps proposals per wake and reports the rest as errors', () => {
    const many = Array.from({ length: MAX_DOT_PROPOSALS_PER_WAKE + 2 }, (_, i) => ({
      title: `t${i}`,
      objective: 'o',
      execution_shape: 'task_session',
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
      '[{"title":"Tick ops","objective":"Tick the overdue ops.","execution_shape":"task_session"}]',
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

  it('keeps pipeline_ref, expected_effect, target and intent', () => {
    const proposal = normalizeDotProposal({
      title: 'Run it',
      objective: 'Run the pipeline',
      execution_shape: 'pipeline',
      pipeline_ref: 'pipelines/x.json',
      expected_effect: { kr_id: 'ci-green', direction: 'increase' },
      target: 'service:github',
      intent: 'apply',
    });
    expect(proposal).toMatchObject({
      pipeline_ref: 'pipelines/x.json',
      expected_effect: { kr_id: 'ci-green', direction: 'increase' },
      target: 'service:github',
      intent: 'apply',
    });
  });

  it('drops malformed expected_effect, target and intent but keeps the proposal', () => {
    const base = { title: 't', objective: 'o', execution_shape: 'task_session' };
    for (const extra of [
      { expected_effect: { direction: 'increase' } },
      { expected_effect: { signal: 's', direction: 'up' } },
      { target: 'organization:acme/operations' },
      { intent: 'explode' },
    ]) {
      const proposal = normalizeDotProposal({ ...base, ...extra });
      expect(proposal).toMatchObject({ title: 't', objective: 'o' });
      expect(proposal.expected_effect).toBeUndefined();
      expect(proposal.target).toBeUndefined();
      expect(proposal.intent).toBeUndefined();
    }
  });

  it('parses the new fields from a fenced block', () => {
    const reply =
      '```dot-proposals\n[{"title":"t","objective":"o","execution_shape":"pipeline","target":"pr:a/b#12","intent":"merge"}]\n```';
    expect(parseDotProposalsFromText(reply).proposals[0]).toMatchObject({
      target: 'pr:a/b#12',
      intent: 'merge',
    });
  });
});
