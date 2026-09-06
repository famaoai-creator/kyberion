import { describe, expect, it } from 'vitest';
import { pathResolver } from '../../../path-resolver.js';
import { safeReadFile } from '../../../secure-io.js';

describe('DOCX round-trip example entrypoint', () => {
  it('uses the shared script harness and has no direct process boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/core/src/native-docx-engine/examples/roundtrip_docx.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('import { defineScript, isDirectScript, ScriptExitError }');
    expect(source).toContain("name: 'roundtrip-docx'");
    expect(source).not.toContain('process.argv');
    expect(source).not.toContain('process.exit(');
    expect(source).not.toContain('main().catch(');
  });
});
