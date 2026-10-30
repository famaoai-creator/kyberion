import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const probes = vi.hoisted(() => ({
  pcm: vi.fn(() => ({ available: false, reason: 'fixture player unavailable' })),
  artifact: vi.fn(() => ({ available: true, reason: 'fixture artifact player unavailable' })),
  disposeWarm: vi.fn(async () => undefined),
  disposeTts: vi.fn(() => undefined),
  batchTranscribe: vi.fn(async () => ({ text: 'batch fixture' })),
  startLoop: vi.fn(async (_options: unknown) => {
    throw new Error('fixture-loop-started');
  }),
  batchName: 'fixture-batch',
  fakeTts: false,
  throwingRegistration: false,
}));
vi.mock('@agent/core/voice/speech-to-text-bridge', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/speech-to-text-bridge')>()),
  resolveSpeechToTextBridge: () => ({ name: probes.batchName, transcribe: probes.batchTranscribe }),
}));
vi.mock('@agent/core/mic-capture', async (original) => ({
  ...(await original<typeof import('@agent/core/mic-capture')>()),
  probeMicCapture: () => ({ available: true }),
}));
vi.mock('@agent/core/voice/audio-playback', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/audio-playback')>()),
  probeAudioPlayback: probes.artifact,
}));
vi.mock('@agent/core/streaming-voice-playback', async (original) => ({
  ...(await original<typeof import('@agent/core/streaming-voice-playback')>()),
  probePcmAudioStreaming: probes.pcm,
}));
vi.mock('@agent/core/voice/realtime-voice-loop', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/realtime-voice-loop')>()),
  startRealtimeVoiceLoop: probes.startLoop,
}));
vi.mock('@agent/core/voice/realtime-voice-conversation', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/realtime-voice-conversation')>()),
  ensureRealtimeVoiceConversationSession: () => ({
    session_id: 'streaming-cleanup',
    profile_id: 'fixture',
    language: 'ja',
    assistant_name: 'Agent',
  }),
}));
vi.mock('@agent/core/voice/realtime-voice-preferences', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/realtime-voice-preferences')>()),
  loadRealtimeVoiceConversationPreferences: () => null,
}));
vi.mock('@agent/core/silero-vad-bridge', () => ({ installSileroVadBackend: vi.fn() }));
vi.mock('@agent/core/ten-vad-bridge', () => ({ installTenVadBackend: vi.fn() }));
vi.mock('@agent/core/vad-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/vad-registry')>()),
  resolveVadBackend: () => ({ backend: { backend_id: 'fixture', create: vi.fn() } }),
}));
vi.mock('@agent/core/actuator/actuator-serve-client', async (original) => ({
  ...(await original<typeof import('@agent/core/actuator/actuator-serve-client')>()),
  createVoiceActuatorServeClient: () => ({ request: vi.fn(), dispose: probes.disposeWarm }),
}));
vi.mock('@agent/core/shell/shell-streaming-stt-bridge', async (original) => {
  const actual = await original<typeof import('@agent/core/shell/shell-streaming-stt-bridge')>();
  return {
    ...actual,
    installShellStreamingSttBridgeFromEnv: (env?: NodeJS.ProcessEnv) => {
      const result = actual.installShellStreamingSttBridgeFromEnv(env);
      return result.dispose && probes.throwingRegistration
        ? {
            ...result,
            dispose: () => {
              result.dispose!();
              throw new Error('fixture registration cleanup failed');
            },
          }
        : result;
    },
  };
});
vi.mock('@agent/core/voice/streaming-tts-bridge', async (original) => {
  const actual = await original<typeof import('@agent/core/voice/streaming-tts-bridge')>();
  return {
    ...actual,
    getStreamingTtsBridge: (id?: string) =>
      probes.fakeTts && id === 'shell'
        ? {
            bridge_id: 'shell',
            format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
            dispose: probes.disposeTts,
            synthesizeStream: async function* () {
              yield* [];
              throw new Error('fixture primary stream failure');
            },
          }
        : actual.getStreamingTtsBridge(id),
  };
});

import {
  getStreamingSttBridge,
  listStreamingSttBridges,
  resetStreamingSttBridges,
} from '@agent/core/voice/streaming-stt-bridge';
import {
  getStreamingTtsBridge,
  resetStreamingTtsBridges,
} from '@agent/core/voice/streaming-tts-bridge';
import { MediaEventBuffer } from '@agent/core/realtime-media-session';
import {
  parseRealtimeVoiceConversationCli,
  runRealtimeVoiceConversationLoop,
} from './run_realtime_voice_conversation.js';

