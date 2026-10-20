import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  audioBytes: 'governed audio',
  captureStream: vi.fn(),
  cameraStart: vi.fn(),
  cameraStop: vi.fn(),
  useRemoteFallback: false,
  cameras: new Map<string, object>(),
}));

vi.mock('@agent/core/governance/approval-gate', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('@agent/core/governance/accountability-charter-registry', () => ({
  findActiveCharter: vi.fn(() => null),
  loadCharterUsage: vi.fn(),
  recordCharterExecutionStarted: vi.fn(),
  recordCharterExecutionOutcome: vi.fn(),
}));
vi.mock('@agent/core/governance/external-operation-store', () => ({
  reserveExternalOperation: vi.fn(),
}));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('@agent/core/scope-envelope', () => ({ currentScopeEnvelope: vi.fn(() => undefined) }));
vi.mock('@agent/core/secure-io', async (original) => {
  const actual = await original<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExec: vi.fn(() => ''),
    safeExecResult: vi.fn(() => ({ status: 0, stdout: '{"status":"success"}', stderr: '' })),
    safeExistsSync: vi.fn(() => true),
    safeLstat: vi.fn(() => ({ isFile: () => true })),
    safeStat: vi.fn(() => ({ size: 4096 })),
    safeMkdir: vi.fn(),
    safeWriteFile: vi.fn(),
    safeRmSync: vi.fn(),
    safeReadFile: vi.fn((filePath: string, options?: unknown) =>
      /\.(wav|mp4)$/.test(filePath)
        ? Buffer.from(processMocks.audioBytes)
        : actual.safeReadFile(filePath, options as never)
    ),
    safeExecShellScript: vi.fn(() => ''),
    resolveUserLoginShell: vi.fn(() => '/bin/sh'),
    assertSafeRepositoryPath: vi.fn((value: string) => value),
  };
});
vi.mock('node:child_process', () => ({ spawn: processMocks.spawn }));
vi.mock('@agent/core/virtual/virtual-device-inventory-bridge', () => ({
  createVirtualDeviceInventoryBridge: () => ({
    probe: async () => ({
      available: true,
      inventory: {
        audio_outputs: [{ name: 'Governed Output' }],
        audio_inputs: [],
        video_inputs: [],
      },
    }),
  }),
}));
vi.mock('@agent/core/virtual/virtual-audio-input-recording-bridge', () => ({
  createVirtualAudioInputRecordingBridge: () => ({
    probe: async () => ({ available: true, inputs: ['Governed Microphone'] }),
    captureStream: processMocks.captureStream,
  }),
}));
vi.mock('@agent/core/obs-virtual-camera-output', () => ({
  installObsVirtualCameraOutputBridge: vi.fn(() => {
    if (processMocks.cameras.has('obs-virtual-cam')) throw new Error('duplicate registration');
    processMocks.cameras.set('obs-virtual-cam', {
      bridge_id: 'obs-virtual-cam',
      startAvatarOutput: processMocks.cameraStart,
      stopAvatarOutput: processMocks.cameraStop,
    });
  }),
}));
vi.mock('@agent/core/v4l2-virtual-camera-output', () => ({
  installV4l2VirtualCameraOutputBridge: vi.fn(() => {
    if (processMocks.cameras.has('v4l2-virtual-cam')) throw new Error('duplicate registration');
    processMocks.cameras.set('v4l2-virtual-cam', {
      bridge_id: 'v4l2-virtual-cam',
      startAvatarOutput: processMocks.cameraStart,
      stopAvatarOutput: processMocks.cameraStop,
    });
  }),
}));
vi.mock('@agent/core/camera-output-bridge', () => ({
  resolveCameraOutputBridge: async (id: string) =>
    processMocks.cameras.get(id === 'auto' ? 'obs-virtual-cam' : id),
  listCameraOutputBridges: () => [...processMocks.cameras.values()],
}));
vi.mock('@agent/core/tool/tool-binary-resolvers', () => ({
  resolveFfmpegBin: () => 'ffmpeg',
  resolveFfprobeBin: () => 'ffprobe',
  resolvePython3Bin: () => 'python',
}));
vi.mock('@agent/core/voice/audio-device-lease', () => ({
  AudioDeviceLeaseManager: class {
    acquire() {
      return { release: () => undefined };
    }
  },
}));
vi.mock('@agent/core/voice/voice-engine-registry', () => ({
  getVoiceEngineRecord: (id?: string) => ({
    engine_id: id === 'remote-fallback' ? id : 'local_say',
    status: 'active',
    platforms: ['any'],
    kind: 'native_local',
    provider: 'system_tts',
    ...(id === 'remote-fallback'
      ? { bridge_script: 'custom/remote_tts.py' }
      : processMocks.useRemoteFallback
        ? { fallback_engine_id: 'remote-fallback' }
        : {}),
    supports: { playback: true, artifact_formats: ['wav'] },
  }),
  resolveVoiceEngineForPlatform: () => ({
    engine_id: 'local_say',
    status: 'active',
    platforms: ['any'],
    kind: 'native_local',
    provider: 'system_tts',
    supports: { playback: true, artifact_formats: ['wav'] },
  }),
  getVoiceEngineRegistry: () => ({ engines: [], default_engine_id: 'local_say' }),
}));
vi.mock('@agent/core/seam', () => ({
  coreSeamCatalog: {},
  createSeam: () => {
    const providers = new Map<string, { id: string; implementation: unknown }>();
    return {
      register: (id: string, implementation: unknown) => {
        providers.set(id, { id, implementation });
        return () => {
          providers.delete(id);
        };
      },
      list: () => [...providers.values()],
      getOptional: (id: string) => providers.get(id)?.implementation,
      get: (id: string) => providers.get(id)?.implementation,
    };
  },
}));

