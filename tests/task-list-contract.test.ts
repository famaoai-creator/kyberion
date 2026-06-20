import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, pathResolver, safeExistsSync, safeRmSync } from '@agent/core';
import { listTaskScenarios, main, printTaskScenarios } from '../scripts/task_list.js';

const EMPTY_DIR = pathResolver.rootResolve('active/shared/tmp/task-scenario-empty');

describe('task list contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (safeExistsSync(EMPTY_DIR)) {
      safeRmSync(EMPTY_DIR, { recursive: true, force: true });
    }
  });

  it('lists repeatable task scenarios from the canonical directory', () => {
    const scenarios = listTaskScenarios();

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.map((scenario) => scenario.id)).toContain('daily-email-triage');
    expect(scenarios.map((scenario) => scenario.id)).toContain('meeting-to-proposal-pptx');
  });

  it('prints a concise repeatable task summary', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const scenarios = listTaskScenarios();

    printTaskScenarios(scenarios.slice(0, 1));

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Available repeatable tasks:');
    expect(output).toContain('daily-email-triage');
    expect(output).toContain('Result: email-triage.md + reply-drafts.json');
    expect(output).toContain('First run: needs 3 preferences');
    expect(output).toContain('Repeat: schedule 0 8 * * 1-5 (Asia/Tokyo)');
  });

  it('fails gracefully when no scenario files exist', async () => {
    safeMkdir(EMPTY_DIR, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalEnv = process.env.KYBERION_TASK_SCENARIO_DIR;
    process.env.KYBERION_TASK_SCENARIO_DIR = EMPTY_DIR;

    try {
      await main([]);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KYBERION_TASK_SCENARIO_DIR;
      } else {
        process.env.KYBERION_TASK_SCENARIO_DIR = originalEnv;
      }
    }

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('No TaskScenario files found');
    expect(output).toContain('knowledge/product/task-scenarios/*.json');
  });
});
