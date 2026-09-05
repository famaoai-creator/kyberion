import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { handleFeedbackSubcommand } from './operator-home-secondary-actions.js';

describe('operator home secondary actions output boundary', () => {
  it('routes feedback and deal output through an injected printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/operator-home-secondary-actions.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain("throw new ScriptExitError(1, '', true)");
  });

  it('uses the injected printer before returning a governed failure', () => {
    const output: unknown[] = [];
    expect(() =>
      handleFeedbackSubcommand(
        (key) => key,
        { intentId: '', outcome: '' },
        (value) => output.push(value)
      )
    ).toThrow();
    expect(output).toEqual(['recorder:recorder_feedback_usage']);
  });
});
