import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile, safeWriteFile } from '@agent/core';
import { checkFirstWinSmoke, validateVerifySessionPipeline } from './check_first_win_smoke.js';

const ROOT = pathResolver.rootDir();

describe('check_first_win_smoke', () => {
  const readmePath = path.join(ROOT, 'README.md');
  let savedReadme: string | null = null;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    savedReadme = String(safeReadFile(readmePath, { encoding: 'utf8' }) || '');
  });

  afterEach(() => {
    if (savedReadme !== null) {
      safeWriteFile(readmePath, savedReadme, { encoding: 'utf8' });
    }
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('flags a missing first-win command in README', () => {
    safeWriteFile(readmePath, '# Kyberion\n', { encoding: 'utf8' });
    const violations = checkFirstWinSmoke();
    expect(violations.some((line) => line.startsWith('README.md: missing'))).toBe(true);
  });

  it('requires verify-session to be a clean local screenshot smoke', () => {
    const violations = validateVerifySessionPipeline({
      options: { headless: false, user_data_dir: 'active/browser-session/enterprise-sync' },
      inputs: { TARGET_URL: { default: 'https://example.com' } },
      steps: [
        { op: 'browser:evaluate', params: { script: 'document.title', export_as: 'session_state' } },
        { op: 'browser:screenshot', params: { path: 'active/shared/tmp/enterprise-login-success.png' } },
      ],
    });

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('headless must be true'),
      expect.stringContaining('user_data_dir must stay under active/shared/tmp/'),
      expect.stringContaining('missing browser:goto'),
      expect.stringContaining('local data URL'),
      expect.stringContaining('first-win-session.png'),
    ]));
  });
});
