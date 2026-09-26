import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoFrame } from '@agent/core/meeting-session-types';

const mocks = vi.hoisted(() => ({
  redactScreenVideoFrame: vi.fn(async (frame: VideoFrame, _options?: { work_dir?: string }) => ({
    ...frame,
    payload: new Uint8Array([1]),
  })),
}));

vi.mock('@agent/core/screen-frame-redaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/screen-frame-redaction')>()),
  redactScreenVideoFrame: mocks.redactScreenVideoFrame,
}));

const { screenRedactionWorkDir, writeRedactedScreenFrames } =
  await import('./system-pipeline-core-helpers.js');

type Bridge = Parameters<typeof writeRedactedScreenFrames>[0];
type Bus = Parameters<typeof writeRedactedScreenFrames>[1];

const FRAME: VideoFrame = {
  format: { mime_type: 'image/png' },
  payload: new Uint8Array([9, 9]),
  ts_ms: 0,
};

function fakes() {
  const received: VideoFrame[] = [];
  const bridge = {
    pipeTo: async (bus: { writeFrames: (s: AsyncIterable<VideoFrame>) => Promise<void> }) =>
      bus.writeFrames(
        (async function* () {
          yield FRAME;
        })()
      ),
  } as unknown as Bridge;
  const bus = {
    writeFrames: async (stream: AsyncIterable<VideoFrame>) => {
      for await (const frame of stream) received.push(frame);
    },
  } as unknown as Bus;
  return { bridge, bus, received };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('screen frame redaction scope', () => {
  it('uses a mission-local scratch dir for an existing mission', () => {
    const missionPath = path.join('/repo', 'active/missions/confidential/MSN-SCREEN-1');
    expect(screenRedactionWorkDir('MSN-SCREEN-1', () => missionPath)).toBe(
      path.join(missionPath, 'tmp', 'screen-redaction')
    );
  });

  it('falls back to the shared default without a valid, existing mission', () => {
    const find = vi.fn(() => null);
    expect(screenRedactionWorkDir(undefined, find)).toBeUndefined();
    expect(screenRedactionWorkDir('', find)).toBeUndefined();
    expect(screenRedactionWorkDir('..', find)).toBeUndefined();
    expect(screenRedactionWorkDir('MSN-UNKNOWN-1', find)).toBeUndefined();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('passes the mission work dir to the frame redactor', async () => {
    const { bridge, bus, received } = fakes();
    await writeRedactedScreenFrames(bridge, bus, {}, '/repo/mission/tmp/screen-redaction');
    expect(mocks.redactScreenVideoFrame).toHaveBeenCalledWith(FRAME, {
      work_dir: '/repo/mission/tmp/screen-redaction',
    });
    expect(received).toHaveLength(1);
  });

  it('resolves the mission from MISSION_ID by default', async () => {
    vi.stubEnv('MISSION_ID', '');
    const { bridge, bus } = fakes();
    await writeRedactedScreenFrames(bridge, bus, {});
    expect(mocks.redactScreenVideoFrame).toHaveBeenCalledWith(FRAME, {});
  });
});
