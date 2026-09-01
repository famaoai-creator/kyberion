import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('ReflexTerminal check entrypoint', () => {
  it('is import-safe and routes output through the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_rt_mode.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('run: (context) => checkRTMode(context.print)');
    expect(source).toContain("isDirectScript(import.meta.url, 'check_rt_mode.ts')");
    expect(source).not.toContain('catch(console.error)');
  });
});
