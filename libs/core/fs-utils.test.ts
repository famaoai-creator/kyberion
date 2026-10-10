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

  it('yields nothing for a missing root', () => {
    expect(getAllFiles(`${rootDir}/missing`)).toEqual([]);
  });

  it('rethrows a refusal to list the walk root instead of returning []', () => {
    // A data-only role may not list the personal tier.
    const saved = { persona: process.env.KYBERION_PERSONA, role: process.env.MISSION_ROLE };
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'finance_controller';
    try {
      expect(() => getAllFiles(pathResolver.knowledge('personal'))).toThrow(/ROLE_VIOLATION/);
    } finally {
      if (saved.persona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = saved.persona;
      if (saved.role === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = saved.role;
    }
  });
});
