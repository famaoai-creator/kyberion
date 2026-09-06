import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readWorkflowTextFile } from './cli-workflow-handlers.js';

describe('CLI workflow handler output boundary', () => {
  it('routes handler output through the injected workflow printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli-workflow-handlers.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.exitCode');
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(resolveWorkflowPath');
    expect(source).toContain('activePrint: Print = () => undefined');
    expect(source).toContain('withWorkflowOutputPrinter');
  });

  it('connects the CLI harness printer to workflow handlers', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli.ts'), { encoding: 'utf8' }) || ''
    );

    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('rejects a directory replacement before workflow text parsing', () => {
    expect(() => readWorkflowTextFile(pathResolver.rootDir(), 'workflow input')).toThrow(
      'workflow input must be a regular file'
    );
  });
});
