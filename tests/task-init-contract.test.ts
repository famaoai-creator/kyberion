import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync, safeMkdir, safeWriteFile } from '@agent/core';
import { main } from '../scripts/task_init.js';

const PROFILE_PATH = pathResolver.rootResolve('knowledge/personal/task-profiles/daily-email-triage.json');
const ANSWERS_FILE = pathResolver.rootResolve('active/shared/tmp/task-init-answers.json');
const OVERRIDE_SCENARIO_DIR = pathResolver.rootResolve('active/shared/tmp/task-init-scenarios');

describe('task init contract', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign_concierge';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (safeExistsSync(PROFILE_PATH)) safeRmSync(PROFILE_PATH);
    if (safeExistsSync(ANSWERS_FILE)) safeRmSync(ANSWERS_FILE);
    if (safeExistsSync(OVERRIDE_SCENARIO_DIR)) safeRmSync(OVERRIDE_SCENARIO_DIR, { recursive: true, force: true });
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
  });

  it('writes a profile from non-interactive answers and prints the next command', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    safeWriteAnswersFile({
      "重要メールとして扱う条件は何か": 'VIP and direct managers',
      "返信下書きに含めてよい情報の範囲はどこまでか": 'draft only',
      "人間承認が必要な送信条件は何か": 'any send action',
    });

    await main(['daily-email-triage', '--answers-file', ANSWERS_FILE]);

    expect(safeExistsSync(PROFILE_PATH)).toBe(true);
    const profile = JSON.parse(safeReadFile(PROFILE_PATH, { encoding: 'utf8' }) as string);
    expect(profile.scenario_id).toBe('daily-email-triage');
    expect(profile.answers["重要メールとして扱う条件は何か"]).toBe('VIP and direct managers');

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Created profile: knowledge/personal/task-profiles/daily-email-triage.json');
    expect(output).toContain('Next: pnpm task:run daily-email-triage');
  });

  it('prints an answer template without writing a profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['daily-email-triage', '--print-template']);

    expect(safeExistsSync(PROFILE_PATH)).toBe(false);
    const output = logSpy.mock.calls.flat().join('\n');
    const template = JSON.parse(output) as Record<string, string>;
    expect(template).toEqual({
      "重要メールとして扱う送信元や条件は何か": '',
      "返信下書きに含めてよいカテゴリや情報の範囲はどこまでか": '',
      "送信前に人間承認が必要になる条件は何か": '',
      "返信トーンはどの程度まで自動化してよいか": '',
    });
  });

  it('fails gracefully when the scenario id is unknown', async () => {
    await expect(main(['unknown-scenario', '--answers-json', '{}'])).rejects.toThrow('Unknown TaskScenario: unknown-scenario');
  });

  it('rejects profile outputs outside the personal knowledge tier', async () => {
    safeMkdir(OVERRIDE_SCENARIO_DIR, { recursive: true });
    const original = JSON.parse(safeReadFile(pathResolver.rootResolve('knowledge/product/task-scenarios/daily-email-triage.json'), { encoding: 'utf8' }) as string);
    original.first_run.profile_output = 'knowledge/product/task-profiles/not-allowed.json';
    safeWriteFile(pathResolver.rootResolve('active/shared/tmp/task-init-scenarios/daily-email-triage.json'), `${JSON.stringify(original, null, 2)}\n`);
    safeWriteAnswersFile({});
    const originalEnv = process.env.KYBERION_TASK_SCENARIO_DIR;
    process.env.KYBERION_TASK_SCENARIO_DIR = OVERRIDE_SCENARIO_DIR;

    try {
      await expect(main(['daily-email-triage', '--answers-file', ANSWERS_FILE])).rejects.toThrow('Profile output must stay under knowledge/personal/');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.KYBERION_TASK_SCENARIO_DIR;
      } else {
        process.env.KYBERION_TASK_SCENARIO_DIR = originalEnv;
      }
    }
  });
});

function safeWriteAnswersFile(payload: Record<string, unknown>): void {
  safeWriteFile(ANSWERS_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}
