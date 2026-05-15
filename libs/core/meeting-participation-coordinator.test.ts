import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EnergyVad,
  MeetingParticipationCoordinator,
  TraceContext,
  finalizeAndPersist,
  StubAudioBus,
  StubMeetingJoinDriver,
  StubStreamingSpeechToTextBridge,
  StubStreamingTextToSpeechBridge,
  type AudioFormat,
  type ConversationAgent,
  type MeetingTarget,
  type TranscriptChunk,
  pathResolver,
} from './index.js';

const ROOT = pathResolver.rootDir();
const CONSENT_MISSION = 'MSN-MTG-CONSENT-TEST';
const CONSENT_MISSION_DIR = path.join(ROOT, 'active/missions/confidential', CONSENT_MISSION);
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

function writeVoiceConsent(record: Record<string, unknown>): void {
  const evidenceDir = path.join(CONSENT_MISSION_DIR, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(CONSENT_MISSION_DIR, 'mission-state.json'),
    JSON.stringify({
      mission_id: CONSENT_MISSION,
      tier: 'confidential',
      assigned_persona: 'ecosystem_architect',
    }),
  );
  fs.writeFileSync(path.join(evidenceDir, 'voice-consent.json'), JSON.stringify(record));
}

describe('MeetingParticipationCoordinator (stub end-to-end)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(CONSENT_MISSION_DIR, { recursive: true, force: true });
  });

  it('joins, hears 3 stub utterances, replies once each, leaves cleanly', async () => {
    const traceDir = fs.mkdtempSync(path.join(ROOT, 'active/shared/tmp/kyberion-meeting-trace-'));
    const bus = new StubAudioBus();
    const driver = new StubMeetingJoinDriver();
    const stt = new StubStreamingSpeechToTextBridge(1); // one final per chunk
    const tts = new StubStreamingTextToSpeechBridge();
    const vad = new EnergyVad();
    const trace = new TraceContext('meeting_participation:test', { missionId: 'MSN-TEST-1' });

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
      trace,
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

    const persisted = finalizeAndPersist(trace, { dir: traceDir });
    const persistedText = fs.readFileSync(persisted.path, 'utf8');
    expect(persistedText).toContain('meeting_participation.run');
    expect(persistedText).toContain('meeting_participation.spoke');
    fs.rmSync(traceDir, { recursive: true, force: true });
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
    const trace = new TraceContext('meeting_participation:test', { missionId: 'MSN-TEST-2' });

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
      trace,
    }).run(target, {
      max_minutes: 1,
      voice_profile_id: 'operator-default-v1',
      audio_format: FORMAT,
    });
    expect(report.utterances_spoken).toBe(0);
    expect(report.utterances_received).toBeGreaterThanOrEqual(1);
    const summary = trace.summary();
    expect(summary.spans).toBeGreaterThanOrEqual(2);
  });

  it('refuses recording before opening the audio bus when mission consent is missing', async () => {
    fs.mkdirSync(path.join(CONSENT_MISSION_DIR, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(CONSENT_MISSION_DIR, 'mission-state.json'),
      JSON.stringify({
        mission_id: CONSENT_MISSION,
        tier: 'confidential',
        assigned_persona: 'ecosystem_architect',
      }),
    );
    const bus = new StubAudioBus();
    const openSpy = vi.spyOn(bus, 'open');
    const agent: ConversationAgent = {
      async onUtterance() {
        return { speech: 'should not run' };
      },
    };
    const trace = new TraceContext('meeting_participation:consent-missing', {
      missionId: CONSENT_MISSION,
    });

    await expect(
      new MeetingParticipationCoordinator({
        driver: new StubMeetingJoinDriver(),
        bus,
        stt: new StubStreamingSpeechToTextBridge(1),
        tts: new StubStreamingTextToSpeechBridge(),
        vad: new EnergyVad(),
        agent,
        trace,
      }).run(
        {
          url: 'https://meet.google.com/test-test-test',
          platform: 'meet',
        },
        {
          mission_id: CONSENT_MISSION,
          max_minutes: 1,
          voice_profile_id: 'operator-default-v1',
          audio_format: FORMAT,
        },
      ),
    ).rejects.toThrow(/voice-consent\.json missing/);

    expect(openSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(trace.finalize())).toContain('meeting_participation.recording_denied');
  });

  it('re-checks voice consent before TTS speech', async () => {
    writeVoiceConsent({
      consent: 'revoked',
      mission_id: CONSENT_MISSION,
      operator_handle: 'operator',
    });
    const bus = new StubAudioBus();
    const tts = new StubStreamingTextToSpeechBridge();
    const ttsSpy = vi.spyOn(tts, 'synthesizeStream');
    const agent: ConversationAgent = {
      async onUtterance() {
        return { speech: 'blocked speech' };
      },
    };
    const trace = new TraceContext('meeting_participation:voice-denied', {
      missionId: CONSENT_MISSION,
    });
    bus.injectInbound(makeChunk());

    await expect(
      new MeetingParticipationCoordinator({
        driver: new StubMeetingJoinDriver(),
        bus,
        stt: new StubStreamingSpeechToTextBridge(1),
        tts,
        vad: new EnergyVad(),
        agent,
        trace,
      }).run(
        {
          url: 'https://meet.google.com/test-test-test',
          platform: 'meet',
        },
        {
          mission_id: CONSENT_MISSION,
          require_recording_consent: false,
          require_voice_consent: true,
          max_minutes: 1,
          voice_profile_id: 'operator-default-v1',
          audio_format: FORMAT,
        },
      ),
    ).rejects.toThrow(/consent != 'granted'/);

    expect(ttsSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(trace.finalize())).toContain('meeting_participation.speak_denied');
  });

  it('allows capture and speech when mission consent is granted', async () => {
    writeVoiceConsent({
      consent: 'granted',
      mission_id: CONSENT_MISSION,
      operator_handle: 'operator',
      expires_at: '2999-01-01T00:00:00.000Z',
    });
    const bus = new StubAudioBus();
    let heard = 0;
    const agent: ConversationAgent = {
      async onUtterance() {
        heard += 1;
        return heard === 1 ? { speech: 'approved reply' } : { leave: true };
      },
    };
    bus.injectInbound(makeChunk());

    const report = await new MeetingParticipationCoordinator({
      driver: new StubMeetingJoinDriver(),
      bus,
      stt: new StubStreamingSpeechToTextBridge(1),
      tts: new StubStreamingTextToSpeechBridge(),
      vad: new EnergyVad(),
      agent,
      trace: new TraceContext('meeting_participation:consent-granted', {
        missionId: CONSENT_MISSION,
      }),
    }).run(
      {
        url: 'https://meet.google.com/test-test-test',
        platform: 'meet',
      },
      {
        mission_id: CONSENT_MISSION,
        max_minutes: 1,
        voice_profile_id: 'operator-default-v1',
        audio_format: FORMAT,
      },
    );

    expect(report.utterances_spoken).toBe(1);
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
