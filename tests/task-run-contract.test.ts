import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { describeTaskRun, main } from '../scripts/task_run.js';

const PROFILE_PATH = pathResolver.rootResolve(
  'knowledge/personal/task-profiles/task-run-profile.json'
);
const OUTSIDE_PERSONAL_PROFILE = pathResolver.rootResolve(
  'active/shared/tmp/task-run-profile.json'
);
const OVERRIDE_SCENARIO_DIR = pathResolver.rootResolve('active/shared/tmp/task-run-scenarios');

describe('task run contract', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign_concierge';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (safeExistsSync(PROFILE_PATH)) safeRmSync(PROFILE_PATH);
    if (safeExistsSync(OUTSIDE_PERSONAL_PROFILE)) safeRmSync(OUTSIDE_PERSONAL_PROFILE);
    if (safeExistsSync(OVERRIDE_SCENARIO_DIR))
      safeRmSync(OVERRIDE_SCENARIO_DIR, { recursive: true, force: true });
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
  });

  it('prints a dry-run execution plan for a configured scenario', async () => {
    safeWriteFile(
      PROFILE_PATH,
      `${JSON.stringify({ mailbox: 'inbox', reply_policy: 'draft only' }, null, 2)}\n`
    );
    // main() now routes output through an explicit print sink (SX-05
    // governed-printer pass) rather than calling console.log itself.
    const captured: unknown[] = [];

    await main(['daily-email-triage', '--profile', PROFILE_PATH, '--dry-run'], (value) =>
      captured.push(value)
    );

    const output = captured.map((value) => String(value)).join('\n');
    expect(output).toContain('TaskScenario: daily-email-triage');
    expect(output).toContain('Status: dry-run only; no external side effects');
    expect(output).toContain(
      'Pipeline template: knowledge/product/pipeline-templates/email-triage-workflow.json'
    );
    expect(output).toContain('Inputs:');
    expect(output).toContain('- Sources: gmail');
    expect(output).toContain(`- Profile: ${PROFILE_PATH}`);
    expect(output).toContain('Profile loaded: yes');
    expect(output).toContain('Expected result:');
    expect(output).toContain('- email-triage.md');
    expect(output).toContain('Likely path: active/shared/tmp/email-triage.md');
    expect(output).toContain('Likely path: active/shared/tmp/reply-drafts.json');
    expect(output).toContain('Approval required before:');
    expect(output).toContain('Next actions:');
    expect(output).toContain('- 1. Review the plan and expected artifacts.');
  });

  it('preserves already-qualified artifact paths as-is', () => {
    safeMkdir(OVERRIDE_SCENARIO_DIR, { recursive: true });
    safeWriteFile(
      pathResolver.rootResolve('active/shared/tmp/task-run-scenarios/qualified-artifacts.json'),
      `${JSON.stringify(
        {
          id: 'qualified-artifacts',
          title: 'Qualified artifact test',
          description: 'Checks that active/... artifact paths stay intact.',
          trigger: { type: 'manual', prompt: 'test' },
          input: { sources: ['gmail'], required_params: [], optional_params: [] },
          first_run: {
            reasoning_required: false,
            questions: ['n/a'],
            profile_output: 'knowledge/personal/task-profiles/task-run-profile.json',
          },
          repeat_run: {
            pipeline_template: 'knowledge/product/pipeline-templates/email-triage-workflow.json',
            params_from_profile: false,
          },
          result: {
            artifacts: ['active/shared/tmp/already-qualified.json'],
            summary_format: 'json',
          },
          approval_boundary: { required_for: [], default_action: 'notify-only' },
        },
        null,
        2
      )}\n`
    );
    const originalEnv = process.env.KYBERION_TASK_SCENARIO_DIR;
    process.env.KYBERION_TASK_SCENARIO_DIR = OVERRIDE_SCENARIO_DIR;

    try {
      const plan = describeTaskRun('qualified-artifacts');

      expect(plan).toContain('Likely path: active/shared/tmp/already-qualified.json');
    } finally {
      if (originalEnv === undefined) delete process.env.KYBERION_TASK_SCENARIO_DIR;
      else process.env.KYBERION_TASK_SCENARIO_DIR = originalEnv;
    }
  });

  it('fails gracefully when the scenario id is unknown', async () => {
    await expect(main(['unknown-scenario', '--dry-run'])).rejects.toThrow(
      'Unknown TaskScenario: unknown-scenario'
    );
  });

  it('requires a profile when the scenario is profile-backed', async () => {
    const captured: unknown[] = [];

    await expect(
      main(['daily-email-triage', '--profile', PROFILE_PATH, '--dry-run'], (value) =>
        captured.push(value)
      )
    ).rejects.toThrow(
      'Missing profile for daily-email-triage. Run pnpm task:init daily-email-triage first.'
    );

    const output = captured.map((value) => String(value)).join('\n');
    expect(output).toContain('Next actions:');
    expect(output).toContain('Run pnpm task:init daily-email-triage to create the profile.');
  });

  it('rejects profile paths outside the workspace', async () => {
    // secure-io's repository-root boundary (assertSafeRepositoryPath) now
    // fails closed on an escaping path before task_run's own
    // workspace-relative check ever runs, so the observable error is the
    // RESOURCE_PATH_SCOPE contract's message, not the domain-specific one.
    await expect(
      main(['daily-email-triage', '--profile', '../escape.json', '--dry-run'])
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE] resource path is outside the repository root:');
  });

  it('rejects profile overrides outside the personal task-profile directory', async () => {
    safeWriteFile(OUTSIDE_PERSONAL_PROFILE, `${JSON.stringify({ mailbox: 'inbox' }, null, 2)}\n`);

    await expect(
      main(['daily-email-triage', '--profile', OUTSIDE_PERSONAL_PROFILE, '--dry-run'])
    ).rejects.toThrow('Profile path must stay within knowledge/personal/task-profiles/:');
  });

  it('can describe a task run directly for callers that want the rendered plan', () => {
    safeMkdir(pathResolver.rootResolve('active/shared/tmp'), { recursive: true });
    safeWriteFile(PROFILE_PATH, `${JSON.stringify({ mailbox: 'inbox' }, null, 2)}\n`);
    const plan = describeTaskRun('daily-email-triage', PROFILE_PATH);
    expect(plan).toContain('TaskScenario: daily-email-triage');
    expect(plan).toContain('Status: dry-run only; no external side effects');
    expect(plan).toContain('Inputs:');
    expect(plan).toContain('Next actions:');
  });
});
