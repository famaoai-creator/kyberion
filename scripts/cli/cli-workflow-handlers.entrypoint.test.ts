import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  handleEmailWorkflowCommand,
  readWorkflowTextFile,
  withWorkflowOutputPrinter,
} from './cli-workflow-handlers.js';

describe('CLI workflow handler output boundary', () => {
  it('refuses an invalid reply mode even when a destination is supplied', async () => {
    await expect(
      handleEmailWorkflowCommand('deliver', [
        '--dry-run',
        '--body-markdown',
        'preview',
        '--reply-mode',
        'repy',
        '--to',
        'preview@example.invalid',
      ])
    ).rejects.toThrow('--reply-mode must be new, reply, or reply-all');
  });
  it('requires a destination for a new send preview but allows an incomplete draft', async () => {
    const input = ['--dry-run', '--body-markdown', 'preview'];
    await expect(handleEmailWorkflowCommand('deliver', input)).rejects.toThrow('--to is required');
    const output: unknown[] = [];
    await withWorkflowOutputPrinter(
      (value) => output.push(value),
      () => handleEmailWorkflowCommand('deliver', [...input, '--draft-mode'])
    );
    expect(JSON.parse(String(output[0]))).toMatchObject({ dry_run: true, draft_mode: true });
  });
  it('returns an email preview without requiring approval at the public workflow handler', async () => {
    const output: unknown[] = [];
    await withWorkflowOutputPrinter(
      (value) => output.push(value),
      () =>
        handleEmailWorkflowCommand('deliver', [
          '--dry-run',
          '--reply-mode',
          'reply',
          '--message-id',
          'fixture-message',
          '--body-markdown',
          'preview',
        ])
    );
    expect(JSON.parse(String(output[0]))).toMatchObject({
      dry_run: true,
      message_id: 'fixture-message',
      verification: { recipients: 'not_resolved' },
    });
  });
  it('routes handler output through the injected workflow printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/cli/cli-workflow-handlers.ts'), {
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
