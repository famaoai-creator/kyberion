import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core';
import { eventFiles } from './route.js';

const fixtureRoot = pathResolver.sharedTmp(`collaboration-stream-boundary-${process.pid}`);

afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

describe('collaboration stream resource boundary', () => {
  it('does not enumerate symlinked event files or mission partitions', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const target = path.join(fixtureRoot, 'target.jsonl');
    const linkedFile = path.join(fixtureRoot, 'worker-events-2026-09-01.jsonl');
    const missionTarget = path.join(fixtureRoot, 'mission-target');
    const linkedMission = path.join(fixtureRoot, 'mission-linked');
    safeWriteFile(target, '{}\n');
    safeSymlinkSync(target, linkedFile);
    safeMkdir(missionTarget, { recursive: true });
    safeWriteFile(path.join(missionTarget, 'worker-events-2026-09-01.jsonl'), '{}\n');
    safeSymlinkSync(missionTarget, linkedMission);

    const files = eventFiles(fixtureRoot);
    expect(files).toEqual([path.join(missionTarget, 'worker-events-2026-09-01.jsonl')]);
    expect(files).not.toContain(linkedFile);
    expect(files.some((file) => file.startsWith(`${linkedMission}/`))).toBe(false);
  });

  it('fails closed for a repository-external event root', () => {
    expect(eventFiles('/tmp/collaboration-stream-events')).toEqual([]);
  });
});
