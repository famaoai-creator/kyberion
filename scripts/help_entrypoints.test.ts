import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core';

function runHelp(script: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
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

  it('prints usage for license audit help', () => {
    const result = runHelp(path.join('scripts', 'license_audit.ts'), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: pnpm license:audit');
  });
});
