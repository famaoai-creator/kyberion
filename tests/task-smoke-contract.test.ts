import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';
import { main } from '../scripts/task_smoke.js';

const PROFILE_PATH = pathResolver.rootResolve('knowledge/personal/task-profiles/daily-email-triage.json');

describe('task smoke contract', () => {
  const originalPersona = process.env.KYBERION_PERSONA;
  const originalRole = process.env.MISSION_ROLE;

  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign_concierge';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (safeExistsSync(PROFILE_PATH)) {
      safeRmSync(PROFILE_PATH);
    }
    if (originalPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = originalPersona;
    if (originalRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = originalRole;
  });

  it('runs the daily email triage smoke flow and writes the profile', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['daily-email-triage']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('TaskScenario smoke: daily-email-triage');
    expect(output).toContain('Phase 1: list');
    expect(output).toContain('Phase 2: init');
    expect(output).toContain('Phase 3: run');
    expect(output).toContain('dry-run only');
    expect(output).toContain('TaskScenario smoke passed: daily-email-triage');
    expect(safeExistsSync(PROFILE_PATH)).toBe(true);

    const profile = JSON.parse(safeReadFile(PROFILE_PATH, { encoding: 'utf8' }) as string) as {
      scenario_id?: string;
      answers?: Record<string, string>;
    };
    expect(profile.scenario_id).toBe('daily-email-triage');
    expect(profile.answers?.['重要メールとして扱う送信元や条件は何か']).toBe('顧客、役員、採用候補者からのメール');
  });

  it('fails on unknown scenarios', async () => {
    await expect(main(['unknown-scenario'])).rejects.toThrow('Unknown TaskScenario: unknown-scenario');
  });
});
