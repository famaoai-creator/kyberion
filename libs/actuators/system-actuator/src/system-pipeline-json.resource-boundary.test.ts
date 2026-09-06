import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

import { opCapture } from './system-pipeline-core-helpers.js';

const TEST_ROOT = pathResolver.sharedTmp(`system-pipeline-json-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('system pipeline persisted JSON boundary', () => {
  it('preserves scalar read_json values while parsing through the safe boundary', async () => {
    const inputPath = `${TEST_ROOT}/scalar.json`;
    safeWriteFile(inputPath, '42', { mkdir: true });

    const result = await opCapture(
      'read_json',
      { path: 'active/shared/tmp/system-pipeline-json-boundary-' + process.pid + '/scalar.json' },
      {},
      (value) => value
    );

    expect(result.last_capture_data).toBe(42);
  });

  it('rejects dangerous JSON before read_json returns persisted data', async () => {
    const inputPath = `${TEST_ROOT}/dangerous.json`;
    safeWriteFile(inputPath, '{"constructor":{"polluted":true}}', { mkdir: true });

    await expect(
      opCapture(
        'read_json',
        {
          path:
            'active/shared/tmp/system-pipeline-json-boundary-' + process.pid + '/dangerous.json',
        },
        {},
        (value) => value
      )
    ).rejects.toThrow('dangerous JSON key');
  });

  it('rejects a directory masquerading as read_json input', async () => {
    const inputPath = `${TEST_ROOT}/directory.json`;
    safeMkdir(inputPath, { recursive: true });

    await expect(
      opCapture(
        'read_json',
        {
          path:
            'active/shared/tmp/system-pipeline-json-boundary-' + process.pid + '/directory.json',
        },
        {},
        (value) => value
      )
    ).rejects.toThrow('existing regular file');
  });
});
