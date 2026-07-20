import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from './logger.js';
import { evaluateEgressPolicy } from './egress-policy.js';

/**
 * Tier context for reasoning-backend sends.
 *
 * `secureFetch` carries the tier-aware egress gate (SA-04 Task 2), but
 * reasoning backends talk to their providers through each SDK's own HTTP
 * client and never pass through it. That leaves the single highest-risk
 * outbound path — whole documents and rendered pages going to a model —
 * outside the control that exists precisely for it.
 *
 * This module closes that path. A caller that knows it is holding tenant
 * material wraps the work in `withReasoningPayloadScope`, and every send made
 * inside that scope is checked against the same policy.
 *
 * Async-local rather than env-var based on purpose: reasoning calls run
 * concurrently behind a semaphore, and an env var set around one call would be
 * visible to every other call in flight.
 */

const logger = createLogger('reasoning-egress');

export interface ReasoningPayloadScope {
  /** Most sensitive tier represented in what will be sent. */
  tier: 'public' | 'confidential' | 'personal';
  /** Tenant the material belongs to, when above public. */
  tenant_slug?: string;
  /** What is being sent, recorded on denial. */
  purpose?: string;
}

const scopeStorage = new AsyncLocalStorage<ReasoningPayloadScope>();

/** Run `fn` with every reasoning send inside it governed by this scope. */
export function withReasoningPayloadScope<T>(scope: ReasoningPayloadScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

export function getReasoningPayloadScope(): ReasoningPayloadScope | undefined {
  return scopeStorage.getStore();
}

/** Backends that keep material on this machine. */
const LOCAL_BACKENDS =
  /^(stub|local|ollama|vllm|lmstudio|llamacpp|mlx|localai|apple-intelligence)$/u;

export function isLocalReasoningBackend(backendName: string): boolean {
  return LOCAL_BACKENDS.test(backendName);
}

/**
 * Where a named backend sends data.
 *
 * An unrecognized backend resolves to an invalid placeholder host, which the
 * tenant rule denies — the safe direction when an unknown provider would be
 * handed tenant material.
 */
export function reasoningBackendEndpoint(backendName: string): string {
  const endpoints: Record<string, string> = {
    anthropic: 'https://api.anthropic.com',
    'claude-agent': 'https://api.anthropic.com',
    'claude-cli': 'https://api.anthropic.com',
    'shell-claude-cli': 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    'codex-cli': 'https://api.openai.com',
    gemini: 'https://generativelanguage.googleapis.com',
    'gemini-cli': 'https://generativelanguage.googleapis.com',
    copilot: 'https://api.githubcopilot.com',
    'copilot-acp': 'https://api.githubcopilot.com',
  };
  return endpoints[backendName] ?? `https://${backendName}.unknown-provider.invalid`;
}

export class ReasoningEgressDeniedError extends Error {
  constructor(reason: string) {
    super(`[REASONING_EGRESS_DENIED] ${reason}`);
    this.name = 'ReasoningEgressDeniedError';
  }
}

/**
 * Throw if the ambient scope forbids sending to this backend.
 *
 * Without an ambient scope, local endpoints and explicitly allowlisted public
 * endpoints remain usable. Unknown public destinations are denied until the
 * caller declares a payload scope, so a missing scope cannot silently turn
 * into unrestricted external egress.
 */
export function assertReasoningEgressAllowed(backendName: string): void {
  assertReasoningEgressAllowedAtEndpoint(backendName, reasoningBackendEndpoint(backendName));
}

/** Apply the same gate when an adapter has a configurable provider endpoint. */
export function assertReasoningEgressAllowedAtEndpoint(
  backendName: string,
  endpoint: string
): void {
  const scope = getReasoningPayloadScope();
  if (!scope) {
    // A missing scope is treated as public only after the destination itself
    // is approved. This preserves ordinary public prompts while preventing a
    // forgotten scope declaration from becoming an unrestricted exfiltration
    // path to arbitrary endpoints.
    if (isLocalReasoningBackend(backendName) || isLocalReasoningEndpoint(endpoint)) return;
    const decision = evaluateEgressPolicy(endpoint, { tier: 'public' });
    if (decision.verdict !== 'allow') {
      throw new ReasoningEgressDeniedError(
        `[REASONING_EGRESS_SCOPE_REQUIRED] ${backendName} endpoint is not approved without an explicit payload scope: ${decision.reason}`
      );
    }
    return;
  }
  if (scope.tier === 'public') return;
  if (isLocalReasoningBackend(backendName)) return;

  const decision = evaluateEgressPolicy(endpoint, {
    tier: scope.tier,
    tenant_slug: scope.tenant_slug,
    purpose: scope.purpose ?? 'reasoning backend call',
  });
  if (decision.verdict === 'deny') {
    logger.warn(
      `[EGRESS] blocked a ${scope.tier} payload from reaching ${backendName}: ${decision.reason}`
    );
    throw new ReasoningEgressDeniedError(decision.reason);
  }
}

function isLocalReasoningEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '::' ||
      hostname === '::1' ||
      /^127\./u.test(hostname) ||
      /^10\./u.test(hostname) ||
      /^192\.168\./u.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./u.test(hostname) ||
      /^fd[0-9a-f]{2}:/u.test(hostname)
    );
  } catch {
    return false;
  }
}
