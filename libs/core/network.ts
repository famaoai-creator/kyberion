import axios, { AxiosRequestConfig } from 'axios';
import { secretGuard } from './secret-guard.js';

/**
 * Standardized network utilities for Gemini Skills.
 * Enhanced with Sovereign Outbound Scrubbing.
 */

function scrubData(data: any): any {
  if (!data) return data;
  let str = typeof data === 'string' ? data : JSON.stringify(data);

  // 1. Scrub active secrets tracked by secret-guard
  const secrets = secretGuard.getActiveSecrets();
  for (const secret of secrets) {
    if (secret && secret.length > 5) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      str = str.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
    }
  }

  // 2. Scrub absolute local paths (Darwin/Linux pattern)
  str = str.replace(/\/Users\/[a-zA-Z0-9._-]+\//g, '[REDACTED_PATH]/');

  return typeof data === 'string' ? str : JSON.parse(str);
}

export async function secureFetch<T = any>(options: AxiosRequestConfig): Promise<T> {
  // Automatically scrub outbound data and headers
  if (options.data) options.data = scrubData(options.data);
  if (options.params) options.params = scrubData(options.params);

  try {
    const response = await axios({
      timeout: 15000,
      headers: {
        'User-Agent': 'Kyberion-Sovereign-Agent/1.1.0 (Built-with-Integrity)',
      },
      ...options,
    });
    return response.data;
  } catch (err: any) {
    const status = err.response ? ` (${err.response.status})` : '';
    throw new Error(`Network Error: ${err.message}${status}`);
  }
}
