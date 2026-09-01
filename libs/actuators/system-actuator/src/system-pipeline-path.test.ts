import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

import { opCapture } from './system-pipeline-core-helpers.js';

const rootDir = pathResolver.sharedTmp('system-pipeline-path-test');

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
});

describe('system pipeline path boundaries', () => {
  it('does not return symlinked files from scan_directory', async () => {
    const target = `${rootDir}/target.txt`;
    const link = `${rootDir}/link.txt`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(target, 'target');
    safeSymlinkSync(target, link);

    const result = await opCapture(
      'scan_directory',
      { path: 'active/shared/tmp/system-pipeline-path-test', recursive: true },
      {},
      (value) => value
    );

    expect(result.scan_result.files).toEqual([
      expect.objectContaining({ path: 'active/shared/tmp/system-pipeline-path-test/target.txt' }),
    ]);
  });
});
