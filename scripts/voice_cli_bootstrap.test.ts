import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { resolveStorageFloor } from '@agent/core/storage-layout';

const setup = vi.hoisted(() => ({
  reasoning: vi.fn(() => true),
  speech: vi.fn(() => ({ name: 'test-stt' })),
  appleSpeech: vi.fn(async () => false),
  appleFile: vi.fn(() => false),
  turn: vi.fn(async () => ({ transcript: 'fixture', assistantText: 'reply' })),
  session: vi.fn(() => ({
    session_id: 'cli-test',
    profile_id: 'fixture',
    language: 'ja',
    assistant_name: 'Aoi',
  })),
  exchange: vi.fn(),
  presence: vi.fn(async () => undefined),
}));

vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (original) => ({
  ...(await original<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackends: setup.reasoning,
}));
vi.mock('@agent/core/voice/speech-to-text-bridge', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/speech-to-text-bridge')>()),
  installAvailableSpeechToTextBridges: setup.speech,
  getSpeechToTextBridge: () => ({ name: 'test-stt' }),
}));
vi.mock('@agent/core/apple-intelligence-bridge', async (original) => ({
  ...(await original<typeof import('@agent/core/apple-intelligence-bridge')>()),
  installAppleSpeechToTextBridgeIfAvailable: setup.appleSpeech,
}));
vi.mock('@agent/core/apple-speech-file-stt-bridge', async (original) => ({
  ...(await original<typeof import('@agent/core/apple-speech-file-stt-bridge')>()),
  installAppleSpeechFileToTextBridgeIfAvailable: setup.appleFile,
}));
vi.mock('@agent/core/voice/realtime-voice-conversation', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/realtime-voice-conversation')>()),
  runRealtimeVoiceConversationTurn: setup.turn,
  ensureRealtimeVoiceConversationSession: setup.session,
  recordRealtimeVoiceConversationExchange: setup.exchange,
}));
vi.mock('@agent/core/presence-bridge', async (original) => ({
  ...(await original<typeof import('@agent/core/presence-bridge')>()),
  reflectPresenceAgentReply: setup.presence,
}));

import { main as runVoiceCli } from './run_realtime_voice_conversation.js';
import { main as runLiveCli } from './aituber_live_session.js';

const tmp = resolveStorageFloor(
  'scratch',
  { kind: 'tier', tier: 'public' },
  'voice-cli-bootstrap-test'
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  safeRmSync(tmp);
  vi.restoreAllMocks();
});

function expectNoSetup(): void {
  for (const initialize of [setup.reasoning, setup.speech, setup.appleSpeech, setup.appleFile])
    expect(initialize).not.toHaveBeenCalled();
}

describe('voice CLI initialization boundary', () => {
  it.each([
    ['realtime', runVoiceCli],
    ['live', runLiveCli],
  ] as const)(
    '%s help does not initialize native speech or credential-bound providers',
    async (_name, run) => {
      await run(['--help'], () => {});
      expectNoSetup();
      expect(setup.session).not.toHaveBeenCalled();
      expect(setup.turn).not.toHaveBeenCalled();
    }
  );

  it('validates realtime command requirements before initializing anything', async () => {
    await expect(runVoiceCli(['--session-id', 'cli-test'], () => {})).rejects.toThrow(
      '--audio is required'
    );
    expectNoSetup();
  });

  it('rejects malformed live arguments before provider discovery', async () => {
    await expect(runLiveCli(['--delivery-mode', 'invalid'], () => {})).rejects.toThrow();
    expectNoSetup();
  });

  it('initializes providers for a valid realtime execution and invokes its turn', async () => {
    await runVoiceCli(
      ['--session-id', 'cli-test', '--audio', 'package.json', '--python-bin', 'node'],
      () => {}
    );
    expect(setup.reasoning).toHaveBeenCalledTimes(1);
    expect(setup.speech).toHaveBeenCalledTimes(1);
    expect(setup.turn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'cli-test' }));
  });

  it('rehearses a live fixture without bootstrapping reasoning or speech', async () => {
    safeMkdir(tmp, { recursive: true });
    const fixture = tmp + '/messages.json';
    safeWriteFile(
      fixture,
      JSON.stringify({ messages: [{ id: 'm1', author: 'viewer', text: 'hello' }] })
    );
    await runLiveCli(['--session-id', 'cli-test', '--fixture', fixture, '--dry-run'], () => {});
    expectNoSetup();
    expect(setup.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ assistantText: '[dry-run] hello' })
    );
  });
});
