import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

const asynchronousEntrypoints = [
  'scripts/minutes_record.ts',
  'scripts/meeting_participate.ts',
  'scripts/delegated_task_worker.ts',
  'scripts/agent_runtime_supervisor_daemon.ts',
  'scripts/browser_bridge_host.ts',
];

describe('asynchronous process exit boundary', () => {
  it.each(asynchronousEntrypoints)('routes %s exit status through the harness', (filePath) => {
    const source = String(
      safeReadFile(pathResolver.rootResolve(filePath), { encoding: 'utf8' }) || ''
    );

    expect(source).not.toContain('process.exitCode');
    expect(source).toContain('setProcessExitCode');
  });
});
