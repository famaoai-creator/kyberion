import axios, { AxiosRequestConfig } from 'axios';
import { secretGuard } from './secret-guard.js';
import { logger } from './core.js';

/**
 * Standardized network utilities for Gemini Skills.
 * Enhanced with TIBA-Aware Outbound Scrubbing.
 */

const ENDPOINT_WHITELIST: Record<string, string[]> = {
  'moltbook': ['www.moltbook.com', 'api.moltbook.com'],
  'slack': ['slack.com', 'api.slack.com'],
  'github': ['github.com', 'api.github.com'],
  'google': ['googleapis.com', 'google.com']
};

/**
 * Intelligent Scrubber: Masks secrets unless they are explicitly authorized 
 * for the current endpoint/mission context.
 */
function scrubData(data: any, url: string, authorizedToken?: string): any {
  if (!data) return data;
  let str = typeof data === 'string' ? data : JSON.stringify(data);

  // Layer 2 Shield: Get all active secrets
  const secrets = secretGuard.getActiveSecrets();
  
  for (const secret of secrets) {
    if (secret && secret.length > 5) {
      // TIBA EXCEPTION: If this secret is the ONE authorized for this call, do NOT scrub it.
      if (authorizedToken && secret === authorizedToken) {
        continue; 
      }
      
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      str = str.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
    }
  }

  // Always scrub absolute local paths
  str = str.replace(/\/Users\/[a-zA-Z0-9._-]+\//g, '[REDACTED_PATH]/');

  return typeof data === 'string' ? str : JSON.parse(str);
}

export async function secureFetch<T = any>(options: AxiosRequestConfig): Promise<T> {
  const url = options.url || '';
  const hostname = new URL(url).hostname;
  const currentMission = process.env.MISSION_ID || 'NONE';

  // 1. Identify the Authorization context
  const authHeader = (options.headers?.['Authorization'] || options.headers?.['authorization']) as string || '';
  const tokenToUse = authHeader.replace(/Bearer /i, '').trim();

  if (authHeader) {
    logger.info(`🔍 [SHIELD] Auth detected. Token fragment: ${tokenToUse.substring(0, 10)}...`);
  }

  // 2. Verify Endpoint Integrity
  let isWhitelisted = false;
  for (const service in ENDPOINT_WHITELIST) {
    if (ENDPOINT_WHITELIST[service].some(domain => hostname.endsWith(domain))) {
      isWhitelisted = true;
      break;
    }
  }

  if (authHeader && !isWhitelisted) {
    logger.error(`🚨 [TIBA] Whitelist violation: ${hostname}`);
    throw new Error(`TIBA_SECURITY_VIOLATION: Authenticated request to non-whitelisted endpoint: ${hostname}`);
  }

  // 3. Intelligent Scrubbing
  if (options.data) {
    const originalData = JSON.stringify(options.data);
    options.data = scrubData(options.data, url, tokenToUse);
    if (originalData !== JSON.stringify(options.data)) {
      logger.warn('🛡️ [SHIELD] Outbound data was scrubbed.');
    }
  }
  
  if (options.params) {
    options.params = scrubData(options.params, url, tokenToUse);
  }

  try {
    logger.info(`🚀 [NETWORK] Dispatching to: ${url}`);
    const response = await axios({
      timeout: 15000,
      headers: {
        'User-Agent': `Kyberion-Sovereign-Agent/2.1.0 (Mission: ${currentMission})`,
        ...options.headers
      },
      ...options,
    });
    return response.data;
  } catch (err: any) {
    if (err.response) {
      logger.error(`❌ [NETWORK] 403 Forbidden. Response: ${JSON.stringify(err.response.data)}`);
    }
    const status = err.response ? ` (${err.response.status})` : '';
    throw new Error(`Network Error: ${err.message}${status}`);
  }
}
