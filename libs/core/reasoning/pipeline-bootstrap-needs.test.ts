import { describe, expect, it } from 'vitest';
import { bootstrapReasonNeedsModel, pipelineBootstrapNeeds } from './pipeline-bootstrap-needs.js';
import { readJson } from '../foundation/json.js';

describe('pipelineBootstrapNeeds', () => {
  it.each(['baseline-check', 'vital-check', 'storage-janitor'])(
    'keeps the canonical %s diagnostic provider-free',
    (id) => {
      const pipeline = readJson<{ steps: Parameters<typeof pipelineBootstrapNeeds>[0] }>(
        `pipelines/${id}.json`
      );
      expect(pipelineBootstrapNeeds(pipeline.steps)).toEqual({
        required: false,
        reasons: [],
        model: false,
      });
    }
  );
  it.each([
    'ops-health-probe',
    'organization-operation-tick',
    'organization-standup',
    'organization-retro',
    'organization-kr-measure',
    'organization-daily-digest',
  ])('keeps the deterministic %s cadence provider-free', (id) => {
    const pipeline = readJson<{ steps: Parameters<typeof pipelineBootstrapNeeds>[0] }>(
      `pipelines/${id}.json`
    );
    expect(pipelineBootstrapNeeds(pipeline.steps)).toEqual({
      required: false,
      reasons: [],
      model: false,
    });
  });
  it('lets baseline report readiness without bootstrapping tenant credentials', () => {
    const baseline = [
      { op: 'system:baseline_check', params: { export_as: 'baseline_check' } },
      { op: 'system:log', params: { message: '{{baseline_check.status}}' } },
    ];
    expect(pipelineBootstrapNeeds(baseline)).toEqual({
      required: false,
      reasons: [],
      model: false,
    });
    expect(pipelineBootstrapNeeds([...baseline, { op: 'reasoning:query', params: {} }])).toEqual({
      required: true,
      reasons: ['reasoning:query'],
      model: true,
    });
  });
  it('does not discover provider credentials for deterministic logging and transforms', () => {
    expect(
      pipelineBootstrapNeeds([
        { op: 'system:log', params: { message: 'before' } },
        { op: 'core:transform', params: { input: 21, script: 'return Number(input) * 2;' } },
        { op: 'system:log', params: { message: 'after' } },
      ])
    ).toEqual({ required: false, reasons: [], model: false });
  });
  it('skips the bootstrap for volatile GC', () => {
    const needs = pipelineBootstrapNeeds([
      { op: 'working-memory:run-gc', params: { export_as: 'gc_result' } },
      {
        op: 'system:write_artifact',
        params: { path: 'active/shared/tmp/volatile-gc-report.md', content: 'report' },
      },
    ]);
    expect(needs.required).toBe(false);
    expect(needs.reasons).toEqual([]);
  });

  it('still initializes reasoning in a maintenance error fallback', () => {
    expect(
      pipelineBootstrapNeeds([
        {
          op: 'core:run_janitor',
          on_error: { fallback: [{ op: 'reasoning:query' }] },
        },
      ])
    ).toEqual({ required: true, reasons: ['reasoning:query'], model: true });
  });

  it('requires the bootstrap for an unclassified op', () => {
    const needs = pipelineBootstrapNeeds([{ op: 'system:exec', params: {} }]);
    expect(needs.required).toBe(true);
    expect(needs.reasons).toEqual(['system:exec']);
  });

  it('requires the bootstrap when a nested step judges', () => {
    const needs = pipelineBootstrapNeeds([
      {
        op: 'core:foreach',
        params: {
          items: [1],
          do: [{ op: 'wisdom:query', params: {} }],
        },
      },
    ]);
    expect(needs.required).toBe(true);
    expect(needs.reasons).toEqual(['wisdom:query']);
  });

  it('skips structural wrappers around inert steps', () => {
    const needs = pipelineBootstrapNeeds([
      {
        op: 'core:if',
        params: {
          then: [{ op: 'working-memory:run-gc', params: {} }],
          else: [{ op: 'system:write_artifact', params: {} }],
        },
      },
      { op: 'core:run_pipeline', params: { input: 'pipelines/other.json' } },
    ]);
    expect(needs.required).toBe(false);
  });

  it('treats judge_route as reasoning unless a fixture verdict is pinned', () => {
    expect(pipelineBootstrapNeeds([{ op: 'core:judge_route', params: {} }]).required).toBe(true);
    expect(
      pipelineBootstrapNeeds([
        { op: 'core:judge_route', params: { fixture: true, verdict: { route: 'ok' } } },
      ]).required
    ).toBe(false);
  });

  it('requires team_lead only when tasks are not already concrete', () => {
    expect(
      pipelineBootstrapNeeds([{ op: 'core:team_lead', params: { tasks: [{ id: 'a' }], do: [] } }])
        .required
    ).toBe(false);
    expect(pipelineBootstrapNeeds([{ op: 'core:team_lead', params: { do: [] } }]).required).toBe(
      true
    );
  });

  it('requires parallel_foreach when selection is a judge', () => {
    const judged = pipelineBootstrapNeeds([
      {
        op: 'core:parallel_foreach',
        params: {
          items_from: { selection: { judge: { prompt: 'pick' } } },
          do: [{ op: 'system:write_artifact', params: {} }],
        },
      },
    ]);
    expect(judged.required).toBe(true);
    const fixture = pipelineBootstrapNeeds([
      {
        op: 'core:parallel_foreach',
        params: { items_from: { selection: { fixture: [0] } }, do: [] },
      },
    ]);
    expect(fixture.required).toBe(false);
  });

  it('sees a reasoning op hidden in an error fallback', () => {
    const needs = pipelineBootstrapNeeds([
      {
        op: 'system:write_artifact',
        params: {},
        on_error: { fallback: [{ op: 'reasoning:analyze', params: {} }] },
      },
    ]);
    expect(needs.reasons).toEqual(['reasoning:analyze']);
  });

  it('requires core:include because the fragment is not visible yet', () => {
    expect(pipelineBootstrapNeeds([{ op: 'core:include', params: {} }]).required).toBe(true);
  });
});

