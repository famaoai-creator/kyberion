import axios, { AxiosRequestConfig } from 'axios';
import { secretGuard } from './secret-guard.js';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, validateUrl } from './secure-io.js';
import { evaluateEgressPolicy, type EgressPayloadContext } from './egress-policy.js';
import { auditChain } from './audit-chain.js';
import { recordGovernanceAction } from './kill-switch.js';
import { assertOperationPolicy } from './operation-policy-gate.js';

/**
 * Standardized network utilities for Kyberion Components.
 * v2.2 - POLICY-DRIVEN GUARDRAILS (ADF ENABLED)
 */

function loadNetworkGuardrails(): { maxRequestSizeKb: number } {
  try {
    const policyPath = pathResolver.knowledge('product/governance/security-policy.json');
    if (safeExistsSync(policyPath)) {
      const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
      const maxRequestSizeKb = Number(policy?.network_guardrails?.max_request_size_kb);
      if (!Number.isNaN(maxRequestSizeKb) && maxRequestSizeKb > 0) {
        return { maxRequestSizeKb };
      }
    }
  } catch (_) {
    /* policy unreadable: fall back to default guardrails */
  }
  return { maxRequestSizeKb: 2048 };
}

const SENSITIVE_KEY_PATTERN =
  /(authorization|proxy-authorization|api[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|secret|session|cookie|credential|private[_-]?key|token)/i;
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
    return SENSITIVE_KEY_PATTERN.test(keyPath[keyPath.length - 1] || '')
      ? '[REDACTED_SECRET]'
      : redactSensitiveString(value);
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
        output[key] =
          typeof nested === 'string'
            ? '[REDACTED_SECRET]'
            : redactSensitiveValue(nested, [...keyPath, key]);
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
  const sizeBytes = Buffer.byteLength(
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );
  if (sizeBytes > maxRequestSizeKb * 1024) {
    throw new Error(
      `[NETWORK_POLICY_VIOLATION] Payload too large (${Math.ceil(sizeBytes / 1024)}KB > ${maxRequestSizeKb}KB)`
    );
  }
}

export async function secureFetch<T = any>(options: SecureFetchOptions): Promise<T> {
  const { kyberion_allow_local_network, kyberion_egress_context, ...axiosOptions } =
    options as SecureFetchOptions & {
      authenticateRequest?: boolean;
    };
  const url = options.url || '';
  validateUrl(url, { allowLocalNetwork: kyberion_allow_local_network === true });
  const hostname = new URL(url).hostname;

  // SA-05: operation-type policy gate (behavior-neutral until a rule
  // targets network_request; throws [POLICY_BLOCKED] + audits on match).
  assertOperationPolicy({
    operation: 'network_request',
    message: `Fetch ${hostname}`,
    context: { hostname },
  });

  // 1. Verify Endpoint Integrity for all requests.
  const egressDecision = evaluateEgressPolicy(url, kyberion_egress_context);
  if (egressDecision.verdict === 'deny') {
    recordGovernanceAction(
      process.env.KYBERION_PERSONA || 'unknown',
      'egress',
      `${hostname}:denied`,
      true
    );
    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'unknown',
      action: 'egress_request',
      operation: 'secure_fetch',
      result: 'failed',
      reason: egressDecision.reason,
      metadata: {
        hostname,
        mode: egressDecision.mode,
        allowed: false,
        // SA-04 acceptance 4: every outbound attempt is auditable with its tier.
        tier: egressDecision.tier ?? 'unspecified',
        tenant: kyberion_egress_context?.tenant_slug ?? null,
        purpose: kyberion_egress_context?.purpose ?? null,
      },
    });
    if (egressDecision.tier === 'confidential' || egressDecision.tier === 'personal') {
      // SA-04 Task 2: the operator hears about tenant data being pushed out,
      // not just the audit log.
      logger.warn(
        `[EGRESS] blocked an attempt to send ${egressDecision.tier} material to ${hostname}`
      );
    }
    throw new Error(`[NETWORK_POLICY_VIOLATION] ${egressDecision.reason}`);
  }
  if (egressDecision.verdict === 'warn') {
    logger.warn(`[NETWORK_POLICY] ${egressDecision.reason}`);
    recordGovernanceAction(
      process.env.KYBERION_PERSONA || 'unknown',
      'egress',
      `${hostname}:warn`,
      false
    );
    // SA-04/SA-05: the kill-switch action log is in-memory only, so warn
    // verdicts vanished on process exit and the warn observation period
    // produced no durable evidence for the warn→enforce decision. Mirror
    // the deny path into the audit chain (pnpm egress:report aggregates it).
    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'unknown',
      action: 'egress_request',
      operation: 'secure_fetch',
      result: 'allowed',
      reason: egressDecision.reason,
      metadata: {
        hostname,
        mode: egressDecision.mode,
        verdict: 'warn',
      },
    });
  }

  // 2. Automatically scrub outbound payload UNLESS explicitly authenticated
  const isAuth = options.authenticateRequest === true;
  const requestOptions: AxiosRequestConfig = {
    ...axiosOptions,
    data: isAuth ? axiosOptions.data : redactSensitiveObject(axiosOptions.data),
    params: isAuth ? axiosOptions.params : redactSensitiveObject(axiosOptions.params),
    headers: isAuth ? axiosOptions.headers : redactSensitiveObject(axiosOptions.headers),
  };
  enforcePayloadSize(requestOptions);

  try {
    const finalHeaders = {
      'User-Agent': 'Kyberion-Sovereign-Agent/2.1.0 (Physical-Integrity-Enforced)',
      ...(requestOptions.headers || {}),
    };
    const response = await axios({
      timeout: 15000,
      ...requestOptions,
      headers: finalHeaders,
    });
    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'unknown',
      action: 'egress_request',
      operation: 'secure_fetch',
      result: 'completed',
      reason: `egress to ${hostname}`,
      metadata: {
        hostname,
        mode: egressDecision.mode,
        allowed: true,
      },
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
  /**
   * SA-04 Task 2: declares the tier of the material being sent.
   *
   * Callers that knowingly move tenant data outward must set this; the egress
   * policy then requires the destination to be approved for that tenant rather
   * than merely allowlisted in general. Omitting it preserves the previous
   * behaviour, so this is additive for existing callers.
   */
  kyberion_egress_context?: EgressPayloadContext;
}
