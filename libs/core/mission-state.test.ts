import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import {
  loadState,
  loadStateAtPath,
  readFocusedMissionId,
  readJsonFileSafe,
  writeFocusedMissionId,
} from './mission-state.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';

const rootDir = pathResolver.sharedTmp('mission-state-loader-test');
const missionId = 'MSN-STATE-LOADER-001';
const missionDir = `${rootDir}/active/missions/public/${missionId}`;

function writeState(value: unknown): void {
  safeMkdir(missionDir, { recursive: true });
  safeWriteFile(`${missionDir}/mission-state.json`, JSON.stringify(value));
}

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
});

describe('mission-state loader', () => {
  it('returns a schema-valid mission state', () => {
    writeState({
      mission_id: missionId,
      tier: 'public',
      status: 'active',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      git: {
        branch: 'mission/state-loader-test',
        start_commit: 'abc123',
        latest_commit: 'abc123',
        checkpoints: [],
      },
      history: [],
    });

    expect(loadState(missionId, { rootDir })).toMatchObject({
      mission_id: missionId,
      status: 'active',
    });
    expect(loadStateAtPath(`${missionDir}/mission-state.json`)).toMatchObject({
      mission_id: missionId,
      status: 'active',
    });
  });

  it('does not expose a schema-invalid state to mission callers', () => {
    writeState({ mission_id: missionId, status: 'active' });

    expect(loadState(missionId, { rootDir })).toBeNull();
    expect(loadStateAtPath(`${missionDir}/mission-state.json`)).toBeNull();
  });

  it('rejects symlinked focus and JSON paths', () => {
    const target = `${rootDir}/focus.json`;
    const link = `${rootDir}/focus-link.json`;
    safeWriteFile(target, JSON.stringify({ mission_id: missionId }));
    safeSymlinkSync(target, link);

    expect(readFocusedMissionId(link)).toBeNull();
    expect(readJsonFileSafe(link)).toBeNull();
    expect(() => writeFocusedMissionId(link, missionId)).toThrow(/symbolic link/);
  });

  it('round-trips the focused mission pointer through its governed catalog', () => {
    const target = `${rootDir}/focus.json`;

    writeFocusedMissionId(target, missionId.toLowerCase());

    expect(readFocusedMissionId(target)).toBe(missionId);
  });

  it('rejects unknown fields in the focused mission pointer', () => {
    const target = `${rootDir}/focus.json`;
    safeWriteFile(target, JSON.stringify({ mission_id: missionId, ts: 'now', unexpected: true }));

    expect(readFocusedMissionId(target)).toBeNull();
  });
});
