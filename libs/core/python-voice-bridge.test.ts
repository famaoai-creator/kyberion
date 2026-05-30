import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import * as nodefs from 'node:fs';
import { PythonVoiceBridge, installPythonVoiceBridgeIfAvailable } from './python-voice-bridge.js';
import { resetVoiceBridge, getVoiceBridge, stubVoiceBridge, type RoleplayTurn } from './voice-bridge.js';

const mockExec = execFileSync as ReturnType<typeof vi.fn>;
const mockExists = nodefs.existsSync as ReturnType<typeof vi.fn>;

function makeStubBridge() {
  return {
    name: 'stub-text',
    runRoleplaySession: vi.fn().mockResolvedValue({
      turns: [
        { speaker: 'sovereign', text: 'Hello from sovereign', timestamp: '2026-01-01T00:00:00Z' },
        { speaker: 'counterparty', text: 'Response', timestamp: '2026-01-01T00:00:01Z' },
      ],
    }),
    runOneOnOneSession: vi.fn().mockResolvedValue({
      transcript: [
        { speaker: 'sovereign', text: 'Opening line', timestamp: '2026-01-01T00:00:00Z' },
      ],
    }),
  };
}

const BASE_OPTS = {
  profileId: 'test-profile',
  voiceBridgePath: '/tmp/voice_learning_bridge.py',
  audioOutputDir: '/tmp/voice-out',
  language: 'ja',
};

describe('PythonVoiceBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceBridge();
    mockExists.mockReturnValue(true);
  });

  afterEach(() => {
    resetVoiceBridge();
  });

  describe('runRoleplaySession', () => {
    it('calls text bridge and augments sovereign turns with audio_ref', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockReturnValue('{"status":"success","output_path":"/tmp/out.wav"}\n');

      const bridge = new PythonVoiceBridge({ ...BASE_OPTS, textBridge });
      const result = await bridge.runRoleplaySession({} as any);

      expect(result.turns).toHaveLength(2);
      const sovereignTurn = result.turns[0] as RoleplayTurn & { audio_ref?: string };
      expect(sovereignTurn.audio_ref).toContain('/tmp/voice-out/test-profile/roleplay/');
      expect(sovereignTurn.audio_ref).toMatch(/\.wav$/);

      // Counterparty turn should not have audio_ref
      expect((result.turns[1] as any).audio_ref).toBeUndefined();
    });

    it('sets audio_ref to undefined when TTS returns non-success', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockReturnValue('{"status":"error","message":"engine unavailable"}\n');

      const bridge = new PythonVoiceBridge({ ...BASE_OPTS, textBridge });
      const result = await bridge.runRoleplaySession({} as any);
      expect((result.turns[0] as any).audio_ref).toBeUndefined();
    });

    it('sets audio_ref to undefined when TTS throws', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockImplementation(() => { throw new Error('python not found'); });

      const bridge = new PythonVoiceBridge({ ...BASE_OPTS, textBridge });
      const result = await bridge.runRoleplaySession({} as any);
      expect((result.turns[0] as any).audio_ref).toBeUndefined();
    });

    it('calls execFileSync with voice_learning_bridge path and JSON payload', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockReturnValue('{"status":"ok"}\n');

      const bridge = new PythonVoiceBridge({ ...BASE_OPTS, textBridge, pythonBin: 'python3' });
      await bridge.runRoleplaySession({} as any);

      expect(mockExec).toHaveBeenCalledWith(
        'python3',
        expect.arrayContaining([BASE_OPTS.voiceBridgePath, expect.stringContaining('"action":"generate"')]),
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });
  });

  describe('runOneOnOneSession', () => {
    it('delegates to text bridge and augments sovereign turns', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockReturnValue('{"status":"success"}\n');

      const bridge = new PythonVoiceBridge({ ...BASE_OPTS, textBridge });
      const result = await bridge.runOneOnOneSession({} as any);

      expect(result.transcript).toHaveLength(1);
      expect((result.transcript[0] as any).audio_ref).toBeTruthy();
    });
  });

  describe('BlackHole playback', () => {
    it('calls blackhole script when playThroughBlackhole=true and audio generated', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockReturnValue('{"status":"success"}\n');

      const bridge = new PythonVoiceBridge({
        ...BASE_OPTS,
        textBridge,
        blackholePath: '/tmp/blackhole_audio_router.py',
        playThroughBlackhole: true,
        pythonBin: 'python3',
      });
      await bridge.runRoleplaySession({} as any);

      const allCalls = mockExec.mock.calls.map(c => c[1] as string[]);
      const blackholeCalls = allCalls.filter(args => args[0] === '/tmp/blackhole_audio_router.py');
      expect(blackholeCalls).toHaveLength(1);
      expect(blackholeCalls[0][1]).toContain('"action":"play_to_blackhole"');
    });

    it('skips blackhole when playThroughBlackhole=false', async () => {
      const textBridge = makeStubBridge();
      mockExec.mockReturnValue('{"status":"success"}\n');

      const bridge = new PythonVoiceBridge({
        ...BASE_OPTS,
        textBridge,
        blackholePath: '/tmp/blackhole_audio_router.py',
        playThroughBlackhole: false,
      });
      await bridge.runRoleplaySession({} as any);

      const allCalls = mockExec.mock.calls.map(c => c[1] as string[]);
      const blackholeCalls = allCalls.filter(args => args[0] === '/tmp/blackhole_audio_router.py');
      expect(blackholeCalls).toHaveLength(0);
    });
  });
});

describe('installPythonVoiceBridgeIfAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceBridge();
    mockExists.mockReturnValue(true);
  });

  afterEach(() => {
    resetVoiceBridge();
  });

  it('returns false when KYBERION_VOICE_PROFILE_ID is not set', () => {
    const result = installPythonVoiceBridgeIfAvailable({});
    expect(result).toBe(false);
    expect(getVoiceBridge()).toBe(stubVoiceBridge);
  });

  it('returns false when voice_learning_bridge.py does not exist', () => {
    mockExists.mockReturnValue(false);
    const result = installPythonVoiceBridgeIfAvailable({ KYBERION_VOICE_PROFILE_ID: 'my-profile' });
    expect(result).toBe(false);
  });

  it('installs PythonVoiceBridge and returns true when conditions are met', () => {
    mockExists.mockReturnValue(true);
    const result = installPythonVoiceBridgeIfAvailable({ KYBERION_VOICE_PROFILE_ID: 'my-profile' });
    expect(result).toBe(true);
    const bridge = getVoiceBridge();
    expect(bridge.name).toBe('python-tts');
  });

  it('respects KYBERION_VOICE_PLAY_BLACKHOLE env var', () => {
    mockExists.mockReturnValue(true);
    installPythonVoiceBridgeIfAvailable({
      KYBERION_VOICE_PROFILE_ID: 'p1',
      KYBERION_VOICE_PLAY_BLACKHOLE: '1',
    });
    const bridge = getVoiceBridge() as PythonVoiceBridge;
    expect(bridge.name).toBe('python-tts');
  });
});
