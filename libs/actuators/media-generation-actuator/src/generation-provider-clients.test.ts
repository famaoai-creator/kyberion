import { describe, expect, it, vi } from 'vitest';
import { createGenerationProviderHistoryClient } from './generation-provider-clients.js';

vi.mock('./comfyui-provider-client.js', () => ({
  createComfyUiProviderClient: vi.fn(() => ({
    provider: 'comfyui',
    history: vi.fn(),
  })),
}));

describe('generation provider history clients', () => {
  it('resolves the governed ComfyUI history client', () => {
    expect(createGenerationProviderHistoryClient(' ComfyUI ')).toEqual(
      expect.objectContaining({ provider: 'comfyui' })
    );
  });

  it('does not silently map an unknown provider to ComfyUI', () => {
    expect(createGenerationProviderHistoryClient('mflux')).toBeUndefined();
    expect(createGenerationProviderHistoryClient('hyperframes')).toBeUndefined();
  });
});
