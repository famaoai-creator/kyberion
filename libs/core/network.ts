import axios, { AxiosRequestConfig } from 'axios';
import { secretGuard } from './secret-guard.js';
import { logger } from './core.js';

/**
 * Standardized network utilities for Gemini Skills.
 * Enhanced with TIBA (Temporal Intent-Based Authentication) and Endpoint Whitelisting.
 */

const ENDPOINT_WHITELIST: Record<string, string[]> = {
  'moltbook': ['www.moltbook.com', 'api.moltbook.com'],
  'slack': ['slack.com', 'api.slack.com'],
  'github': ['github.com', 'api.github.com'],
  'google': ['googleapis.com', 'google.com']
};

function scrubData(data: any, url: string): any {
  if (!data) return data;
  let str = typeof data === 'string' ? data : JSON.stringify(data);

  // Layer 2 Shield: Scrub active secrets tracked by secret-guard
  const secrets = secretGuard.getActiveSecrets();
  for (const secret of secrets) {
    if (secret && secret.length > 5) {
      // Endpoint Check: If the URL is whitelisted for a service, we might allow the secret 
      // (This is handled primarily in headers, but we scrub body just in case)
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      str = str.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
    }
  }

  // Scrub absolute local paths
  str = str.replace(/\/Users\/[a-zA-Z0-9._-]+\//g, '[REDACTED_PATH]/');

  return typeof data === 'string' ? str : JSON.parse(str);
}

export async function secureFetch<T = any>(options: AxiosRequestConfig): Promise<T> {
  const url = options.url || '';
  const hostname = new URL(url).hostname;

  // 1. Verify Endpoint Integrity
  // If the request contains sensitive keywords in headers but target is not whitelisted, reject.
  const hasAuth = options.headers && (options.headers['Authorization'] || options.headers['X-API-KEY']);
  
  if (hasAuth) {
    let isWhitelisted = false;
    for (const service in ENDPOINT_WHITELIST) {
      if (ENDPOINT_WHITELIST[service].some(domain => hostname.endsWith(domain))) {
        isWhitelisted = true;
        break;
      }
    }
    if (!isWhitelisted) {
      throw new Error(`TIBA_SECURITY_VIOLATION: Attempted authenticated request to non-whitelisted endpoint: ${hostname}`);
    }
  }

  // 2. Automatically scrub outbound payload
  if (options.data) options.data = scrubData(options.data, url);
  if (options.params) options.params = scrubData(options.params, url);

  try {
    const response = await axios({
      timeout: 15000,
      headers: {
        'User-Agent': 'Kyberion-Sovereign-Agent/2.1.0 (Physical-Integrity-Enforced)',
      },
      ...options,
    });
    return response.data;
  } catch (err: any) {
    const status = err.response ? ` (${err.response.status})` : '';
    throw new Error(`Network Error: ${err.message}${status}`);
  }
}
