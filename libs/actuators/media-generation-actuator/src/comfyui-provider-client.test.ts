import { describe, expect, it, vi } from 'vitest';
import { createComfyUiProviderClient } from './comfyui-provider-client.js';

describe('ComfyUI provider client', () => {
  it('centralizes the history endpoint and delegates through secure-fetch injection', async () => {
    const fetch = vi.fn(async () => ({ prompt: 'history' }));
    const client = createComfyUiProviderClient({
      baseUrl: 'http://comfy.local/',
      fetch,
    });

    await expect(client.history('prompt-123')).resolves.toEqual({ prompt: 'history' });
    expect(client.historyEndpoint('prompt-123')).toBe('http://comfy.local/history/prompt-123');
    expect(fetch).toHaveBeenCalledWith({
      method: 'GET',
      url: 'http://comfy.local/history/prompt-123',
    });
  });

  it('rejects provider job ids that could alter the history path', () => {
    const client = createComfyUiProviderClient({ baseUrl: 'http://comfy.local' });
    expect(() => client.historyEndpoint('../outside')).toThrow(/provider job id/i);
    expect(() => client.historyEndpoint('prompt/other')).toThrow(/provider job id/i);
  });
});
