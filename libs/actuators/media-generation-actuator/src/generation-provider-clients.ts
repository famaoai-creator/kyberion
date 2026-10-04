import {
  createComfyUiProviderClient,
  type ComfyUiProviderClient,
} from './comfyui-provider-client.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '@agent/core/seam';
import { isRecord } from '@agent/core/foundation';

export type GenerationProviderHistoryClient = Pick<ComfyUiProviderClient, 'history'> & {
  provider: string;
};

export type GenerationProviderHistoryClientFactory = () => GenerationProviderHistoryClient;

function normalizeHistoryProviderId(provider: string): string {
  if (typeof provider !== 'string') {
    throw new Error('Media generation provider id must be a string');
  }
  const id = provider.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid media generation provider id for history client: ${provider}`);
  }
  return id;
}

const generationHistoryClientSeam = createSeam<GenerationProviderHistoryClientFactory>({
  key: 'media-generation-history-client',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

export function registerGenerationProviderHistoryClient(
  provider: string,
  factory: GenerationProviderHistoryClientFactory,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'media-generation-history-extension',
  }
): () => void {
  const id = normalizeHistoryProviderId(provider);
  if (typeof factory !== 'function') {
    throw new Error(`Media generation history client '${id}' requires a factory`);
  }
  return generationHistoryClientSeam.register(id, factory, metadata);
}

registerGenerationProviderHistoryClient('comfyui', () => createComfyUiProviderClient(), {
  provenance: 'builtin',
  source: 'comfyui-provider-client',
});

export function createGenerationProviderHistoryClient(
  provider: string
): GenerationProviderHistoryClient | undefined {
  const id = normalizeHistoryProviderId(provider);
  const factory: unknown = generationHistoryClientSeam.getOptional(id);
  if (factory === undefined) return undefined;
  if (typeof factory !== 'function') {
    throw new Error('Media generation history client factory ' + id + ' must be a function');
  }
  const client: unknown = factory();
  if (
    !isRecord(client) ||
    typeof client.provider !== 'string' ||
    client.provider.trim().toLowerCase() !== id ||
    typeof client.history !== 'function'
  ) {
    throw new Error(`Media generation history client '${id}' violates its provider contract`);
  }
  return client as unknown as GenerationProviderHistoryClient;
}
