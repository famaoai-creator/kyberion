import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveExistingPresenceFile, resolvePresencePath } from './presence-controller.js';

const fixtureDir = pathResolver.active(`shared/tmp/presence-controller-boundary-${process.pid}`);
const target = path.join(fixtureDir, 'target.jsonl');
const link = path.join(fixtureDir, 'linked.jsonl');

afterEach(() => safeRmSync(fixtureDir, { recursive: true, force: true }));

describe('presence controller resource boundary', () => {
  it('keeps presence paths inside the repository', () => {
    expect(() => resolvePresencePath('/tmp/outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('does not treat a symlink as an existing presence file', () => {
    safeMkdir(fixtureDir, { recursive: true });
    safeWriteFile(target, '{}\n');
    safeSymlinkSync(target, link);

    expect(
      resolveExistingPresenceFile(
        'active/shared/tmp/presence-controller-boundary-' + process.pid + '/target.jsonl'
      )
    ).toBe(target);
    expect(
      resolveExistingPresenceFile(
        'active/shared/tmp/presence-controller-boundary-' + process.pid + '/linked.jsonl'
      )
    ).toBeNull();
  });

  it('does not treat a directory as an existing presence file', () => {
    safeMkdir(fixtureDir, { recursive: true });
    safeMkdir(target, { recursive: true });

    expect(
      resolveExistingPresenceFile(
        'active/shared/tmp/presence-controller-boundary-' + process.pid + '/target.jsonl'
      )
    ).toBeNull();
  });
});
