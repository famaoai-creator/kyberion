import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { handleEmailWorkflowCommand, handleTaskCommand } from './cli-workflow-handlers.js';

const outsideRepository = path.join(pathResolver.rootDir(), '..', 'kyberion-workflow-output');

describe('CLI workflow path boundaries', () => {
  it('rejects task plan output outside the repository', async () => {
    await expect(
      handleTaskCommand('plan', [
        '--request',
        'prepare a weekly report',
        '--output',
        outsideRepository,
      ])
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects email triage input outside the repository', async () => {
    await expect(
      handleEmailWorkflowCommand('draft', ['--triage-file', outsideRepository])
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });
});
