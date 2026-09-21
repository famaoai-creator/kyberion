import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pathResolver } = await import('@agent/core/path-resolver');
const { safeMkdir, safeRmSync, safeWriteFile } = await import('@agent/core/secure-io');
const { getVoiceEngineRecord } = await import('@agent/core/voice-engine-registry');
const { registerSeamCalibrationAdapter, runSeamCalibration } =
  await import('@agent/core/seam-calibration');
const { createVoiceTtsEngineCalibrationAdapter, voiceTtsEngineCalibrationAdapter } =
  await import('./voice-tts-engine.js');
type RenderRequest = import('./voice-tts-engine.js').VoiceTtsRenderRequest;

const outRoot = pathResolver.sharedTmp('voice-tts-calibration-adapter-test');
const ENGINES = ['local_say', 'kokoro', 'pocket_tts', 'gemini_tts'].map((id) =>
  getVoiceEngineRecord(id)
);

/** Mocked engines: write N bytes instead of synthesising; never touches audio tools. */
function fakeRender(bytes: Record<string, number>) {
  return vi.fn(async (request: RenderRequest) => {
    const size = bytes[request.engine.engine_id];
    if (size === undefined) throw new Error(`${request.engine.engine_id} unavailable`);
    safeMkdir(pathResolver.sharedTmp('voice-tts-calibration-adapter-test'), { recursive: true });
    safeWriteFile(request.outputPath, 'x'.repeat(size));
    return request.outputPath;
  });
}

describe('voice-tts-engine calibration adapter', () => {
  beforeEach(() => safeRmSync(outRoot, { recursive: true, force: true }));
  afterEach(() => safeRmSync(outRoot, { recursive: true, force: true }));

  it('lists engines with the live hard filter (language, adapter, platform)', async () => {
    const adapter = createVoiceTtsEngineCalibrationAdapter({
      engines: () => ENGINES,
      platform: () => 'linux',
    });
    const candidates = await adapter.listCandidates({ text: 'こんにちは' });
    expect(candidates).toEqual([
      { id: 'local_say', eligible: true, unmet: [] },
      { id: 'kokoro', eligible: true, unmet: [] },
      { id: 'pocket_tts', eligible: false, unmet: ['language ja'] },
      {
        id: 'gemini_tts',
        eligible: false,
        unmet: ['no runtime adapter (external_provider)'],
      },
    ]);
    await expect(adapter.listCandidates({ text: '  ' })).rejects.toThrow(/input.text is required/);
  });

  it('requires explicit opt-in for engines that leave the machine', () => {
    expect(voiceTtsEngineCalibrationAdapter.requiresExplicitOptIn?.('gemini_tts')).toBe(true);
    expect(voiceTtsEngineCalibrationAdapter.requiresExplicitOptIn?.('open_voice_clone')).toBe(true);
    expect(voiceTtsEngineCalibrationAdapter.requiresExplicitOptIn?.('kokoro')).toBe(false);
    expect(voiceTtsEngineCalibrationAdapter.requiresExplicitOptIn?.('nope')).toBe(true);
  });

  it('maps only measurable traits using the policy trait names', () => {
    expect(voiceTtsEngineCalibrationAdapter.trait_mappings).toEqual({
      latency: { metric: 'latency_ms', higher_is_better: false },
    });
  });

  it('renders each engine alone and reports artifacts + cheap metrics', async () => {
    const render = fakeRender({ local_say: 4096, kokoro: 8192 });
    const adapter = createVoiceTtsEngineCalibrationAdapter({
      engines: () => ENGINES,
      platform: () => 'linux',
      render,
      probeDurationSec: (artifact) => (artifact.includes('kokoro') ? 2 : 1.5),
    });
    const dispose = registerSeamCalibrationAdapter(adapter);
    let tick = 0;
    try {
      const report = await runSeamCalibration({
        seam: 'voice-tts-engine',
        input: { text: 'Good morning, here is the plan.', format: 'wav' },
        outRoot,
        runId: 'unit',
        now: () => (tick += 100),
      });
      // pocket_tts speaks en, so it is tried too (and fails in this double).
      expect(render.mock.calls.map(([request]) => request.engine.engine_id)).toEqual([
        'local_say',
        'kokoro',
        'pocket_tts',
      ]);
      expect(render.mock.calls.every(([request]) => request.language === 'en')).toBe(true);
      const byId = Object.fromEntries(report.providers.map((p) => [p.provider_id, p]));
      expect(byId.local_say!.metrics_mean).toEqual({ audio_bytes: 4096, duration_sec: 1.5 });
      expect(byId.kokoro!.metrics_mean).toEqual({ audio_bytes: 8192, duration_sec: 2 });
      expect(byId.kokoro!.runs[0]!.output?.artifact_path).toMatch(/kokoro-0\.wav$/);
      expect(byId.gemini_tts!.eligible).toBe(false);
      expect(byId.pocket_tts!.success_rate).toBe(0);
      expect(report.suggested_traits.latency).toBeDefined();
    } finally {
      dispose();
    }
  });

  it('reports a failing engine as a failure, not as another engine', async () => {
    const adapter = createVoiceTtsEngineCalibrationAdapter({
      engines: () => ENGINES,
      platform: () => 'linux',
      render: fakeRender({ local_say: 2048 }),
      probeDurationSec: () => undefined,
    });
    const dispose = registerSeamCalibrationAdapter(adapter);
    try {
      const report = await runSeamCalibration({
        seam: 'voice-tts-engine',
        input: { text: 'Hello' },
        outRoot,
        runId: 'failing',
      });
      const kokoro = report.providers.find((p) => p.provider_id === 'kokoro')!;
      expect(kokoro.success_rate).toBe(0);
      expect(kokoro.runs[0]!.error).toBe('provider trial failed');
      const local = report.providers.find((p) => p.provider_id === 'local_say')!;
      expect(local.metrics_mean).toEqual({ audio_bytes: 2048 });
    } finally {
      dispose();
    }
  });
});