import { enforceApprovalGate } from '@agent/core/governance/approval-gate';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  withExternalOperationAuthority,
  withExternalOperationPipelineRun,
} from '@agent/core/governance/external-operation';
import { safeExec } from '@agent/core/secure-io';
import { speak } from '@agent/core/media/native-tts';
import { createVirtualAudioOutputPlaybackBridge } from '@agent/core/virtual/virtual-audio-output-playback-bridge';
import {
  registerSpeechToTextBridge,
  getSpeechToTextBridges,
} from '@agent/core/voice/speech-to-text-bridge';
import {
  performPlayback,
  registerVoicePlaybackPlatformAdapter,
  resolveVoicePlaybackPlatformAdapter,
} from './voice-runtime-helpers.js';
import { recordVoiceSample } from '@agent/core/voice/voice-sample-recorder';
import { outputToVirtualCamera } from './voice-media-output-helpers.js';
import { safeExecShellScript } from '@agent/core/secure-io';
import { installObsVirtualCameraOutputBridge } from '@agent/core/obs-virtual-camera-output';

const trusted = <T>(body: () => T) =>
  withExternalOperationAuthority(
    () => ({
      agentId: 'voice-owner',
      tenantSlug: 'acme',
      invocationId: randomUUID(),
      hasHuman: true,
    }),
    body
  );

