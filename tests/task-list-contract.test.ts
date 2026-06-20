import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { listTaskScenarios, main, printTaskScenarios } from '../scripts/task_list.js';

const EMPTY_DIR = pathResolver.rootResolve('active/shared/tmp/task-scenario-empty');
const READINESS_DIR = pathResolver.rootResolve('active/shared/tmp/task-scenario-readiness');
const READINESS_SCENARIO_ID = 'task-list-readiness';
const READINESS_PROFILE = pathResolver.rootResolve(
  'knowledge/personal/task-profiles/task-list-readiness.json',
);

describe('task list contract', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign_concierge';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (safeExistsSync(EMPTY_DIR)) {
      safeRmSync(EMPTY_DIR, { recursive: true, force: true });
    }
    if (safeExistsSync(READINESS_DIR)) {
      safeRmSync(READINESS_DIR, { recursive: true, force: true });
    }
    if (safeExistsSync(READINESS_PROFILE)) {
      safeRmSync(READINESS_PROFILE);
    }
    if (process.env.KYBERION_TASK_SCENARIO_DIR === READINESS_DIR) {
      delete process.env.KYBERION_TASK_SCENARIO_DIR;
    }
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
  });

  it('lists repeatable task scenarios from the canonical directory', () => {
    const scenarios = listTaskScenarios();

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios.map((scenario) => scenario.id)).toContain('daily-email-triage');
    expect(scenarios.map((scenario) => scenario.id)).toContain('meeting-to-proposal-pptx');
    expect(scenarios.map((scenario) => scenario.id)).toContain('weekly-executive-digest');
  });

  it('prints setup-needed status and the init command when the profile is missing', () => {
    writeReadinessScenario(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printTaskScenarios(listTaskScenarios(READINESS_DIR));

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Available repeatable tasks:');
    expect(output).toContain(READINESS_SCENARIO_ID);
    expect(output).toContain('Status: setup needed');
    expect(output).toContain(`Next: pnpm task:init ${READINESS_SCENARIO_ID}`);
  });

  it('prints ready-for-dry-run status and the run command when the profile exists', () => {
    writeReadinessScenario(true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printTaskScenarios(listTaskScenarios(READINESS_DIR));

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain(READINESS_SCENARIO_ID);
    expect(output).toContain('Status: ready for dry-run');
    expect(output).toContain(`Next: pnpm task:run ${READINESS_SCENARIO_ID} --dry-run`);
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

function writeReadinessScenario(includeProfile: boolean): void {
  safeMkdir(READINESS_DIR, { recursive: true });
  safeWriteFile(
    pathResolver.rootResolve(`active/shared/tmp/task-scenario-readiness/${READINESS_SCENARIO_ID}.json`),
    `${JSON.stringify(
      {
        id: READINESS_SCENARIO_ID,
        title: 'Task list readiness check',
        description: 'task:list readiness output contract fixture.',
        trigger: {
          type: 'manual',
          prompt: 'ready check',
        },
        input: {
          sources: ['fixture'],
          required_params: ['check_id'],
        },
        first_run: {
          reasoning_required: true,
          questions: ['What should the readiness contract validate?'],
          profile_output: 'knowledge/personal/task-profiles/task-list-readiness.json',
        },
        repeat_run: {
          pipeline_template: 'knowledge/product/pipeline-templates/email-triage-workflow.json',
          params_from_profile: true,
          profile_input: 'knowledge/personal/task-profiles/task-list-readiness.json',
        },
        result: {
          artifacts: ['task-list-readiness.md'],
          summary_format: 'markdown',
        },
        approval_boundary: {
          required_for: ['send_email'],
          default_action: 'draft-only',
        },
      },
      null,
      2,
    )}\n`,
  );

  if (includeProfile) {
    safeMkdir(pathResolver.rootResolve('knowledge/personal/task-profiles'), { recursive: true });
    safeWriteFile(
      READINESS_PROFILE,
      `${JSON.stringify({ readiness: true, scenario_id: READINESS_SCENARIO_ID }, null, 2)}\n`,
    );
  }

  process.env.KYBERION_TASK_SCENARIO_DIR = READINESS_DIR;
}
