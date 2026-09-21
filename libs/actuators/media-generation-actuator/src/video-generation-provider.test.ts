import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureFetch: vi.fn(),
  record: vi.fn(),
  probeServiceRuntime: vi.fn(),
}));

vi.mock('@agent/core/audit-chain', () => ({
  auditChain: { record: (...args: unknown[]) => mocks.record(...args) },
}));

vi.mock('@agent/core/service-runtime-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/service-runtime-registry')>(
    '@agent/core/service-runtime-registry'
  );
  return { ...actual, probeServiceRuntime: mocks.probeServiceRuntime };
});

vi.mock('@agent/core/network', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/network')>('@agent/core/network');
  return { ...actual, secureFetch: mocks.secureFetch };
});

import {
  applyVideoProviderSelection,
  createVideoGenerationProvider,
  isDirectVideoGenerationBackend,
  listVideoGenerationCandidates,
  normalizeVideoGenerationRequest,
  resolveVideoGenerationBackend,
} from './video-generation-provider.js';
import {
  getMediaBackendRecord,
  resetMediaBackendAvailabilityCache,
} from '@agent/core/media-backend-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { setSeamSelectionRule } from '@agent/core/seam-selection-rules';

describe('video generation provider abstraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_RUNWAY_API_KEY;
    delete process.env.RUNWAYML_API_SECRET;
  });

  it('resolves a governed API backend without exposing provider details to callers', () => {
    const backend = resolveVideoGenerationBackend({
      backend_id: 'media-generation.runway.gen4.5',
    });

    expect(isDirectVideoGenerationBackend(backend)).toBe(true);
    expect(backend.model).toBe('gen4.5');
    expect(normalizeVideoGenerationRequest({ prompt: 'A quiet ocean at dawn' }, backend)).toEqual(
      expect.objectContaining({ prompt: 'A quiet ocean at dawn', model: 'gen4.5' })
    );
  });

  it('submits, polls, and downloads a Runway task through the common contract', async () => {
    process.env.KYBERION_RUNWAY_API_KEY = 'test-runway-key';
    mocks.secureFetch
      .mockResolvedValueOnce({ id: 'runway-task-1' })
      .mockResolvedValueOnce({
        id: 'runway-task-1',
        status: 'SUCCEEDED',
        output: ['https://cdn.example.test/video.mp4'],
      })
      .mockResolvedValueOnce(Buffer.from('video-bytes'));

    const backend = getMediaBackendRecord('media-generation.runway.gen4.5', 'video');
    const provider = createVideoGenerationProvider(backend);
    const request = normalizeVideoGenerationRequest(
      { prompt: 'A slow camera move', duration: 5, resolution: '1280:720' },
      backend
    );
    const submission = await provider.submit(request);
    const status = await provider.status(submission.provider_job_id);
    const bytes = await provider.download(status);

    expect(submission).toEqual(
      expect.objectContaining({ provider_job_id: 'runway-task-1', provider: 'runway' })
    );
    expect(status).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        output_url: 'https://cdn.example.test/video.mp4',
      })
    );
    expect(bytes).toEqual(Buffer.from('video-bytes'));
    expect(mocks.secureFetch).toHaveBeenCalledTimes(3);
    expect(mocks.secureFetch.mock.calls[0][0]).toEqual(
      expect.objectContaining({ url: expect.stringContaining('/image_to_video') })
    );
    expect(mocks.secureFetch.mock.calls[1][0]).toEqual(
      expect.objectContaining({ url: expect.stringContaining('/tasks/runway-task-1') })
    );
  });

  it('rejects direct generation when the provider credential is missing', async () => {
    const backend = getMediaBackendRecord('media-generation.runway.gen4.5', 'video');
    const provider = createVideoGenerationProvider(backend);
    await expect(
      provider.submit(normalizeVideoGenerationRequest({ prompt: 'test' }, backend))
    ).rejects.toThrow(/KYBERION_RUNWAY_API_KEY/);
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('rejects non-object provider responses before projecting task fields', async () => {
    process.env.KYBERION_RUNWAY_API_KEY = 'test-runway-key';
    mocks.secureFetch.mockResolvedValueOnce([]);

    const backend = getMediaBackendRecord('media-generation.runway.gen4.5', 'video');
    const provider = createVideoGenerationProvider(backend);

    await expect(
      provider.submit(normalizeVideoGenerationRequest({ prompt: 'test' }, backend))
    ).rejects.toThrow('Video provider response must be a JSON object');
  });

  it('rejects non-binary download responses before writing an artifact', async () => {
    process.env.KYBERION_RUNWAY_API_KEY = 'test-runway-key';
    mocks.secureFetch.mockResolvedValueOnce({ not: 'binary' });

    const backend = getMediaBackendRecord('media-generation.runway.gen4.5', 'video');
    const provider = createVideoGenerationProvider(backend);

    await expect(
      provider.download({
        provider_job_id: 'runway-task-1',
        provider: 'runway',
        status: 'succeeded',
        output_url: 'https://cdn.example.test/video.mp4',
      })
    ).rejects.toThrow('Video provider download response must be binary data');
  });
});

