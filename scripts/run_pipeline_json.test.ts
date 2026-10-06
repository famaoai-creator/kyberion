import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runSteps: vi.fn() }));

vi.mock('./pipeline-execution-part-execution.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pipeline-execution-part-execution.js')>()),
  runSteps: mocks.runSteps,
}));

import * as killSwitch from '@agent/core/governance/kill-switch';
import { main as runPipelineMain } from './pipeline-execution-part-results.js';

describe('pipeline --json run summary', () => {
  afterEach(() => {
    killSwitch.killSwitch.stopMonitor?.();
    vi.clearAllMocks();
  });

  it('prints a run summary (not the pipeline context) through the injected printer', async () => {
    mocks.runSteps.mockResolvedValue({
      status: 'succeeded',
      results: [
        { op: 'system:baseline_check', status: 'success' },
        { op: 'system:log', status: 'success' },
      ],
      context: { baseline_check: { secret_detail: 'must not be printed' } },
    });
    const output: unknown[] = [];

    await runPipelineMain(['--input', 'pipelines/baseline-check.json', '--json'], (value) =>
      output.push(value)
    );

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      pipeline_id: 'baseline-check',
      input: 'pipelines/baseline-check.json',
      status: 'succeeded',
      recovered: false,
      steps: [
        { op: 'system:baseline_check', status: 'success' },
        { op: 'system:log', status: 'success' },
      ],
    });
    expect(JSON.stringify(output[0])).not.toContain('must not be printed');
  });
});
