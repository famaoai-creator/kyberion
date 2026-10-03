import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveMissionDir = vi.hoisted(() => vi.fn());

vi.mock('../owner-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../owner-scope.js')>()),
  resolveMissionDir,
}));

import { missionTaskEventsPath } from './mission-task-events.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '../secure-io.js';

const rootDir = pathResolver.sharedTmp('mission-task-events-path-test');
const targetDir = `${rootDir}/target-mission`;
const linkDir = `${rootDir}/mission-link`;

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
  resolveMissionDir.mockReset();
});

describe('mission task event path boundary', () => {
  it('rejects a symlinked mission directory before resolving event paths', () => {
    safeMkdir(targetDir, { recursive: true });
    safeWriteFile(`${targetDir}/marker`, 'target');
    safeSymlinkSync(targetDir, linkDir, 'dir');
    resolveMissionDir.mockReturnValue(linkDir);

    expect(() => missionTaskEventsPath('MSN-TASK-SYMLINK')).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
