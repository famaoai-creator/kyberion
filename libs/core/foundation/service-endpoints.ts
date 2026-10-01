import { getRegisteredEnvText } from './env.js';

/** Default local ComfyUI endpoint; override with KYBERION_COMFY_BASE_URL. */
export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';

/** Canonical product repository URL; override with KYBERION_REPOSITORY_URL. */
export const DEFAULT_PRODUCT_REPOSITORY_URL = 'https://github.com/famaoai-creator/kyberion';

export function resolveComfyBaseUrl(override?: string): string {
  return (override || getRegisteredEnvText('KYBERION_COMFY_BASE_URL') || DEFAULT_COMFYUI_BASE_URL)
    .trim()
    .replace(/\/+$/u, '');
}

export function resolveComfyPort(): number {
  try {
    const port = Number(new URL(resolveComfyBaseUrl()).port);
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    /* fall through to the default */
  }
  return Number(new URL(DEFAULT_COMFYUI_BASE_URL).port);
}

export function resolveProductRepositoryUrl(): string {
  return (
    getRegisteredEnvText('KYBERION_REPOSITORY_URL')?.trim().replace(/\/+$/u, '') ||
    DEFAULT_PRODUCT_REPOSITORY_URL
  );
}
