import { describe, expect, it } from 'vitest';
import { pipelineBootstrapNeeds } from './pipeline-bootstrap-needs.js';

describe('pipelineBootstrapNeeds', () => {
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
