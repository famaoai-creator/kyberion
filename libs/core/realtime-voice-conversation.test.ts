import { afterEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { registerSpeechToTextBridge, resetSpeechToTextBridge, type SpeechToTextBridge } from './speech-to-text-bridge.js';
import { registerReasoningBackend, resetReasoningBackend, stubReasoningBackend } from './reasoning-backend.js';
import { resetVoiceEngineRegistryCache } from './voice-engine-registry.js';
import { resetVoiceProfileRegistryCache } from './voice-profile-registry.js';
import {
  ensureRealtimeVoiceConversationSession,
  runRealtimeVoiceConversationTurn,
} from './realtime-voice-conversation.js';

const TMP_DIR = pathResolver.sharedTmp('realtime-voice-conversation-tests');
const PROFILE_REGISTRY_PATH = `${TMP_DIR}/voice-profile-registry.json`;
const ENGINE_REGISTRY_PATH = `${TMP_DIR}/voice-engine-registry.json`;

describe('realtime voice conversation', () => {
  afterEach(() => {
    safeRmSync(TMP_DIR, { recursive: true, force: true });
    safeRmSync(pathResolver.shared('runtime/realtime-voice-conversations'), { recursive: true, force: true });
    delete process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH;
    delete process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH;
    resetVoiceProfileRegistryCache();
    resetVoiceEngineRegistryCache();
    resetSpeechToTextBridge();
    resetReasoningBackend();
  });

  it('creates a session and runs a turn using active personal voice profile', async () => {
    safeMkdir(TMP_DIR, { recursive: true });
    safeWriteFile(
      PROFILE_REGISTRY_PATH,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'me-ja',
        profiles: [
          {
            profile_id: 'me-ja',
            display_name: 'Me JA',
            tier: 'personal',
            languages: ['ja'],
            default_engine_id: 'open_voice_clone',
            status: 'active',
          },
        ],
      }),
    );
    safeWriteFile(
      ENGINE_REGISTRY_PATH,
      JSON.stringify({
        version: 'test',
        default_engine_id: 'open_voice_clone',
        engines: [
          {
            engine_id: 'open_voice_clone',
            display_name: 'Open Voice Clone',
            kind: 'voice_clone_service',
            provider: 'test',
            status: 'active',
            platforms: ['any'],
            supports: {
              list_voices: false,
              playback: true,
              artifact_formats: ['wav'],
            },
          },
        ],
      }),
    );
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH = PROFILE_REGISTRY_PATH;
    process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH = ENGINE_REGISTRY_PATH;

    const fakeStt: SpeechToTextBridge = {
      name: 'fake-stt',
      async transcribe() {
        return { text: '今日の予定を教えて', backend: 'fake-stt' };
      },
    };
    registerSpeechToTextBridge(fakeStt);
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'fake-reasoner',
      async delegateTask() {
        return '今日はレビューと実装を進めます。';
      },
      async prompt() {
        return '今日はレビューと実装を進めます。';
      },
    });

    const session = ensureRealtimeVoiceConversationSession({
      sessionId: 'rtc-1',
      profileId: 'me-ja',
      assistantName: 'Kyberion',
      language: 'ja',
    });
    expect(session.profile_id).toBe('me-ja');

    const result = await runRealtimeVoiceConversationTurn({
      sessionId: 'rtc-1',
      audioPath: 'active/shared/tmp/fake-input.wav',
      deliveryMode: 'none',
    });

    expect(result.user_text).toBe('今日の予定を教えて');
    expect(result.assistant_text).toBe('今日はレビューと実装を進めます。');
    expect(result.profile_id).toBe('me-ja');
    const saved = JSON.parse(safeReadFile(result.transcript_path, { encoding: 'utf8' }) as string) as {
      transcript?: Array<{ speaker?: string; text?: string }>;
    };
    expect(saved.transcript).toHaveLength(2);
    expect(saved.transcript?.[1]?.speaker).toBe('assistant');
  });

  it('blocks shadow voice profiles before realtime use', () => {
    safeMkdir(TMP_DIR, { recursive: true });
    safeWriteFile(
      PROFILE_REGISTRY_PATH,
      JSON.stringify({
        version: 'test',
        default_profile_id: 'shadow-me',
        profiles: [
          {
            profile_id: 'shadow-me',
            display_name: 'Shadow Me',
            tier: 'personal',
            languages: ['ja'],
            default_engine_id: 'open_voice_clone',
            status: 'shadow',
          },
        ],
      }),
    );
    safeWriteFile(
      ENGINE_REGISTRY_PATH,
      JSON.stringify({
        version: 'test',
        default_engine_id: 'open_voice_clone',
        engines: [
          {
            engine_id: 'open_voice_clone',
            display_name: 'Open Voice Clone',
            kind: 'voice_clone_service',
            provider: 'test',
            status: 'active',
            platforms: ['any'],
            supports: {
              list_voices: false,
              playback: true,
              artifact_formats: ['wav'],
            },
          },
        ],
      }),
    );
    process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH = PROFILE_REGISTRY_PATH;
    process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH = ENGINE_REGISTRY_PATH;

    expect(() =>
      ensureRealtimeVoiceConversationSession({
        sessionId: 'rtc-shadow',
        profileId: 'shadow-me',
      }),
    ).toThrow(/promotion to active is required/u);
  });
});