describe('voice external operation boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processMocks.audioBytes = 'governed audio';
    processMocks.cameras.clear();
    processMocks.useRemoteFallback = false;
    processMocks.captureStream.mockReset().mockImplementation(async function* () {
      yield {
        payload: Buffer.alloc(32000, 32),
        format: { sample_rate_hz: 16000, channels: 1, encoding: 'pcm_s16le' },
        timestamp_ms: 0,
      };
    });
    processMocks.cameraStart
      .mockReset()
      .mockResolvedValue({ scene: 'scene', source: 'source', virtualCamStarted: true });
    processMocks.cameraStop.mockReset().mockResolvedValue(undefined);
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      message: 'human required',
    });
    vi.mocked(safeExec).mockReset().mockReturnValue('');
    processMocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit('close', 0));
      return child as never;
    });
  });

  it('protects public native speech before process creation', async () => {
    await expect(speak('sensitive speech')).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(processMocks.spawn).not.toHaveBeenCalled();
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    await expect(trusted(() => speak('sensitive speech'))).resolves.toMatchObject({ ok: true });
    expect(processMocks.spawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(auditChain.record).mock.calls)).not.toContain(
      'sensitive speech'
    );
  });

  it('awaits native speech errors without detached throws or audible retries', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    processMocks.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() =>
        child.emit('error', new Error('device unavailable after attempted speech'))
      );
      return child as never;
    });
    await expect(trusted(() => speak('hello', { silent: false }))).rejects.toMatchObject({
      adfControlFlow: 'preflight',
    });
    expect(processMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('protects direct registered custom speech handles without allowing a second attempted call on failure', async () => {
    const speakAdapter = vi.fn(() => {
      throw new Error('failure after audible attempt');
    });
    const unregister = registerVoicePlaybackPlatformAdapter('custom-test', { speak: speakAdapter });
    try {
      const adapter = resolveVoicePlaybackPlatformAdapter('custom-test');
      await expect(adapter.speak!('hello', 100)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(speakAdapter).not.toHaveBeenCalled();
      vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
      await expect(trusted(() => adapter.speak!('hello', 100))).rejects.toMatchObject({
        adfControlFlow: 'preflight',
      });
      expect(speakAdapter).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('gates builtin actuator to physical bridge playback exactly once and does not retry audible errors', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
      await trusted(() =>
        performPlayback(
          'hello',
          { engineId: 'local_say', language: 'en', voice: 'default', rate: 100 },
          'active/shared/tmp/input.wav'
        )
      );
      expect(enforceApprovalGate).toHaveBeenCalledTimes(1);
      expect(safeExec).toHaveBeenCalledTimes(1);
      vi.mocked(safeExec)
        .mockClear()
        .mockImplementation(() => {
          throw new Error('ambiguous device timeout');
        });
      await expect(
        trusted(() =>
          performPlayback(
            'hello',
            { engineId: 'local_say', language: 'en', voice: 'default', rate: 100 },
            'active/shared/tmp/input.wav'
          )
        )
      ).rejects.toMatchObject({ adfControlFlow: 'preflight' });
      expect(safeExec).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    }
  });

  it.each(['darwin', 'win32'] as const)(
    'stops multi-output production playback before the first audible effect on supported %s',
    async (supportedPlatform) => {
      // Platform capability selection precedes the batch gate. Pin a supported
      // fixture backend so Linux CI reaches the checkpoint being tested.
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: supportedPlatform });
      try {
        const bridge = createVirtualAudioOutputPlaybackBridge();
        await expect(
          withExternalOperationPipelineRun('run', () =>
            trusted(() =>
              bridge.playOnOutputs(['one', 'two'], { source_path: 'active/shared/tmp/input.wav' })
            )
          )
        ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
        expect(safeExec).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    }
  );

  it('keeps unsupported Linux playback fail-closed before any audible effect', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      const bridge = createVirtualAudioOutputPlaybackBridge();
      await expect(
        withExternalOperationPipelineRun('run', () =>
          trusted(() =>
            bridge.playOnOutputs(['one', 'two'], { source_path: 'active/shared/tmp/input.wav' })
          )
        )
      ).rejects.toThrow('unsupported platform linux');
      expect(safeExec).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('protects registered remote STT handles while local-only transcription remains automatic', async () => {
    const transcribe = vi.fn(async () => ({ text: 'words', backend: 'remote-test' }));
    const unregisterRemote = registerSpeechToTextBridge({ name: 'remote-test', transcribe });
    const unregisterLocal = registerSpeechToTextBridge({
      name: 'local-test',
      capabilities: { timestamps: false, granularity: 'none', local_only: true },
      transcribe,
    });
    try {
      const remote = getSpeechToTextBridges().find((b) => b.name === 'remote-test')!;
      const local = getSpeechToTextBridges().find((b) => b.name === 'local-test')!;
      await expect(remote.transcribe({ audioPath: 'active/shared/tmp/audio.wav' })).rejects.toThrow(
        'EXTERNAL_APPROVAL_REQUIRED'
      );
      expect(transcribe).not.toHaveBeenCalled();
      await expect(
        local.transcribe({ audioPath: 'active/shared/tmp/audio.wav' })
      ).resolves.toMatchObject({ text: 'words' });
      expect(transcribe).toHaveBeenCalledTimes(1);
    } finally {
      unregisterRemote();
      unregisterLocal();
    }
  });

  it('does not let custom adapters forge builtin metadata to skip provider admission', async () => {
    const playback = vi.fn(async () => ({ outputs: [] }));
    const unregister = registerVoicePlaybackPlatformAdapter(
      'forged-builtin',
      { playViaOutputBridge: playback },
      { provenance: 'builtin', source: 'voice-runtime-helpers' }
    );
    try {
      await expect(
        resolveVoicePlaybackPlatformAdapter('forged-builtin').playViaOutputBridge!(
          'hello',
          undefined,
          { engineId: 'local_say', language: 'en', voice: 'default', rate: 100 }
        )
      ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(playback).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('binds changed audio bytes to a different pending-approval payload', async () => {
    const transcribe = vi.fn(async () => ({ text: 'words', backend: 'remote-test' }));
    const unregister = registerSpeechToTextBridge({ name: 'mutable-audio', transcribe });
    try {
      const bridge = getSpeechToTextBridges().find((b) => b.name === 'mutable-audio')!;
      const authority = {
        agentId: 'owner',
        tenantSlug: 'acme',
        invocationId: 'same-pending-call',
        hasHuman: true,
      };
      await expect(
        withExternalOperationAuthority(
          () => authority,
          () => bridge.transcribe({ audioPath: 'active/shared/tmp/audio.wav' })
        )
      ).rejects.toThrow();
      const oldHash = vi.mocked(enforceApprovalGate).mock.calls[0]![0].payload!.effect_hash;
      vi.mocked(enforceApprovalGate).mockImplementation((input) =>
        input.payload!.effect_hash === oldHash
          ? { allowed: true, status: 'approved' }
          : { allowed: false, status: 'pending', message: 'effect_mismatch' }
      );
      processMocks.audioBytes = 'replaced pending audio';
      await expect(
        withExternalOperationAuthority(
          () => authority,
          () => bridge.transcribe({ audioPath: 'active/shared/tmp/audio.wav' })
        )
      ).rejects.toThrow('effect_mismatch');
      expect(transcribe).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('passes an immutable input snapshot despite mutation of the original caller object', async () => {
    const transcribe = vi.fn(async (_input: { audioPath: string; language?: string }) => ({
      text: 'words',
      backend: 'frozen-input',
    }));
    const unregister = registerSpeechToTextBridge({ name: 'frozen-input', transcribe });
    try {
      const bridge = getSpeechToTextBridges().find((b) => b.name === 'frozen-input')!;
      const input = { audioPath: 'active/shared/tmp/audio.wav', language: 'en' };
      vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
      await withExternalOperationAuthority(
        () => {
          input.audioPath = 'active/shared/tmp/replaced.wav';
          input.language = 'ja';
          return {
            agentId: 'owner',
            tenantSlug: 'acme',
            invocationId: randomUUID(),
            hasHuman: true,
          };
        },
        () => bridge.transcribe(input)
      );
      expect(transcribe).toHaveBeenCalledWith({
        audioPath: 'active/shared/tmp/audio.wav',
        language: 'en',
      });
      expect(Object.isFrozen(transcribe.mock.calls[0]![0])).toBe(true);
    } finally {
      unregister();
    }
  });

  it('rejects opaque render plus playback before the first provider attempt in a resumable run', async () => {
    const render = vi.fn(() => 'active/shared/tmp/input.wav');
    const playback = vi.fn(async () => ({ outputs: [{ status: 'played' }] }));
    const platform = process.platform;
    const unregister = registerVoicePlaybackPlatformAdapter('compound-test', {
      renderNativeArtifact: render,
      playViaOutputBridge: playback,
    });
    Object.defineProperty(process, 'platform', { configurable: true, value: 'compound-test' });
    try {
      await expect(
        withExternalOperationPipelineRun('compound-run', () =>
          trusted(() =>
            performPlayback('hello', {
              engineId: 'local_say',
              language: 'en',
              voice: 'default',
              rate: 100,
            })
          )
        )
      ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
      expect(render).not.toHaveBeenCalled();
      expect(playback).not.toHaveBeenCalled();
      expect(enforceApprovalGate).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      unregister();
    }
  });

  it('refuses bytes changed during admission before physical output or artifact opening', async () => {
    vi.mocked(enforceApprovalGate).mockImplementation(() => {
      processMocks.audioBytes = 'changed while admission was checked';
      return { allowed: true, status: 'approved' };
    });
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      const bridge = createVirtualAudioOutputPlaybackBridge();
      await expect(
        trusted(() =>
          bridge.playOnOutputs(['Governed Output'], { source_path: 'active/shared/tmp/input.wav' })
        )
      ).rejects.toThrow('VOICE_AUDIO_CHANGED');
      expect(safeExec).not.toHaveBeenCalled();
      processMocks.audioBytes = 'original artifact bytes';
      await expect(
        trusted(() =>
          resolveVoicePlaybackPlatformAdapter('darwin').openArtifact!('active/shared/tmp/input.wav')
        )
      ).rejects.toThrow('VOICE_AUDIO_CHANGED');
      expect(safeExec).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    }
  });

  it('protects native microphone capture and opaque recording commands before accessing either', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    const request = {
      action: 'record_voice_sample' as const,
      request_id: 'stable-mic-request',
      sample_id: 'sample',
      duration_sec: 1,
      output_path: 'active/shared/tmp/recorded.wav',
      recording_countdown_sec: 0,
    };
    try {
      await expect(recordVoiceSample(request, {})).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(processMocks.captureStream).not.toHaveBeenCalled();
      vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
      await expect(trusted(() => recordVoiceSample(request, {}))).resolves.toMatchObject({
        status: 'succeeded',
        selected_input_device: 'Governed Microphone',
      });
      expect(processMocks.captureStream).toHaveBeenCalledTimes(1);
      vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: false, status: 'pending' });
      await expect(
        recordVoiceSample(request, { KYBERION_AUDIO_RECORD_COMMAND: 'record --out {{output}}' })
      ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(safeExecShellScript).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    }
  });

  it('binds camera target and video content, blocks before output, and never retries a failed start', async () => {
    const input = {
      action: 'output_to_virtual_camera' as const,
      video_path: 'active/shared/tmp/input.mp4',
      backend: 'auto',
      obs_host: 'video.example.invalid',
      obs_password: 'private-camera-password',
    };
    await expect(outputToVirtualCamera(input)).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    expect(processMocks.cameraStart).not.toHaveBeenCalled();
    vi.mocked(enforceApprovalGate).mockImplementation(() => {
      processMocks.audioBytes = 'changed video';
      return { allowed: true, status: 'approved' };
    });
    await expect(trusted(() => outputToVirtualCamera(input))).rejects.toThrow(
      'VOICE_VIDEO_CHANGED'
    );
    expect(processMocks.cameraStart).not.toHaveBeenCalled();
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    processMocks.cameraStart.mockRejectedValue(new Error('unknown after camera started'));
    await expect(trusted(() => outputToVirtualCamera(input))).rejects.toMatchObject({
      adfControlFlow: 'preflight',
    });
    expect(processMocks.cameraStart).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(auditChain.record).mock.calls)).not.toContain(
      'private-camera-password'
    );
    await trusted(() => outputToVirtualCamera({ ...input, stop: true }));
    expect(processMocks.cameraStop).toHaveBeenCalledTimes(1);
    processMocks.cameraStart.mockResolvedValue({
      scene: 'scene',
      source: 'source',
      virtualCamStarted: false,
    });
    await expect(trusted(() => outputToVirtualCamera(input))).rejects.toThrow(
      'VOICE_CAMERA_UNVERIFIED'
    );
    expect(installObsVirtualCameraOutputBridge).toHaveBeenCalledTimes(1);
    const attempted = processMocks.cameraStart.mock.calls.length;
    await expect(
      trusted(() => outputToVirtualCamera({ ...input, obs_host: 'different.example.invalid' }))
    ).rejects.toThrow('VOICE_CAMERA_CONFIG_DRIFT');
    expect(processMocks.cameraStart).toHaveBeenCalledTimes(attempted);
  });

  it('rejects a remote render fallback before starting a local render/playback compound', async () => {
    processMocks.useRemoteFallback = true;
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      await expect(
        withExternalOperationPipelineRun('fallback-run', () =>
          trusted(() =>
            performPlayback('hello', {
              engineId: 'local_say',
              language: 'en',
              voice: 'default',
              rate: 100,
            })
          )
        )
      ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
      expect(safeExec).not.toHaveBeenCalled();
      expect(enforceApprovalGate).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    }
  });

  it('does not report a synthetic remote transcript as confirmed speech while allowing empty silence text', async () => {
    const transcribe = vi.fn(async () => ({ text: '', backend: 'remote', synthetic: true }));
    const unregister = registerSpeechToTextBridge({ name: 'receipt-test', transcribe });
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    try {
      const bridge = getSpeechToTextBridges().find((b) => b.name === 'receipt-test')!;
      await expect(
        trusted(() => bridge.transcribe({ audioPath: 'active/shared/tmp/audio.wav' }))
      ).rejects.toThrow('VOICE_TRANSCRIPT_UNVERIFIED');
      transcribe.mockResolvedValue({ text: '', backend: 'remote', synthetic: false });
      await expect(
        trusted(() => bridge.transcribe({ audioPath: 'active/shared/tmp/audio.wav' }))
      ).resolves.toMatchObject({ text: '', backend: 'remote' });
    } finally {
      unregister();
    }
  });

  it('freezes reviewed custom renderer options before calling the provider', async () => {
    const render = vi.fn(async (_text: string, _options: unknown) => 'active/shared/tmp/input.wav');
    const unregister = registerVoicePlaybackPlatformAdapter('snapshot-renderer', {
      renderNativeArtifact: render,
    });
    const options = {
      requestId: 'stable-render',
      voice: 'reviewed-voice',
      rate: 100,
      language: 'en',
      format: 'wav' as const,
    };
    vi.mocked(enforceApprovalGate).mockImplementation(() => {
      options.voice = 'mutated-voice';
      return { allowed: true, status: 'approved' };
    });
    vi.mocked(safeExec).mockReturnValue('1');
    try {
      await trusted(() =>
        resolveVoicePlaybackPlatformAdapter('snapshot-renderer').renderNativeArtifact!(
          'hello',
          options
        )
      );
      expect(render.mock.calls[0]![1]).toMatchObject({ voice: 'reviewed-voice' });
      expect(Object.isFrozen(render.mock.calls[0]![1])).toBe(true);
    } finally {
      unregister();
    }
  });

  it('does not accept a zero-exit microphone shell command that leaves the sample unchanged', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    await expect(
      trusted(() =>
        recordVoiceSample(
          {
            action: 'record_voice_sample',
            request_id: 'noop-record',
            sample_id: 'sample',
            duration_sec: 1,
            output_path: 'active/shared/tmp/input.wav',
          },
          { KYBERION_AUDIO_RECORD_COMMAND: 'noop' }
        )
      )
    ).rejects.toThrow('VOICE_RECORDING_UNVERIFIED');
    expect(safeExecShellScript).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch an OS executable through the audio artifact opener', () => {
    expect(() =>
      resolveVoicePlaybackPlatformAdapter('darwin').openArtifact!('active/shared/tmp/input.command')
    ).toThrow('VOICE_ARTIFACT_FORMAT');
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(safeExec).not.toHaveBeenCalled();
  });
});
