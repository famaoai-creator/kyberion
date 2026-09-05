import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { executePipeline } from './system-pipeline-helpers.js';

const TEST_ROOT = pathResolver.sharedTmp(`system-context-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('system actuator persisted context boundary', () => {
  it('rejects dangerous JSON before merging persisted context', async () => {
    const contextPath = `${TEST_ROOT}/dangerous.json`;
    safeWriteFile(contextPath, '{"constructor":{"polluted":true}}', { mkdir: true });

    await expect(executePipeline([], { context_path: contextPath })).rejects.toThrow(
      'dangerous JSON key'
    );
  });

  it('rejects a directory masquerading as persisted context', async () => {
    const contextPath = `${TEST_ROOT}/directory.json`;
    safeMkdir(contextPath, { recursive: true });

    await expect(executePipeline([], { context_path: contextPath })).rejects.toThrow(
      'existing regular file'
    );
  });
});
