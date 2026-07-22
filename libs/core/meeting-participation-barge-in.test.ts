import { describe, expect, it } from 'vitest';
import {
  EnergyVad,
  MeetingParticipationCoordinator,
  StubAudioBus,
  StubStreamingSpeechToTextBridge,
  TraceContext,
  type AudioChunk,
  type AudioFormat,
  type ConversationAgent,
  type MeetingJoinDriver,
  type MeetingSession,
  type MeetingTarget,
  type StreamingTextToSpeechBridge,
} from './index.js';

const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 };

function pcmChunk(amplitude: number, durationMs = 100): AudioChunk {
  const payload = new Uint8Array((format.sample_rate_hz * durationMs * 2) / 1000);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, amplitude, true);
  }
  return { format, payload, ts_ms: 0 };
}

class SlowTts implements StreamingTextToSpeechBridge {
  readonly bridge_id = 'test-slow-tts';
  readonly format = format;

  async *synthesizeStream(): AsyncIterable<AudioChunk> {
    yield pcmChunk(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
  }
}

class CancelAwareDriver implements MeetingJoinDriver {
  readonly driver_id = 'test-cancel-aware';
  readonly supported_platforms = ['meet'] as const;
  aborted = false;

  async probe(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async join(_target: MeetingTarget, bus: StubAudioBus): Promise<MeetingSession> {
    let left = false;
    const markAborted = (): void => {
      this.aborted = true;
    };
    return {
      state: {
        session_id: 'test-cancel-aware-session',
        platform: 'meet',
        status: 'in_meeting',
        joined_at: new Date().toISOString(),
      },
      async *audioInput(): AsyncIterable<AudioChunk> {
        for await (const item of bus.inputStream()) {
          if (left) return;
          yield item;
        }
      },
      audioOutput: async (
        stream: AsyncIterable<AudioChunk>,
        signal?: AbortSignal
      ): Promise<void> => {
        const iterator = stream[Symbol.asyncIterator]();
        await iterator.next();
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              markAborted();
              resolve();
            },
            { once: true }
          );
        });
      },
      async chat(): Promise<void> {},
      async leave(): Promise<void> {
        left = true;
        await bus.close();
      },
    };
  }
}

describe('MeetingParticipationCoordinator barge-in', () => {
  it('cancels assistant output and replays the interrupting input to STT', async () => {
    const bus = new StubAudioBus();
    const driver = new CancelAwareDriver();
    const trace = new TraceContext('meeting_participation:barge-in');
    let utterances = 0;
    const agent: ConversationAgent = {
      async onUtterance() {
        utterances += 1;
        if (utterances === 1) {
          setTimeout(() => {
            bus.injectInbound(pcmChunk(4_000));
            bus.injectInbound(pcmChunk(4_000));
            bus.injectInbound(pcmChunk(4_000));
            bus.injectInbound(pcmChunk(0));
          }, 5);
          return { speech: '長い返答を中断できます。' };
        }
        return { leave: true };
      },
    };

    bus.injectInbound(pcmChunk(4_000));
    const report = await new MeetingParticipationCoordinator({
      driver,
      bus,
      stt: new StubStreamingSpeechToTextBridge(1),
      tts: new SlowTts(),
      vad: new EnergyVad(),
      agent,
      trace,
    }).run(
      { url: 'https://meet.google.com/test-test-test', platform: 'meet' },
      {
        max_minutes: 1,
        voice_profile_id: 'operator-default-v1',
        audio_format: format,
        barge_in_enabled: true,
        barge_in_min_duration_ms: 250,
        post_playback_drain_ms: 0,
        require_recording_consent: false,
      }
    );

    expect(driver.aborted).toBe(true);
    expect(report.utterances_received).toBeGreaterThanOrEqual(2);
    expect(report.utterances_spoken).toBe(1);
    expect(JSON.stringify(trace.finalize())).toContain('meeting_participation.barge_in');
  });
});
