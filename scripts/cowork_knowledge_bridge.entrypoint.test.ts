import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('Cowork knowledge bridge entrypoint', () => {
  it('keeps help, result, and error details behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cowork_knowledge_bridge.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(result)');
    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('process.stderr.write');
    expect(source).not.toContain('console.log(');
  });
});
