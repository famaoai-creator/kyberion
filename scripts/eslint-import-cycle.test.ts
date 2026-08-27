import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core';

const FIXTURE_DIR = pathResolver.rootResolve('tests/fixtures/eslint-import-cycle');

describe('ESLint import/no-cycle resolver', () => {
  it('fires import/no-cycle for a TypeScript cycle through .js import specifiers', () => {
    const first = path.join(FIXTURE_DIR, 'first.ts');
    const second = path.join(FIXTURE_DIR, 'second.ts');

    const lint = spawnSync(
      'pnpm',
      [
        'exec',
        'eslint',
        first,
        second,
        '--no-ignore',
        '--format',
        'json',
        '--rule',
        'import/no-cycle:error',
      ],
      { cwd: pathResolver.rootDir(), encoding: 'utf8' }
    );
    expect(lint.status).toBe(1);
    const reports = JSON.parse(lint.stdout) as Array<{
      messages: Array<{ ruleId: string | null }>;
    }>;
    expect(
      reports.flatMap((report) =>
        report.messages.filter((message) => message.ruleId === 'import/no-cycle')
      )
    ).not.toHaveLength(0);
  });
});
