import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  stop: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  readRange: vi.fn(),
  exec: vi.fn(),
}));
vi.mock('../secure-io.js', () => ({
  assertSafeRepositoryPath: (value: string) => value,
  safeLstat: mock.stat,
  safeReaddir: () => [],
  safeReadFile: mock.read,
  safeReadFileRange: mock.readRange,
  buildSafeExecEnv: (env: Record<string, string>) => env,
  assertGovernedExec: mock.exec,
}));
vi.mock('./observation.js', () => ({ resolvePerceptionScope: () => ({ tier: 'public' }) }));
vi.mock('../managed-process.js', () => ({
  spawnManagedProcess: mock.spawn,
  stopManagedProcess: mock.stop,
}));
import {
  analyzeAudio,
  alignSpeakerSegments,
  validateAudioAnalysisResult,
  validateDiarizationConfig,
} from './audio-analysis.js';

function result(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'pyannote-community-1+mediapipe-yamnet',
    speakers: [{ start_sec: 0, end_sec: 1, speaker_id: 'SPEAKER_00' }],
    events: [{ start_sec: 1, end_sec: 2, label: 'Applause', confidence: 0.9 }],
    warnings: [],
    ...overrides,
  };
}
function config() {
  return {
    pipeline: {
      name: 'pyannote.audio.pipelines.SpeakerDiarization',
      params: {
        segmentation: '$model/segmentation',
        embedding: '$model/embedding',
        plda: '$model/plda',
        clustering: 'VBxClustering',
        embedding_batch_size: 32,
      },
    },
    params: { clustering: { threshold: 0.5 } },
  };
}
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.stat.mockReturnValue({ isDirectory: () => true, isFile: () => true, size: 1024 });
});
afterEach(() => vi.useRealTimers());

