import { describe, expect, it } from 'vitest';
import {
  EnergyVad,
  MeetingParticipationCoordinator,
  StubAudioBus,
  StubMeetingJoinDriver,
  StubStreamingSpeechToTextBridge,
  StubStreamingTextToSpeechBridge,
  type AudioFormat,
  type ConversationAgent,
  type MeetingTarget,
  type TranscriptChunk,
} from './index.js';

const FORMAT: AudioFormat = {
  encoding: 'pcm_s16le',
  sample_rate_hz: 16000,
  channels: 1,
};

function makeChunk(byteLength = 320): { format: AudioFormat; payload: Uint8Array; ts_ms: number } {
  return {
    format: FORMAT,
    payload: new Uint8Array(byteLength),
    ts_ms: 0,
  };
}

describe('MeetingParticipationCoordinator (stub end-to-end)', () => {
  it('joins, hears 3 stub utterances, replies once each, leaves cleanly', async () => {
    const bus = new StubAudioBus();
    const driver = new StubMeetingJoinDriver();
    const stt = new StubStreamingSpeechToTextBridge(1); // one final per chunk
    const tts = new StubStreamingTextToSpeechBridge();
    const vad = new EnergyVad();

    const heard: TranscriptChunk[] = [];
    const agent: ConversationAgent = {
      async onUtterance(utt) {
        heard.push(utt);
        if (heard.length >= 3) return { speech: 'final reply', leave: true };
        return { speech: `replying to ${utt.text}` };
      },
    };

    const coordinator = new MeetingParticipationCoordinator({
      driver,
      bus,
      stt,
      tts,
      vad,
      agent,
    });

    // Inject some inbound chunks BEFORE running so the bus has data.
    for (let i = 0; i < 5; i++) bus.injectInbound(makeChunk());

    const target: MeetingTarget = {
      url: 'https://meet.google.com/test-test-test',
      platform: 'meet',
      display_name: 'Kyberion',
    };

    const report = await coordinator.run(target, {
      max_minutes: 1,
      voice_profile_id: 'operator-default-v1',
      audio_format: FORMAT,
    });

    expect(heard.length).toBeGreaterThanOrEqual(3);
    expect(report.utterances_received).toBeGreaterThanOrEqual(3);
    expect(report.utterances_spoken).toBeGreaterThanOrEqual(1);
    expect(report.session_id).toMatch(/^stub-/);
    expect(report.left_at).toBeDefined();
  });

  it('agent.leave=true on first utterance ends the session immediately', async () => {
    const bus = new StubAudioBus();
    const driver = new StubMeetingJoinDriver();
    const stt = new StubStreamingSpeechToTextBridge(1);
    const tts = new StubStreamingTextToSpeechBridge();
    const vad = new EnergyVad();

    const agent: ConversationAgent = {
      async onUtterance() {
        return { leave: true };
      },
    };

    bus.injectInbound(makeChunk());
    bus.injectInbound(makeChunk());
    const target: MeetingTarget = {
      url: 'https://meet.google.com/test-test-test',
      platform: 'meet',
    };
    const report = await new MeetingParticipationCoordinator({
      driver,
      bus,
      stt,
      tts,
      vad,
      agent,
    }).run(target, {
      max_minutes: 1,
      voice_profile_id: 'operator-default-v1',
      audio_format: FORMAT,
    });
    expect(report.utterances_spoken).toBe(0);
    expect(report.utterances_received).toBeGreaterThanOrEqual(1);
  });
});

describe('EnergyVad', () => {
  it('declares an endpoint after enough silence following speech', () => {
    // Each chunk is 320 bytes = 160 PCM_S16LE samples @ 16 kHz = 10 ms.
    // endpoint_ms=30 → 3 silence chunks needed after speech to endpoint.
    const vad = new EnergyVad({ rms_threshold: 100, endpoint_ms: 30 });

    const speech = new Uint8Array(320);
    new DataView(speech.buffer).setInt16(0, 8000, true);
    const speechChunk = { format: FORMAT, payload: speech, ts_ms: 0 };
    const silenceChunk = { format: FORMAT, payload: new Uint8Array(320), ts_ms: 100 };

    const s1 = vad.ingest(speechChunk);
    expect(s1.speaking).toBe(true);
    vad.ingest(silenceChunk); // 10ms silence
    vad.ingest(silenceChunk); // 20ms silence
    const s4 = vad.ingest(silenceChunk); // 30ms silence — endpoint
    expect(s4.endpoint).toBe(true);
  });

  it('does not endpoint without prior speech', () => {
    const vad = new EnergyVad({ rms_threshold: 100, endpoint_ms: 30 });
    const silenceChunk = { format: FORMAT, payload: new Uint8Array(320), ts_ms: 0 };
    const s1 = vad.ingest(silenceChunk);
    const s2 = vad.ingest(silenceChunk);
    const s3 = vad.ingest(silenceChunk);
    expect(s1.endpoint).toBe(false);
    expect(s2.endpoint).toBe(false);
    expect(s3.endpoint).toBe(false);
  });
});