describe('purpose-driven video provider selection', () => {
  const CREDENTIALS = [
    'KYBERION_GEMINI_VIDEO_API_KEY',
    'KYBERION_GEMINI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'KYBERION_OPENAI_VIDEO_API_KEY',
    'OPENAI_API_KEY',
    'KYBERION_RUNWAY_API_KEY',
    'RUNWAYML_API_SECRET',
    'KYBERION_MINIMAX_VIDEO_API_KEY',
    'MINIMAX_API_KEY',
  ];
  const rulesDir = path.join(
    pathResolver.sharedTmp('video-selection-rules-test'),
    String(process.pid)
  );
  const withKeys = (...names: string[]) => {
    for (const name of names) vi.stubEnv(name, 'test-key');
  };
  const byId = (candidates: Awaited<ReturnType<typeof listVideoGenerationCandidates>>) =>
    Object.fromEntries(candidates.map((c) => [c.id, c.unmet ?? []]));

  beforeEach(() => {
    mocks.record.mockClear();
    mocks.probeServiceRuntime.mockReset().mockResolvedValue({ available: true, reason: 'mocked' });
    vi.stubEnv('MISSION_ID', '');
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', path.join(rulesDir, 'rules.json'));
    for (const name of CREDENTIALS) vi.stubEnv(name, '');
    resetMediaBackendAvailabilityCache();
    safeRmSync(rulesDir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetMediaBackendAvailabilityCache();
    safeRmSync(rulesDir, { recursive: true, force: true });
  });

  it('lists text-to-video backends with what each cannot do (never hyperframes)', async () => {
    withKeys('OPENAI_API_KEY');
    const unmet = byId(await listVideoGenerationCandidates({ prompt: 'x' }));
    expect(Object.keys(unmet)).not.toContain('video.hyperframes_cli');
    expect(unmet['media-generation.openai.sora-2']).toEqual([]);
    expect(unmet['media-generation.google.veo-3.1']?.[0]).toMatch(
      /^unavailable \(required credential/
    );
    expect(unmet['media-generation.runway.gen4.5']).toEqual([
      'first_frame_image (the Runway adapter uses image_to_video)',
    ]);
    expect(unmet['media-generation.comfyui.video']).toEqual([
      'needs params.workflow, workflow_path or video_adf (ComfyUI runs workflows)',
    ]);
  });

  it('turns requested features into hard requirements', async () => {
    withKeys('GEMINI_API_KEY', 'OPENAI_API_KEY', 'RUNWAYML_API_SECRET', 'MINIMAX_API_KEY');
    const unmet = byId(
      await listVideoGenerationCandidates({
        prompt: 'x',
        aspect_ratio: '9:16',
        generate_audio: true,
        first_frame_image: 'https://example.test/frame.png',
      })
    );
    expect(unmet['media-generation.google.veo-3.1']).toEqual([
      'first_frame_image must be a data: URI',
    ]);
    expect(unmet['media-generation.openai.sora-2']).toEqual([
      'first_frame_image must be a data: URI',
      'aspect_ratio (the openai_sora adapter sends resolution only)',
    ]);
    expect(unmet['media-generation.runway.gemini-omni-flash']).toEqual([]);
    expect(unmet['media-generation.runway.gen4.5']).toEqual(['generate_audio (no native audio)']);
    expect(unmet['media-generation.minimax.hailuo-2.3']).toEqual([
      'aspect_ratio (the minimax_hailuo adapter sends resolution only)',
      'generate_audio (no native audio)',
    ]);
  });

  it('writes the purpose winner back as backend_id and records the decision', async () => {
    withKeys('GEMINI_API_KEY', 'OPENAI_API_KEY');
    const selected = await applyVideoProviderSelection({ prompt: 'x', purpose: 'quality' });
    expect(selected.backend_id).toBe('media-generation.google.veo-3.1');
    expect(isDirectVideoGenerationBackend(resolveVideoGenerationBackend(selected))).toBe(true);
    expect(mocks.record.mock.calls.at(-1)?.[0]?.metadata).toEqual(
      expect.objectContaining({ strategy: 'purpose', purpose: 'quality', decision_key: 'quality' })
    );

    const privateRun = await applyVideoProviderSelection({
      prompt: 'x',
      purpose: 'privacy',
      workflow: { '1': { class_type: 'SaveVideo' } },
    });
    expect(privateRun.backend_id).toBe('media-generation.comfyui.video');
  });

  it('leaves the request unchanged with a named backend, or without purpose and rules', async () => {
    withKeys('OPENAI_API_KEY');
    const named = { prompt: 'x', purpose: 'quality', backend_id: 'media-generation.runway.gen4.5' };
    expect(await applyVideoProviderSelection(named)).toBe(named);
    const plain = { prompt: 'x' };
    expect(await applyVideoProviderSelection(plain)).toBe(plain);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('fails clearly on an unknown purpose or when nothing can run the request', async () => {
    await expect(applyVideoProviderSelection({ prompt: 'x', purpose: 'vibes' })).rejects.toThrow(
      /unknown purpose 'vibes'.*known: cost, privacy, quality, speed/
    );
    await expect(applyVideoProviderSelection({ prompt: 'x', purpose: 'speed' })).rejects.toThrow(
      /\[VIDEO_GENERATION_SELECTION\] no provider can run this task/
    );
  });

  it('lets a matching operator rule pick the backend without a purpose', async () => {
    withKeys('OPENAI_API_KEY', 'GEMINI_API_KEY');
    setSeamSelectionRule({
      rule_id: 'wide-veo',
      seam: 'video-generation-provider',
      when: { context: { aspect_ratio: '16:9' } },
      prefer: ['media-generation.google.veo-3.1'],
    });
    const wide = await applyVideoProviderSelection({ prompt: 'x', aspect_ratio: '16:9' });
    expect(wide.backend_id).toBe('media-generation.google.veo-3.1');
    expect(mocks.record.mock.calls.at(-1)?.[0]?.metadata).toEqual(
      expect.objectContaining({ strategy: 'rule', decision_key: 'default' })
    );
    const square = { prompt: 'x', aspect_ratio: '1:1' };
    expect(await applyVideoProviderSelection(square)).toBe(square);
  });
});
