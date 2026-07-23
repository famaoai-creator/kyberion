import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  secureFetch: vi.fn(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return { ...actual, secureFetch: mocks.secureFetch };
});

import {
  createVideoGenerationProvider,
  isDirectVideoGenerationBackend,
  normalizeVideoGenerationRequest,
  resolveVideoGenerationBackend,
} from './video-generation-provider.js';
import { getMediaBackendRecord } from '@agent/core';

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
});
