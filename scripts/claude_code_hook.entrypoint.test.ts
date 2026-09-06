import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { readClaudeCodeHookTranscript } from './claude_code_hook.js';

describe('claude_code_hook entrypoint', () => {
  it('keeps the protocol writer and delegates exit status to natural success', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/claude_code_hook.ts'));
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('process.stdout.write(');
    expect(source).toContain("permissionDecision: 'allow'");
    expect(source).toContain('run: async ({ argv }) =>');
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
    expect(source).toContain('readClaudeCodeHookTranscript(filePath: string)');
  });

  it('rejects a directory before reading a transcript', () => {
    expect(() => readClaudeCodeHookTranscript(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });
});
