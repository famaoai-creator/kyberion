import { secureFetch } from '@agent/core';

export interface ComfyUiFetchRequest {
  method: 'GET';
  url: string;
}

export type ComfyUiFetch = (request: ComfyUiFetchRequest) => Promise<unknown>;

export interface ComfyUiProviderClient {
  readonly provider: 'comfyui';
  history(providerJobId: string): Promise<unknown>;
  historyEndpoint(providerJobId: string): string;
}

export interface ComfyUiProviderClientOptions {
  baseUrl?: string;
  fetch?: ComfyUiFetch;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value || process.env.KYBERION_COMFY_BASE_URL || 'http://127.0.0.1:8188').replace(
    /\/+$/u,
    ''
  );
}

function validateProviderJobId(providerJobId: string): string {
  const normalized = providerJobId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error('Invalid ComfyUI provider job id');
  }
  return normalized;
}

export function createComfyUiProviderClient(
  options: ComfyUiProviderClientOptions = {}
): ComfyUiProviderClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetcher = options.fetch || secureFetch;
  return {
    provider: 'comfyui',
    historyEndpoint(providerJobId: string): string {
      return `${baseUrl}/history/${encodeURIComponent(validateProviderJobId(providerJobId))}`;
    },
    async history(providerJobId: string): Promise<unknown> {
      return fetcher({
        method: 'GET',
        url: this.historyEndpoint(providerJobId),
      });
    },
  };
}
