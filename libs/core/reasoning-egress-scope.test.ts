/**
 * Tier gate on the reasoning-backend send path.
 *
 * `secureFetch` cannot cover this: every backend talks to its provider through
 * that SDK's own HTTP client. Without this gate the single largest outbound
 * payload in the system — whole documents and rendered pages — bypasses the
 * control written for exactly that case.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import { resetEgressPolicyCache } from './egress-policy.js';
import {
  ReasoningEgressDeniedError,
  assertReasoningEgressAllowed,
  getReasoningPayloadScope,
  isLocalReasoningBackend,
  reasoningBackendEndpoint,
  withReasoningPayloadScope,
} from './reasoning-egress-scope.js';

const POLICY_DIR = pathResolver.sharedTmp('reasoning-egress-tests');
const POLICY_PATH = path.join(POLICY_DIR, 'egress-policy.json');

beforeEach(() => {
  safeMkdir(POLICY_DIR, { recursive: true });
  safeWriteFile(
    POLICY_PATH,
    JSON.stringify({
      version: '1',
      mode: 'warn',
      manual_allowed_domains: ['api.anthropic.com'],
      tenant_allowed_domains: { 'approved-tenant': ['api.anthropic.com'] },
    })
  );
  process.env.KYBERION_EGRESS_POLICY_PATH = POLICY_PATH;
  resetEgressPolicyCache();
});

afterEach(() => {
  delete process.env.KYBERION_EGRESS_POLICY_PATH;
  resetEgressPolicyCache();
});

describe('scope propagation', () => {
  it('is absent outside any scope', () => {
    expect(getReasoningPayloadScope()).toBeUndefined();
  });

  it('is visible inside the scope', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 't' }, () => {
      expect(getReasoningPayloadScope()?.tier).toBe('confidential');
    });
  });

  it('does not leak out of the scope', () => {
    withReasoningPayloadScope({ tier: 'confidential' }, () => undefined);
    expect(getReasoningPayloadScope()).toBeUndefined();
  });

  it('survives an await inside the scope', async () => {
    await withReasoningPayloadScope({ tier: 'personal' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      // Async-local rather than env-based precisely so this holds while other
      // reasoning calls run concurrently.
      expect(getReasoningPayloadScope()?.tier).toBe('personal');
    });
  });
});

describe('assertReasoningEgressAllowed', () => {
  it('permits everything when no scope is declared', () => {
    // Compatibility default: most calls carry no tenant material, and denying
    // by default would stop the system rather than protect it.
    expect(() => assertReasoningEgressAllowed('anthropic')).not.toThrow();
  });

  it('permits public material to any backend', () => {
    withReasoningPayloadScope({ tier: 'public' }, () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).not.toThrow();
    });
  });

  it('blocks confidential material to an unapproved provider', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'other-tenant' }, () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).toThrow(ReasoningEgressDeniedError);
    });
  });

  it('permits confidential material to a provider approved for that tenant', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'approved-tenant' }, () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).not.toThrow();
    });
  });

  it('permits confidential material to a local backend', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'other-tenant' }, () => {
      expect(() => assertReasoningEgressAllowed('ollama')).not.toThrow();
    });
  });

  it('blocks an unrecognized provider holding tenant material', () => {
    // An unknown backend resolves to an invalid host, which the tenant rule
    // denies — the safe direction when the destination is unknown.
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'approved-tenant' }, () => {
      expect(() => assertReasoningEgressAllowed('some-new-vendor')).toThrow(
        ReasoningEgressDeniedError
      );
    });
  });

  it('names the tier in the error so the operator sees what was at stake', () => {
    withReasoningPayloadScope({ tier: 'personal' }, () => {
      try {
        assertReasoningEgressAllowed('anthropic');
        throw new Error('expected a denial');
      } catch (error: any) {
        expect(error.message).toContain('REASONING_EGRESS_DENIED');
        expect(error.message).toContain('personal');
      }
    });
  });
});

describe('backend classification', () => {
  it('recognizes local backends', () => {
    for (const name of ['stub', 'ollama', 'local', 'mlx']) {
      expect(isLocalReasoningBackend(name)).toBe(true);
    }
    expect(isLocalReasoningBackend('anthropic')).toBe(false);
  });

  it('maps known providers to their endpoints', () => {
    expect(reasoningBackendEndpoint('anthropic')).toContain('api.anthropic.com');
    expect(reasoningBackendEndpoint('gemini')).toContain('googleapis.com');
  });

  it('maps an unknown provider to an invalid host', () => {
    expect(reasoningBackendEndpoint('mystery')).toContain('unknown-provider.invalid');
  });
});
