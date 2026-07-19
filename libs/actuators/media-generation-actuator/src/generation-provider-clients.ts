import {
  createComfyUiProviderClient,
  type ComfyUiProviderClient,
} from './comfyui-provider-client.js';

export type GenerationProviderHistoryClient = Pick<ComfyUiProviderClient, 'history'> & {
  provider: string;
};

export function createGenerationProviderHistoryClient(
  provider: string
): GenerationProviderHistoryClient | undefined {
  switch (provider.trim().toLowerCase()) {
    case 'comfyui':
      return createComfyUiProviderClient();
    default:
      return undefined;
  }
}
