import axios, { AxiosRequestConfig } from 'axios';
import { secretGuard } from './secret-guard.js';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, validateUrl } from './secure-io.js';

/**
 * Standardized network utilities for Kyberion Components.
 * v2.2 - POLICY-DRIVEN GUARDRAILS (ADF ENABLED)
 */

function loadAllowedDomains(): string[] {
  try {
    const policyPath = pathResolver.knowledge('public/governance/security-policy.json');
    if (safeExistsSync(policyPath)) {
      const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
      return policy.network_guardrails.allowed_domains || [];
    }
  } catch (_) {}
  return ['github.com', 'google.com']; // Hard fallback for connectivity
}

function loadNetworkGuardrails(): { maxRequestSizeKb: number } {
  try {
    const policyPath = pathResolver.knowledge('public/governance/security-policy.json');
    if (safeExistsSync(policyPath)) {
      const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
      const maxRequestSizeKb = Number(policy?.network_guardrails?.max_request_size_kb);
      if (!Number.isNaN(maxRequestSizeKb) && maxRequestSizeKb > 0) {
        return { maxRequestSizeKb };
      }
    }
  } catch (_) {}
  return { maxRequestSizeKb: 2048 };
}

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

function enforcePayloadSize(options: AxiosRequestConfig) {
  const { maxRequestSizeKb } = loadNetworkGuardrails();
  const payload = options.data ?? options.params ?? '';
  if (payload === '' || payload === undefined || payload === null) return;
  const sizeBytes = Buffer.byteLength(typeof payload === 'string' ? payload : JSON.stringify(payload));
  if (sizeBytes > maxRequestSizeKb * 1024) {
    throw new Error(`[NETWORK_POLICY_VIOLATION] Payload too large (${Math.ceil(sizeBytes / 1024)}KB > ${maxRequestSizeKb}KB)`);
  }
}

export async function secureFetch<T = any>(options: AxiosRequestConfig): Promise<T> {
  const url = options.url || '';
  validateUrl(url);
  const hostname = new URL(url).hostname;

  // 1. Verify Endpoint Integrity
  const hasAuth = options.headers && (options.headers['Authorization'] || options.headers['X-API-KEY']);
  
  if (hasAuth) {
    const allowedDomains = loadAllowedDomains();
    const isWhitelisted = allowedDomains.some(domain => hostname.endsWith(domain));
    
    if (!isWhitelisted) {
      throw new Error(`[NETWORK_POLICY_VIOLATION] Authenticated request to non-whitelisted domain: ${hostname}`);
    }
  }

  // 2. Automatically scrub outbound payload
  if (options.data) options.data = scrubData(options.data, url);
  if (options.params) options.params = scrubData(options.params, url);
  enforcePayloadSize(options);

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