describe('bootstrapReasonNeedsModel', () => {
  it('lets a keychain-and-browser scenario run without a tenant reasoning credential', () => {
    const needs = pipelineBootstrapNeeds([
      { op: 'secret:get', params: { service: 'garoon', account: 'user' } },
      {
        op: 'core:while',
        params: { do: [{ op: 'browser:evaluate' }, { op: 'system:wait' }] },
      },
      { op: 'core:if', params: { then: [{ op: 'browser:click_first_match' }] } },
    ]);
    expect(needs.required).toBe(true);
    expect(needs.reasons.some(bootstrapReasonNeedsModel)).toBe(false);
    expect(needs.model).toBe(false);
  });

  it('detects a model step after more distinct reasons than the display cap', () => {
    const browserOps = [
      'goto',
      'click',
      'fill',
      'evaluate',
      'press',
      'select',
      'hover',
      'check',
      'uncheck',
    ].map((op) => ({ op: `browser:${op}`, params: {} }));
    const needs = pipelineBootstrapNeeds([...browserOps, { op: 'reasoning:analyze', params: {} }]);
    expect(needs.reasons).toHaveLength(8);
    expect(needs.reasons).not.toContain('reasoning:analyze');
    expect(needs.model).toBe(true);
  });

  it('treats browser:llm_decide (a model call outside a model domain) as a model need', () => {
    expect(pipelineBootstrapNeeds([{ op: 'browser:llm_decide', params: {} }]).model).toBe(true);
    // Bare ops inside a browser control body are browser ops.
    expect(
      pipelineBootstrapNeeds([
        { op: 'browser:if', params: { then: [{ op: 'llm_decide', params: {} }] } },
      ]).model
    ).toBe(true);
  });

  it.each(['reasoning:query', 'wisdom:analyze', 'voice:speak', 'core:judge_route', 'core:unknown'])(
    'keeps %s on the credentialed path',
    (reason) => expect(bootstrapReasonNeedsModel(reason)).toBe(true)
  );

  it('keeps the depth-limit reason conservative', () => {
    const deep: { op: string; params?: Record<string, unknown> } = { op: 'system:log' };
    let step = deep;
    for (let i = 0; i < 40; i += 1) step = { op: 'core:if', params: { then: [step] } };
    const needs = pipelineBootstrapNeeds([step]);
    expect(needs.reasons.some(bootstrapReasonNeedsModel)).toBe(true);
    expect(needs.model).toBe(true);
  });
});
