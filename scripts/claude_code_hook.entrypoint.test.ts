import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { readClaudeCodeHookTranscript } from './claude_code_hook.js';

describe('claude_code_hook entrypoint', () => {
  it('keeps the protocol writer and delegates exit status to natural success', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/claude_code_hook.ts'));
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('process.stdout.write(');
    expect(source).toContain("permissionDecision: 'deny'");
    expect(source).toContain('run: async ({ argv }) =>');
    expect(source).toContain(
      "import { isRecord, readTextFile } from '@agent/core/foundation/text'"
    );
    expect(source).toContain('readClaudeCodeHookTranscript(filePath: string)');
  });

  it('keeps PreToolUse deny-only (no auto-approve output)', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/claude_code_hook.ts'));
    expect(source).toContain("permissionDecision !== 'allow'");
  });

  it('dispatches SessionEnd for co-session lease cleanup', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/claude_code_hook.ts'));
    expect(source).toContain("case 'SessionEnd'");
    expect(source).toContain('buildSessionEndContext');
  });

  it('rejects a directory before reading a transcript', () => {
    expect(() => readClaudeCodeHookTranscript(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });
});
