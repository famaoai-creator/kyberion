import { afterEach, describe, expect, it } from 'vitest';
import { resolveComfyBaseUrl, resolveProductRepositoryUrl } from './service-endpoints.js';

describe('service endpoints', () => {
  const saved = process.env.KYBERION_REPOSITORY_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.KYBERION_REPOSITORY_URL;
    else process.env.KYBERION_REPOSITORY_URL = saved;
  });

  it('trims trailing slashes from the comfy override', () => {
    expect(resolveComfyBaseUrl(' http://gpu-box:8188/// ')).toBe('http://gpu-box:8188');
  });

  it('handles long slash runs in linear time', () => {
    const started = Date.now();
    expect(resolveComfyBaseUrl(`http://x${'/'.repeat(50_000)}a`)).toBe(
      `http://x${'/'.repeat(50_000)}a`
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('falls back to the default repository URL when the override is only slashes', () => {
    process.env.KYBERION_REPOSITORY_URL = '///';
    expect(resolveProductRepositoryUrl()).toBe('https://github.com/famaoai-creator/kyberion');
  });
});
