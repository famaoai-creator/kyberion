import { describe, expect, it, vi } from 'vitest';
import { formatTaskScenarios, main } from './task_list.js';

const scenario = {
  id: 'daily-report',
  title: 'Daily report',
  description: 'Prepare a daily report.',
  trigger: { type: 'manual' as const, prompt: 'Prepare the report.' },
  input: { sources: ['calendar'], required_params: [] },
  first_run: {
    reasoning_required: false,
    questions: [],
    profile_output: 'knowledge/personal/report.json',
  },
  repeat_run: { pipeline_template: 'pipelines/report.json', params_from_profile: false },
  result: { artifacts: ['report.md'], summary_format: 'markdown' as const },
  approval_boundary: { required_for: ['send'], default_action: 'requires-human-approval' as const },
};

describe('task:list output boundary', () => {
  it('renders a deterministic human report without direct console output', () => {
    expect(formatTaskScenarios([scenario])).toContain('daily-report');
  });

  it('emits a structured JSON result through the supplied printer', async () => {
    const print = vi.fn();
    await main(['--json'], print, true);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', scenarios: expect.any(Array) })
    );
  });
});