describe('audio perception validation', () => {
  it('requires content authorization before starting native inference', async () => {
    mock.readRange.mockImplementationOnce(() => {
      throw new Error('content denied');
    });
    await expect(
      analyzeAudio({ path: 'audio.wav', events: true, audioModel: 'model.tflite' })
    ).rejects.toThrow('content denied');
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it('keeps actual speaker labels and sound events without fabricating confidence', () => {
    expect(validateAudioAnalysisResult(result())).toEqual(result());
    expect(validateAudioAnalysisResult(result()).speakers[0]).not.toHaveProperty('confidence');
  });
  it.each([NaN, Infinity, -1, 601, '1'])('rejects invalid interval start %s', (start_sec) => {
    expect(() =>
      validateAudioAnalysisResult(
        result({ speakers: [{ start_sec, end_sec: 2, speaker_id: 'speaker' }] })
      )
    ).toThrow('timestamp');
  });
  it('rejects reverse intervals, unbounded labels, malformed shapes and bad scores', () => {
    for (const entry of [
      result({ speakers: [{ start_sec: 2, end_sec: 1, speaker_id: 'speaker' }] }),
      result({ speakers: [{ start_sec: 0, end_sec: 1, speaker_id: '../../person' }] }),
      result({ events: [{ start_sec: 0, end_sec: 1, label: 'x'.repeat(257), confidence: 1 }] }),
      result({ events: [{ start_sec: 0, end_sec: 1, label: 'Music', confidence: NaN }] }),
      result({ warnings: Array(33).fill('warning') }),
      result({ speakers: Array(10001).fill({ start_sec: 0, end_sec: 1, speaker_id: 'speaker' }) }),
      { provider: 'fake' },
    ])
      expect(() => validateAudioAnalysisResult(entry)).toThrow('AUDIO_ANALYSIS_INVALID');
  });
  it('allows only bundled Community-1 model references and bounded hyperparameters', () => {
    const validated = validateDiarizationConfig(config(), '/bundle') as {
      pipeline: { params: Record<string, unknown> };
    };
    expect(validated.pipeline.params.embedding).toEqual({
      checkpoint: '/bundle',
      subfolder: 'embedding',
      token: false,
    });
    expect(validated.pipeline.params.embedding_batch_size).toBe(4);
    const remote = config();
    remote.pipeline.params.embedding = 'other-org/remote-model';
    expect(() => validateDiarizationConfig(remote, '/bundle')).toThrow('bundled');
    const plugin = config();
    plugin.pipeline.name = 'untrusted.module.Plugin';
    expect(() => validateDiarizationConfig(plugin, '/bundle')).toThrow('built-in');
    expect(() =>
      validateDiarizationConfig({ ...config(), preprocessors: { arbitrary: 'code' } }, '/bundle')
    ).toThrow('root options');
  });
});

describe('speaker alignment', () => {
  it('aligns positive overlaps, omits guesses at boundaries, preserves overlap ambiguity', () => {
    const speakers = [
      { start_sec: 0, end_sec: 2, speaker_id: 'A' },
      { start_sec: 1, end_sec: 3, speaker_id: 'B' },
    ];
    const aligned = alignSpeakerSegments(
      [
        { start_sec: 0, end_sec: 1, text: 'first' },
        { start_sec: 1, end_sec: 2, text: 'overlap' },
        { start_sec: 3, end_sec: 4, text: 'unattributed' },
      ],
      speakers
    );
    expect(aligned[0]).toMatchObject({
      speaker_id: 'A',
      speaker_status: 'tentative',
      speaker_source: 'diarization',
    });
    expect(aligned[1].speaker_ids).toEqual(['A', 'B']);
    expect(aligned[1]).not.toHaveProperty('speaker_id');
    expect(aligned[2].speaker_ids).toEqual([]);
    expect(aligned[2]).not.toHaveProperty('speaker_status');
    expect(aligned[0]).not.toHaveProperty('person_ref');
  });
});

describe('local audio process boundary', () => {
  it('fails before launching when selected assets or processing modes are missing', async () => {
    await expect(analyzeAudio({ path: 'input.wav' })).rejects.toThrow('select');
    await expect(analyzeAudio({ path: 'input.wav', diarize: true })).rejects.toThrow(
      'AUDIO_MODEL_MISSING'
    );
    await expect(analyzeAudio({ path: 'input.wav', events: true })).rejects.toThrow(
      'AUDIO_MODEL_MISSING'
    );
    await expect(
      analyzeAudio({ path: 'input.mp3', events: true, audioModel: 'yamnet.tflite' })
    ).rejects.toThrow('WAV');
    await expect(
      analyzeAudio({
        path: 'input.wav',
        events: true,
        audioModel: 'yamnet.tflite',
        timeoutMs: Infinity,
      })
    ).rejects.toThrow('timeoutMs');
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it('sends paths on stdin and isolates offline inference without a shell', async () => {
    const process = child();
    mock.spawn.mockReturnValue({ child: process });
    const pending = analyzeAudio({ path: 'input.wav', events: true, audioModel: 'yamnet.tflite' });
    process.stdout.emit(
      'data',
      Buffer.from(JSON.stringify(result({ speakers: [], provider: 'mediapipe-yamnet' })))
    );
    process.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ provider: 'mediapipe-yamnet' });
    const spec = mock.spawn.mock.calls[0][0];
    expect(spec.args[0]).toBe('-I');
    expect(spec.spawnOptions.shell).toBe(false);
    expect(spec.spawnOptions.env).toMatchObject({
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    });
    expect(JSON.parse(process.stdin.end.mock.calls[0][0])).toMatchObject({
      audio: expect.stringContaining('input.wav'),
      audio_model: expect.stringContaining('yamnet.tflite'),
    });
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it('terminates an inference that exceeds its deadline', async () => {
    vi.useFakeTimers();
    const process = child();
    mock.spawn.mockReturnValue({ child: process });
    const pending = analyzeAudio({
      path: 'input.wav',
      events: true,
      audioModel: 'yamnet.tflite',
      timeoutMs: 10,
    });
    const assertion = expect(pending).rejects.toThrow('AUDIO_ANALYSIS_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it('rejects excessive, partial, or non-JSON helper output', async () => {
    const process = child();
    mock.spawn.mockReturnValue({ child: process });
    const pending = analyzeAudio({ path: 'input.wav', events: true, audioModel: 'yamnet.tflite' });
    process.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(pending).rejects.toThrow('OUTPUT_LIMIT');
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    const second = child();
    mock.spawn.mockReturnValue({ child: second });
    const malformed = analyzeAudio({
      path: 'input.wav',
      events: true,
      audioModel: 'yamnet.tflite',
    });
    second.stdout.emit('data', Buffer.from('not-json'));
    second.emit('close', 0);
    await expect(malformed).rejects.toThrow();
  });
  it('preserves dependency errors instead of emitting a successful empty result', async () => {
    const process = child();
    mock.spawn.mockReturnValue({ child: process });
    const pending = analyzeAudio({ path: 'input.wav', events: true, audioModel: 'yamnet.tflite' });
    process.stderr.emit('data', Buffer.from('[AUDIO_DEPENDENCY_MISSING] Install mediapipe'));
    process.emit('close', 1);
    await expect(pending).rejects.toThrow('AUDIO_DEPENDENCY_MISSING');
  });
});
