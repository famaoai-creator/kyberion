import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('telegram polling entrypoint', () => {
  it('uses the shared script harness for direct startup', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('satellites/telegram-bridge/src/polling.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain(
      "import { defineScript, isDirectScript } from '@agent/core/script-harness'"
    );
    expect(source).toContain("name: 'telegram-polling'");
    expect(source).not.toContain('main().catch(');
    expect(source).not.toContain('console.error(err)');
  });
});
