import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('knowledge scope health entrypoint', () => {
  it('keeps health and alert output behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/watch_knowledge_scope_health.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(json ? output :');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.warn(');
  });

  it('contains a side-effect-free help path', () => {
    expect(
      safeReadFile(pathResolver.rootResolve('scripts/watch_knowledge_scope_health.ts'), {
        encoding: 'utf8',
      })
    ).toContain('KNOWLEDGE_SCOPE_HEALTH_USAGE');
  });
});
