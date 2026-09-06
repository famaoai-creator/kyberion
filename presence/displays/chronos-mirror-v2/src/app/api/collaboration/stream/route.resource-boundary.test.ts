import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core';
import { eventFiles, readEvents } from './route.js';

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

  it('keeps zero-based cursor IDs when foundation JSONL skips blank and torn rows', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const eventFile = path.join(fixtureRoot, 'worker-events-2026-09-02.jsonl');
    const first = {
      type: 'notification',
      ts: '2099-01-01T00:00:00.000Z',
      seq: 1,
      payload: { scope_kind: 'system', tier: 'public', text: 'one' },
    };
    const second = { ...first, seq: 2, payload: { ...first.payload, text: 'two' } };
    safeWriteFile(eventFile, `\n${JSON.stringify(first)}\n\nnot-json\n${JSON.stringify(second)}\n`);

    const firstId = `${eventFile}:1`;
    expect(readEvents(null, undefined, 'all', {}, ['public'], [eventFile])).toMatchObject({
      events: [
        expect.objectContaining({ id: firstId }),
        expect.objectContaining({ id: `${eventFile}:4` }),
      ],
      lastSeenId: `${eventFile}:4`,
    });
    expect(readEvents(firstId, undefined, 'all', {}, ['public'], [eventFile]).events).toEqual([
      expect.objectContaining({ id: `${eventFile}:4` }),
    ]);
  });
});
