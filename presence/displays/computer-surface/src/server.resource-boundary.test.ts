import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core';
import { resolveExistingIdentityFile } from '../server.js';

const fixtureDir = pathResolver.sharedTmp(`computer-surface-resource-boundary-${process.pid}`);

afterEach(() => safeRmSync(fixtureDir, { recursive: true, force: true }));

describe('computer surface identity resource boundary', () => {
  it('rejects repository-external identity resources', () => {
    expect(resolveExistingIdentityFile('/tmp/computer-surface-identity.json')).toBeNull();
  });

  it('rejects identity resources reached through a symlink', () => {
    safeMkdir(fixtureDir, { recursive: true });
    const target = path.join(fixtureDir, 'target.json');
    const linked = path.join(fixtureDir, 'linked.json');
    safeWriteFile(target, JSON.stringify({ agent_id: 'linked' }));
    safeSymlinkSync(target, linked);

    expect(resolveExistingIdentityFile(linked)).toBeNull();
    expect(resolveExistingIdentityFile(target)).toBe(target);
  });
});
