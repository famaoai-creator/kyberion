import { describe, expect, it } from 'vitest';
import { assessPipelineDryRun } from './pipeline-dry-run.js';

const base = {
  pipeline_id: 'dry-run-test',
  steps: [{ id: 'known', op: 'core:if', params: {} }],
};

describe('pipeline dry-run assessment', () => {
  it('returns ready without dispatching a step', () => {
    const report = assessPipelineDryRun(base);
    expect(report.verdict).toBe('ready');
    expect(report.side_effects).toBe('none');
  });

  it('treats TAKT control stages as executable control, not missing actuators', () => {
    const report = assessPipelineDryRun({
      pipeline_id: 'takt-control-dry-run',
      steps: [
        {
          id: 'judge',
          op: 'core:judge_route',
          params: { routes: [{ when: { label: 'ok' }, next: 'COMPLETE' }] },
        },
        {
          id: 'approval',
          op: 'core:await_decision',
          params: { approval: { summary: 'human decision' } },
        },
      ],
    });

    expect(report.verdict).toBe('ready');
  });

  it('blocks an unknown actuator operation', () => {
    const report = assessPipelineDryRun({
      ...base,
      steps: [{ id: 'bad', op: 'missing:operation', params: {} }],
    });
    expect(report.verdict).toBe('blocked');
    expect(report.next_actions.join('\n')).toContain('missing:operation');
  });

  it('reports missing authentication from a supplied provider snapshot', () => {
    const report = assessPipelineDryRun(
      {
        ...base,
        context: { provider: 'gemini' },
        steps: [{ id: 'reason', op: 'reasoning:analyze', params: {} }],
      },
      {
        providerSnapshot: [
          {
            provider_id: 'gemini',
            binary_found: true,
            authenticated: false,
            headless: true,
            structured_output: true,
            models: [],
            probed_at: new Date().toISOString(),
          },
        ],
      }
    );
    expect(report.verdict).toBe('blocked');
    expect(report.checks.some((check) => check.id === 'provider-auth')).toBe(true);
  });

  it('reports a demoted provider without probing it', () => {
    const report = assessPipelineDryRun(
      { ...base, context: { provider: 'claude' } },
      { providerSnapshot: [], demotedProviders: new Set(['claude']) }
    );
    expect(report.verdict).toBe('blocked');
    expect(report.checks.some((check) => check.id === 'provider-health')).toBe(true);
  });
});