function options() {
  const result = parseRealtimeVoiceConversationCli({
    'session-id': 'streaming-cleanup',
    interactive: true,
    mission: 'MSN-STREAM-CLEANUP',
    language: 'ja',
    'python-bin': 'node',
    'mic-device': 'fixture-device',
    'speculative-reply': false,
  });
  result.streamingConfig = {
    sttCommand: 'fixture-stream-stt',
    ttsCommand: 'fixture-stream-tts',
    ttsSampleRateHz: 24000,
    playbackCommand: ['fixture-player', '--pcm'],
  };
  return result;
}
function expectRegistrationsReleased(): void {
  expect(listStreamingSttBridges()).not.toContain('shell');
  expect(() => getStreamingSttBridge('shell')).toThrow('unknown bridge');
  probes.fakeTts = false;
  expect(() => getStreamingTtsBridge('shell')).toThrow('unknown bridge');
}
beforeEach(() => {
  vi.clearAllMocks();
  probes.pcm.mockReturnValue({ available: false, reason: 'fixture player unavailable' });
  probes.artifact.mockReturnValue({
    available: true,
    reason: 'fixture artifact player unavailable',
  });
  probes.disposeWarm.mockResolvedValue(undefined);
  probes.disposeTts.mockImplementation(() => undefined);
  probes.batchName = 'fixture-batch';
  probes.fakeTts = false;
  probes.throwingRegistration = false;
  vi.stubEnv('KYBERION_STREAMING_STT_BRIDGE', 'shell');
  for (const key of [
    'KYBERION_STT_COMMAND',
    'KYBERION_STT_ARGS',
    'KYBERION_TTS_COMMAND',
    'KYBERION_TTS_ARGS',
  ])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  resetStreamingSttBridges();
  resetStreamingTtsBridges();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('interactive streaming startup cleanup', () => {
  it('uses custom PCM preflight even when the artifact player is unavailable, and releases startup resources', async () => {
    probes.artifact.mockReturnValue({
      available: false,
      reason: 'fixture artifact player unavailable',
    });
    await expect(runRealtimeVoiceConversationLoop(options(), () => {})).rejects.toThrow(
      'fixture player unavailable'
    );
    expect(probes.pcm).toHaveBeenCalledWith(['fixture-player', '--pcm']);
    expect(probes.artifact).not.toHaveBeenCalled();
    expect(probes.disposeWarm).toHaveBeenCalledTimes(1);
    expectRegistrationsReleased();
    expect(process.env.KYBERION_STT_COMMAND).toBeUndefined();
    expect(process.env.KYBERION_TTS_COMMAND).toBeUndefined();
  });

  it('still requires an artifact player when the artifact playback route is selected', async () => {
    probes.artifact.mockReturnValue({
      available: false,
      reason: 'fixture artifact player unavailable',
    });
    const input = options();
    input.streamingConfig = { sttCommand: 'fixture-stream-stt' };
    await expect(runRealtimeVoiceConversationLoop(input, () => {})).rejects.toThrow(
      'Audio playback unavailable'
    );
    expect(probes.artifact).toHaveBeenCalledOnce();
    expect(probes.pcm).not.toHaveBeenCalled();
  });

  it('retains the primary startup failure while all throwing/rejecting cleanup paths are attempted', async () => {
    probes.pcm.mockReturnValue({ available: true, reason: '' });
    probes.fakeTts = true;
    probes.throwingRegistration = true;
    probes.disposeTts.mockImplementation(() => {
      throw new Error('fixture TTS cleanup failed');
    });
    probes.disposeWarm.mockRejectedValue(new Error('fixture warm cleanup failed'));
    const input = options();
    const buffer = new MediaEventBuffer('streaming-cleanup');
    const unsubscribe = vi.fn(() => {
      throw new Error('fixture media cleanup failed');
    });
    vi.spyOn(buffer, 'subscribe').mockReturnValue(unsubscribe);
    input.mediaEventBufferFactory = () => buffer;
    input.onMediaEvent = () => {};
    await expect(runRealtimeVoiceConversationLoop(input, () => {})).rejects.toThrow(
      'fixture primary stream failure'
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(probes.disposeTts).toHaveBeenCalled();
    expect(probes.disposeWarm).toHaveBeenCalledOnce();
    expectRegistrationsReleased();
  });

  it('accepts saved streaming STT without batch STT and never uses the synthetic batch fallback', async () => {
    probes.batchName = 'stub';
    const input = options();
    input.deliveryMode = 'none';
    input.warmActuator = false;
    input.streamingConfig = { sttCommand: 'fixture-stream-stt' };
    await expect(runRealtimeVoiceConversationLoop(input, () => {})).rejects.toThrow(
      'fixture-loop-started'
    );
    expect(probes.startLoop).toHaveBeenCalledOnce();
    const request = probes.startLoop.mock.calls[0][0] as {
      transcribe: (path: string) => Promise<string>;
      streamingStt?: unknown;
    };
    expect(request.streamingStt).toBeDefined();
    await expect(request.transcribe('fixture.wav')).rejects.toThrow('no real batch STT fallback');
    expect(probes.batchTranscribe).not.toHaveBeenCalled();
    expectRegistrationsReleased();
  });

  it('fails closed when neither streaming nor real batch STT is available', async () => {
    probes.batchName = 'stub';
    const input = options();
    input.deliveryMode = 'none';
    input.streamingStt = false;
    input.streamingConfig = {};
    await expect(runRealtimeVoiceConversationLoop(input, () => {})).rejects.toThrow(
      'real streaming or batch STT'
    );
    expect(probes.startLoop).not.toHaveBeenCalled();
    expect(probes.batchTranscribe).not.toHaveBeenCalled();
  });
});
