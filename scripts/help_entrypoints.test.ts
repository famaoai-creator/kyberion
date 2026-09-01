import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';

function runHelp(
  script: string,
  args: string[] = []
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: pathResolver.rootDir(),
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('CLI help entrypoints', () => {
  it('prints usage for check_pr_title help', () => {
    const result = runHelp(path.join('scripts', 'check_pr_title.ts'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm check:pr-title');
  });

  it('prints usage for task_init help', () => {
    const result = runHelp(path.join('scripts', 'task_init.ts'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm task:init');
  });

  it('prints usage for email workflow help', () => {
    const result = runHelp(path.join('scripts', 'email-workflow.ts'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: npm run email:workflow');
  });

  it('honors shared output flags for email workflow results', () => {
    const json = runHelp(path.join('scripts', 'email-workflow.ts'), ['--', 'status', '--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toHaveProperty('accounts');

    const quiet = runHelp(path.join('scripts', 'email-workflow.ts'), [
      '--',
      'status',
      '--json',
      '--quiet',
    ]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe('');
  });

  it('honors shared output flags for calendar workflow results', () => {
    const json = runHelp(path.join('scripts', 'calendar-workflow.ts'), ['--', 'status', '--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toHaveProperty('checked_at');

    const quiet = runHelp(path.join('scripts', 'calendar-workflow.ts'), [
      '--',
      'status',
      '--json',
      '--quiet',
    ]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe('');
  });

  it('rejects an unsupported calendar provider before contacting a backend', () => {
    const result = runHelp(path.join('scripts', 'calendar-workflow.ts'), [
      '--',
      'status',
      '--provider',
      'unknown',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported calendar provider: unknown');
  });

  it('prints usage for license audit help', () => {
    const result = runHelp(path.join('scripts', 'license_audit.ts'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm license:audit');
  });
});
