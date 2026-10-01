import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { aceCore } from './ace-core.js';
import {
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';

describe('ace-core minutes boundary', () => {
  const root = pathResolver.sharedTmp('ace-core-test');
  const minutesPath = pathResolver.sharedTmp('ace-core-test/minutes.md');
  const externalPath = pathResolver.sharedTmp('ace-core-external.md');
  const symlinkPath = pathResolver.sharedTmp('ace-core-test/minutes-link.md');

  beforeEach(() => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    safeRmSync(root, { recursive: true, force: true });
    safeRmSync(externalPath, { recursive: true, force: true });
  });

  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    safeRmSync(externalPath, { recursive: true, force: true });
  });

  it('appends and validates minutes through a repository-local regular file', () => {
    safeMkdir(root, { recursive: true });
    const hash = aceCore.appendThought(minutesPath, 'quality-engineer', 'Review the gate.');
    aceCore.appendThought(minutesPath, 'security-engineer', 'Keep the chain intact.');

    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(aceCore.validateIntegrity(minutesPath)).toBe(true);
  });

  it('rejects a symlinked minutes path before read or append', () => {
    safeWriteFile(externalPath, 'outside minutes\n');
    safeSymlinkSync(externalPath, symlinkPath, 'file');

    expect(() => aceCore.validateIntegrity(symlinkPath)).toThrow(/RESOURCE_PATH_SYMLINK/);
    expect(() => aceCore.appendThought(symlinkPath, 'quality-engineer', 'Do not append.')).toThrow(
      /RESOURCE_PATH_SYMLINK/
    );
    expect(safeExistsSync(externalPath)).toBe(true);
  });
});
