import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  listBrowserRuntimeSessions,
  loadBrowserSnapshotSummary,
  resolveSafeExistingFile,
} from './presence-studio-runtime-data.js';

const fixtureRoot = pathResolver.sharedTmp('presence-studio-runtime-data-boundary-test');
const sessionDir = path.join(fixtureRoot, 'sessions');
const snapshotDir = path.join(fixtureRoot, 'snapshots');
const previousSudo = process.env.KYBERION_SUDO;

afterEach(() => {
  if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
  else process.env.KYBERION_SUDO = previousSudo;
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('presence studio browser runtime resource boundaries', () => {
  it('excludes symlink session and snapshot metadata from operator projections', () => {
    process.env.KYBERION_SUDO = 'true';
    safeMkdir(sessionDir, { recursive: true });
    safeMkdir(snapshotDir, { recursive: true });
    const safeSession = path.join(sessionDir, 'safe.json');
    const safeSnapshot = path.join(snapshotDir, 'safe.json');
    const linkedSession = path.join(sessionDir, 'linked.json');
    const linkedSnapshot = path.join(snapshotDir, 'linked.json');
    const targetSession = path.join(fixtureRoot, 'target-session.json');
    const targetSnapshot = path.join(fixtureRoot, 'target-snapshot.json');
    safeWriteFile(
      safeSession,
      JSON.stringify({ session_id: 'safe', updated_at: '2026-09-01T00:00:00.000Z' })
    );
    safeWriteFile(safeSnapshot, JSON.stringify({ session_id: 'safe', title: 'safe snapshot' }));
    safeWriteFile(targetSession, JSON.stringify({ session_id: 'linked', title: 'linked session' }));
    safeWriteFile(
      targetSnapshot,
      JSON.stringify({ session_id: 'linked', title: 'linked snapshot' })
    );
    safeSymlinkSync(targetSession, linkedSession);
    safeSymlinkSync(targetSnapshot, linkedSnapshot);

    expect(listBrowserRuntimeSessions({ browserSessionDir: sessionDir })).toEqual([
      expect.objectContaining({ session_id: 'safe' }),
    ]);
    expect(loadBrowserSnapshotSummary('safe', { browserSnapshotDir: snapshotDir })).toEqual(
      expect.objectContaining({ title: 'safe snapshot' })
    );
    expect(loadBrowserSnapshotSummary('linked', { browserSnapshotDir: snapshotDir })).toBeNull();
    expect(
      loadBrowserSnapshotSummary('../target-snapshot', { browserSnapshotDir: snapshotDir })
    ).toBeNull();
    expect(resolveSafeExistingFile(linkedSession)).toBeNull();
  });
});
