import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { entropyGate } from './entropy-gate.js';
import { safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';

describe('entropy-gate cache boundary', () => {
  const cacheDir = pathResolver.shared('entropy-cache');
  const externalPath = pathResolver.sharedTmp('entropy-gate-external.hash');
  const linkedHashPath = pathResolver.shared('entropy-cache/linked.hash');
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeEach(() => {
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    safeRmSync(cacheDir, { recursive: true, force: true });
    safeRmSync(externalPath, { recursive: true, force: true });
  });

  afterEach(() => {
    safeRmSync(cacheDir, { recursive: true, force: true });
    safeRmSync(externalPath, { recursive: true, force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('opens on a change and closes when the governed hash is unchanged', () => {
    expect(entropyGate.shouldWake('stable-key', 'payload')).toBe(true);
    expect(entropyGate.shouldWake('stable-key', 'payload')).toBe(false);
    expect(entropyGate.shouldWake('stable-key', 'changed')).toBe(true);
  });

  it('rejects a hash leaf replaced by a symlink', () => {
    expect(() => entropyGate.shouldWake('../escape', 'payload')).toThrow(/single path segment/);
    entropyGate.shouldWake('linked', 'payload');
    safeWriteFile(externalPath, 'd41d8cd98f00b204e9800998ecf8427e');
    safeRmSync(linkedHashPath, { recursive: true, force: true });
    safeSymlinkSync(externalPath, linkedHashPath, 'file');

    expect(() => entropyGate.shouldWake('linked', 'payload')).toThrow(/RESOURCE_PATH_SYMLINK/);
    expect(() => entropyGate.reset('linked')).toThrow(/RESOURCE_PATH_SYMLINK/);
  });
});
