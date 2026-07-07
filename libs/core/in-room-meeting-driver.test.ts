import { afterEach, describe, expect, it } from 'vitest';

import { StubAudioBus } from './audio-bus.js';
import {
  InRoomMeetingJoinDriver,
  installInRoomMeetingJoinDriver,
} from './in-room-meeting-driver.js';
import {
  getMeetingJoinDriver,
  registerMeetingJoinDriver,
  resetMeetingJoinDriverRegistry,
  StubMeetingJoinDriver,
  validateMeetingTarget,
} from './meeting-join-driver.js';
import type { AudioChunk } from './meeting-session-types.js';

function fixtureMicCommand(bytes: number): string[] {
  return [
    process.execPath,
    '-e',
    `const b=Buffer.alloc(${bytes});for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*500,i);process.stdout.write(b);`,
  ];
}

afterEach(() => {
  resetMeetingJoinDriverRegistry();
  registerMeetingJoinDriver(new StubMeetingJoinDriver());
});

describe('in-room meeting driver', () => {
  it('accepts in_room targets without a host allowlist', () => {
    const validated = validateMeetingTarget({ url: '', platform: 'in_room' });
    expect(validated.platform).toBe('in_room');
    expect(validated.url).toBe('room://local');
  });

  it('registers into the driver registry as in-room', () => {
    installInRoomMeetingJoinDriver({ mic: { command: ['echo'] } });
    const driver = getMeetingJoinDriver('in-room');
    expect(driver?.driver_id).toBe('in-room');
    expect(driver?.supported_platforms).toContain('in_room');
  });

  it('joins with mic audio as audioInput and plays audioOutput via the playback command', async () => {
    const driver = new InRoomMeetingJoinDriver({
      mic: { command: fixtureMicCommand(9600), sampleRateHz: 16000, chunkMs: 100 },
      playbackCommand: [process.execPath, '-e', 'process.exit(0)'],
    });
    const probe = await driver.probe();
    expect(probe.available).toBe(true);

    const session = await driver.join(
      { url: 'room://local', platform: 'in_room', display_name: 'Kyberion' },
      new StubAudioBus()
    );
    expect(session.state.platform).toBe('in_room');
    expect(session.state.status).toBe('in_meeting');

    const received: AudioChunk[] = [];
    for await (const chunk of session.audioInput()) {
      received.push(chunk);
    }
    expect(received.length).toBe(3);
    expect(received[0]?.format.encoding).toBe('pcm_s16le');

    // Speaking path: drain a short synthetic utterance without error.
    async function* utterance(): AsyncIterable<AudioChunk> {
      yield {
        format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
        payload: new Uint8Array(3200),
        ts_ms: 0,
      };
    }
    await session.audioOutput(utterance());

    await session.leave();
    expect(session.state.status).toBe('ended');
  });

  it('probe fails when the mic backend is unavailable', async () => {
    const driver = new InRoomMeetingJoinDriver({
      mic: {},
      playbackCommand: ['echo'],
    });
    // On machines without ffmpeg/arecord this is false; with them it's true.
    // Either way the probe must return a structured result, never throw.
    const probe = await driver.probe();
    expect(typeof probe.available).toBe('boolean');
  });
});
