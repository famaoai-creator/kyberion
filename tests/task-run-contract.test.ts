import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { describeTaskRun, main } from '../scripts/task_run.js';

const PROFILE_PATH = pathResolver.rootResolve('knowledge/personal/task-profiles/task-run-profile.json');
const OUTSIDE_PERSONAL_PROFILE = pathResolver.rootResolve('active/shared/tmp/task-run-profile.json');

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
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
  });

  it('prints a dry-run execution plan for a configured scenario', async () => {
    safeWriteFile(PROFILE_PATH, `${JSON.stringify({ mailbox: 'inbox', reply_policy: 'draft only' }, null, 2)}\n`);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['daily-email-triage', '--profile', PROFILE_PATH, '--dry-run']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('TaskScenario: daily-email-triage');
    expect(output).toContain('Pipeline template: knowledge/product/pipeline-templates/email-triage-workflow.json');
    expect(output).toContain(`Profile: ${PROFILE_PATH}`);
    expect(output).toContain('Profile loaded: yes');
    expect(output).toContain('Expected artifacts:');
    expect(output).toContain('- email-triage.md');
    expect(output).toContain('Approval boundary: draft-only (required for: send_email)');
    expect(output).toContain('Execution: dry-run only (no side effects)');
  });

  it('fails gracefully when the scenario id is unknown', async () => {
    await expect(main(['unknown-scenario', '--dry-run'])).rejects.toThrow('Unknown TaskScenario: unknown-scenario');
  });

  it('requires a profile when the scenario is profile-backed', async () => {
    await expect(main(['daily-email-triage', '--profile', PROFILE_PATH, '--dry-run'])).rejects.toThrow(
      'Missing profile for daily-email-triage. Run pnpm task:init daily-email-triage first.'
    );
  });

  it('rejects profile paths outside the workspace', async () => {
    await expect(main(['daily-email-triage', '--profile', '../escape.json', '--dry-run'])).rejects.toThrow(
      'Profile path must stay within the workspace: ../escape.json'
    );
  });

  it('rejects profile overrides outside the personal task-profile directory', async () => {
    safeWriteFile(OUTSIDE_PERSONAL_PROFILE, `${JSON.stringify({ mailbox: 'inbox' }, null, 2)}\n`);

    await expect(main(['daily-email-triage', '--profile', OUTSIDE_PERSONAL_PROFILE, '--dry-run'])).rejects.toThrow(
      'Profile path must stay within knowledge/personal/task-profiles/:'
    );
  });

  it('can describe a task run directly for callers that want the rendered plan', () => {
    safeMkdir(pathResolver.rootResolve('active/shared/tmp'), { recursive: true });
    safeWriteFile(PROFILE_PATH, `${JSON.stringify({ mailbox: 'inbox' }, null, 2)}\n`);
    const plan = describeTaskRun('daily-email-triage', PROFILE_PATH);
    expect(plan).toContain('TaskScenario: daily-email-triage');
    expect(plan).toContain('Profile loaded: yes');
  });
});
