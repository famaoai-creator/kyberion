import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { main } from './env_config_report.js';

describe('environment config report entrypoint', () => {
  it('keeps report output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/env_config_report.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
  });

  it('handles help without loading the environment registry', () => {
    expect(main(['--help'])).toEqual({
      status: 0,
      help: expect.stringContaining('config:report'),
    });
  });
});
