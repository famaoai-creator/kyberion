import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';

const FIXTURE_DIR = pathResolver.rootResolve('tests/fixtures/eslint-import-cycle');

// Run ESLint's own CLI entry under the current node binary rather than through
// a package-manager shim. `pnpm exec` prints its workspace banner ("Scope: all
// N workspace projects") on stdout, which corrupts `--format json`, and neither
// `pnpm` nor `npx` is guaranteed to be on PATH for every CI runner. Resolving
// the bin off `eslint/package.json` works from any cwd and on Windows, where
// node_modules/.bin/eslint is a shell script node cannot execute directly.
const ESLINT_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve('eslint/package.json')),
  'bin',
  'eslint.js'
);

describe('ESLint import/no-cycle resolver', () => {
  it('fires import/no-cycle for a TypeScript cycle through .js import specifiers', () => {
    const first = path.join(FIXTURE_DIR, 'first.ts');
    const second = path.join(FIXTURE_DIR, 'second.ts');

    const lint = spawnSync(
      process.execPath,
      [
        ESLINT_BIN,
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
