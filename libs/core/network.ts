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

function isWhitelistedHostname(hostname: string, domain: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase().trim().replace(/^\.+/, '');
  return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

const SENSITIVE_KEY_PATTERN = /(authorization|proxy-authorization|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|secret|session|cookie|credential|private[_-]?key|token)/i;
const LOCAL_PATH_PATTERN = /\/Users\/[a-zA-Z0-9._-]+\//g;
const GENERIC_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
];

export function redactSensitiveString(value: string): string {
  let redacted = value;
  for (const secret of secretGuard.getActiveSecrets()) {
    if (secret && secret.length > 5) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      redacted = redacted.replace(new RegExp(escaped, 'g'), '[REDACTED_SECRET]');
    }
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  redacted = redacted.replace(LOCAL_PATH_PATTERN, '[REDACTED_PATH]/');
  return redacted;
}

export function redactSensitiveValue(value: any, keyPath: string[] = []): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return SENSITIVE_KEY_PATTERN.test(keyPath[keyPath.length - 1] || '') ? '[REDACTED_SECRET]' : redactSensitiveString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactSensitiveValue(entry, [...keyPath, String(index)]));
  }
  if (typeof value === 'object') {
    const output: Record<string, any> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = typeof nested === 'string' ? '[REDACTED_SECRET]' : redactSensitiveValue(nested, [...keyPath, key]);
        continue;
      }
      output[key] = redactSensitiveValue(nested, [...keyPath, key]);
    }
    return output;
  }
  return value;
}

export function redactSensitiveObject(data: any): any {
  return redactSensitiveValue(data);
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

export async function secureFetch<T = any>(options: SecureFetchOptions): Promise<T> {
  const { kyberion_allow_local_network, authenticateRequest, ...axiosOptions } = options as SecureFetchOptions & { authenticateRequest?: boolean };
  const url = options.url || '';
  validateUrl(url, { allowLocalNetwork: kyberion_allow_local_network === true });
  const hostname = new URL(url).hostname;

  // 1. Verify Endpoint Integrity
  const hasAuth = Boolean(
    authenticateRequest ||
    (options.headers && (options.headers['Authorization'] || options.headers['X-API-KEY']))
  );
  
  if (hasAuth) {
    const allowedDomains = loadAllowedDomains();
    const isWhitelisted = allowedDomains.some((domain) => isWhitelistedHostname(hostname, domain));
    
    if (!isWhitelisted) {
      throw new Error(`[NETWORK_POLICY_VIOLATION] Authenticated request to non-whitelisted domain: ${hostname}`);
    }
  }

  // 2. Automatically scrub outbound payload
  const requestOptions: AxiosRequestConfig = {
    ...axiosOptions,
    data: redactSensitiveObject(axiosOptions.data),
    params: redactSensitiveObject(axiosOptions.params),
    headers: redactSensitiveObject(axiosOptions.headers),
  };
  enforcePayloadSize(requestOptions);

  try {
    const response = await axios({
      timeout: 15000,
      headers: {
        'User-Agent': 'Kyberion-Sovereign-Agent/2.1.0 (Physical-Integrity-Enforced)',
      },
      ...requestOptions,
    });
    return response.data;
  } catch (err: any) {
    const status = err.response ? ` (${err.response.status})` : '';
    throw new Error(`Network Error: ${err.message}${status}`);
  }
}
export interface SecureFetchOptions extends AxiosRequestConfig {
  kyberion_allow_local_network?: boolean;
  authenticateRequest?: boolean;
}
