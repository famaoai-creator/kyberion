import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { collectComputerSessions } from './computer-sessions';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

const root = pathResolver.sharedTmp(`computer-sessions-boundary-${process.pid}`);

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('computer session resource boundary', () => {
  it('projects regular session files but ignores symlinked session metadata', () => {
    const computerDir = path.join(root, 'computer');
    const browserDir = path.join(root, 'browser');
    const external = path.join(root, 'external.json');
    safeMkdir(computerDir, { recursive: true });
    safeMkdir(browserDir, { recursive: true });
    safeWriteFile(
      path.join(computerDir, 'safe.json'),
      JSON.stringify({ id: 'safe-session', executor: 'system', status: 'ready' })
    );
    safeWriteFile(
      external,
      JSON.stringify({ id: 'external-session', executor: 'system', status: 'ready' })
    );
    safeSymlinkSync(external, path.join(browserDir, 'linked.json'));

    const sessions = collectComputerSessions({
      computerSessionDir: computerDir,
      browserSessionDir: browserDir,
    });

    expect(sessions.map((session) => session.id)).toContain('safe-session');
    expect(sessions.map((session) => session.id)).not.toContain('external-session');
  });

  it('ignores non-object session payloads', () => {
    const computerDir = path.join(root, 'computer');
    const browserDir = path.join(root, 'browser');
    safeMkdir(computerDir, { recursive: true });
    safeMkdir(browserDir, { recursive: true });
    safeWriteFile(path.join(computerDir, 'array.json'), '[]');
    safeWriteFile(path.join(browserDir, 'scalar.json'), 'null');

    expect(
      collectComputerSessions({ computerSessionDir: computerDir, browserSessionDir: browserDir })
    ).toEqual([]);
  });
});
