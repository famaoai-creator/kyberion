import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { getAllFiles } from './fs-utils.js';

const rootDir = pathResolver.sharedTmp('fs-utils-symlink-test');

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
});

describe('fs-utils traversal', () => {
  it('does not return symlinks as regular files', () => {
    const target = `${rootDir}/target.json`;
    const link = `${rootDir}/link.json`;
    safeMkdir(rootDir, { recursive: true });
    safeWriteFile(target, '{}');
    safeSymlinkSync(target, link);

    expect(getAllFiles(rootDir)).toEqual([target]);
  });
});
