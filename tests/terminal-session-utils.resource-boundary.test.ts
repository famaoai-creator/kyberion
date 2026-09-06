import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  buildSessionPaths,
  listPersistedSessionStates,
  readPersistedSessionState,
} from '../presence/bridge/terminal/session-utils.js';

describe('terminal session persistence resource boundary', () => {
  it('does not read a symlinked session state', () => {
    const dir = pathResolver.sharedTmp(`terminal-session-boundary-${process.pid}-${Date.now()}`);
    const target = path.join(dir, 'target.json');
    const linked = path.join(dir, 'linked.json');

    withExecutionContext('mission_controller', () => {
      safeMkdir(dir, { recursive: true });
      safeWriteFile(target, JSON.stringify({ id: 's-boundary', name: 'target' }));
      safeSymlinkSync(target, linked);

      expect(readPersistedSessionState(target)).toEqual({ id: 's-boundary', name: 'target' });
      expect(readPersistedSessionState(linked)).toBeNull();
      safeRmSync(dir, { recursive: true, force: true });
    });
  });

  it('skips session directories whose state file is a symlink', () => {
    const dir = pathResolver.sharedTmp(
      `terminal-session-list-boundary-${process.pid}-${Date.now()}`
    );
    const sessionDir = path.join(dir, 's-boundary');
    const target = path.join(dir, 'target.json');

    withExecutionContext('mission_controller', () => {
      safeMkdir(sessionDir, { recursive: true });
      safeWriteFile(target, JSON.stringify({ id: 's-boundary', name: 'target' }));
      safeSymlinkSync(target, buildSessionPaths(dir, 's-boundary').state);

      expect(listPersistedSessionStates(dir)).toEqual([]);
      safeRmSync(dir, { recursive: true, force: true });
    });
  });
});
