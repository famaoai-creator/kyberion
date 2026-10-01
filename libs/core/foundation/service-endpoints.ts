import { getRegisteredEnvText } from './env.js';
import { defineCatalog } from './governed-catalog.js';
import { pathResolver } from '../path-resolver.js';

interface ServiceEndpointDefaultsFile {
  default_pattern?: string;
  defaults?: {
    comfyui_base_url?: string;
    product_repository_url?: string;
  };
  services?: Record<string, { base_url?: string }>;
}

const SERVICE_ENDPOINTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/service-endpoints.schema.json'
);

const serviceEndpointsCatalog = defineCatalog<ServiceEndpointDefaultsFile>({
  id: 'service-endpoints',
  path: () => pathResolver.knowledge('product/orchestration/service-endpoints.json'),
  schema: SERVICE_ENDPOINTS_SCHEMA_PATH,
});

/** Endpoint defaults are validated by the canonical service-endpoints catalog. */
function catalogDefault(key: 'comfyui_base_url' | 'product_repository_url'): string {
  const value = serviceEndpointsCatalog.load().defaults?.[key]?.trim();
  if (!value) throw new Error('[SERVICE_ENDPOINT_DEFAULT_MISSING] ' + key);
  return value;
}
function defaultComfyBaseUrl(): string {
  return catalogDefault('comfyui_base_url');
}
function defaultProductRepositoryUrl(): string {
  return catalogDefault('product_repository_url');
}

/** Linear-time trailing-slash trim (a `/\/+$/` regex is polynomial on long slash runs). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function resolveComfyBaseUrl(override?: string): string {
  return stripTrailingSlashes(
    (override || getRegisteredEnvText('KYBERION_COMFY_BASE_URL') || defaultComfyBaseUrl()).trim()
  );
}

export function resolveComfyPort(): number {
  try {
    const port = Number(new URL(resolveComfyBaseUrl()).port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    /* fall through to the default */
  }
  return Number(new URL(defaultComfyBaseUrl()).port);
}

export function resolveProductRepositoryUrl(): string {
  return (
    stripTrailingSlashes(getRegisteredEnvText('KYBERION_REPOSITORY_URL')?.trim() ?? '') ||
    defaultProductRepositoryUrl()
  );
}
