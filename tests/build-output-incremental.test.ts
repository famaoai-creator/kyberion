import { expect, it } from 'vitest';
import { safeExecResult } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

it('matches clean/ordered/incremental emits and detects add/delete/rename transitions using the real compiler', () => {
  const result = safeExecResult(
    process.execPath,
    [
      '--import',
      pathResolver.rootResolve('scripts/ts-loader.mjs'),
      pathResolver.rootResolve('tests/fixtures/build-output-incremental.mjs'),
    ],
    { cwd: pathResolver.rootDir(), timeoutMs: 90000, maxOutputMB: 1 }
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('clean-after-delete');
  expect(result.stdout).toContain('"equalToInitial": true');
  expect(result.stdout).toContain('"sourceShadows": 0');
}, 100000);
