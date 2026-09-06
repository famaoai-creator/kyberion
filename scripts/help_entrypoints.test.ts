import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { readEmailWorkflowTextFile } from './email-workflow.js';

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
    expect(result.stdout).toContain('Usage: pnpm kyberion email');
    expect(result.stdout).toContain('Compat: pnpm email:workflow');
    expect(result.stdout).toContain('docs/EMAIL_OPERATOR.ja.md');
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

  it('uses the foundation text reader for email file inputs', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/email-workflow.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('readTextFile');
    expect(source).toContain('readEmailWorkflowTextFile(filePath: string)');
    expect(source).not.toContain('safeReadFile(filePath');
  });

  it('rejects a directory before reading an email workflow file', () => {
    expect(() => readEmailWorkflowTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
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
