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
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { _resetProviderEgressPolicyCacheForTests } from '../provider/provider-egress-gate.js';
import { _resetEgressPolicyCacheForTests } from '../egress-policy.js';
import {
  ReasoningEgressDeniedError,
  assertReasoningEgressAllowed,
  assertReasoningEgressAllowedAtEndpoint,
  getReasoningPayloadScope,
  _setReasoningTenantRegistryRootForTests,
  isLocalReasoningBackend,
  reasoningBackendEndpoint,
  withReasoningPayloadScope,
} from './reasoning-egress-scope.js';
import { resolveSandboxPolicy, withSandboxPolicy } from '../shell/sandbox-policy.js';

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
      tenant_allowed_domains: {
        'approved-tenant': ['api.anthropic.com'],
        'attested-tenant': ['api.anthropic.com'],
      },
    })
  );
  process.env.KYBERION_EGRESS_POLICY_PATH = POLICY_PATH;
  _resetEgressPolicyCacheForTests();
});

afterEach(() => {
  delete process.env.KYBERION_EGRESS_POLICY_PATH;
  _resetEgressPolicyCacheForTests();
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
  it('honors an active network-disabled sandbox before provider egress checks', () => {
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'workspace-write',
      networkAccess: false,
    });
    withSandboxPolicy(policy, () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).toThrow('SANDBOX_NETWORK_DENIED');
    });
  });

  it('permits an explicitly allowlisted public endpoint when no scope is declared', () => {
    expect(() => assertReasoningEgressAllowed('anthropic')).not.toThrow();
  });

  it('blocks an unapproved public endpoint when no scope is declared', () => {
    expect(() => assertReasoningEgressAllowed('some-new-vendor')).toThrow(
      ReasoningEgressDeniedError
    );
  });

  it('permits public material to any backend', () => {
    withReasoningPayloadScope({ tier: 'public', training_use: 'training_eligible' }, () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).not.toThrow();
      expect(() => assertReasoningEgressAllowed('agy-cli')).not.toThrow();
    });
  });

  it('blocks confidential material to an unapproved provider', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'other-tenant' }, () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).toThrow(ReasoningEgressDeniedError);
    });
  });

  it('permits confidential material to a provider approved for that tenant', () => {
    withReasoningPayloadScope(
      { tier: 'confidential', tenant_slug: 'approved-tenant', training_use: 'training_eligible' },
      () => {
        expect(() => assertReasoningEgressAllowed('anthropic')).not.toThrow();
      }
    );
  });

  it('permits confidential material to a local backend', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'other-tenant' }, () => {
      expect(() => assertReasoningEgressAllowed('ollama')).not.toThrow();
    });
  });

  it('does not treat an undeclared remote backend as zero-retention', () => {
    withReasoningPayloadScope(
      { tier: 'confidential', tenant_slug: 'approved-tenant', training_use: 'zero_retention' },
      () => {
        expect(() => assertReasoningEgressAllowed('anthropic')).toThrow(
          /no zero_retention declaration/
        );
      }
    );
  });

  it('allows a provider-neutral local adapter name when its endpoint is local', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'other-tenant' }, () => {
      expect(() =>
        assertReasoningEgressAllowedAtEndpoint('openai-compatible', 'http://127.0.0.1:11434/v1')
      ).not.toThrow();
    });
  });

  it('rejects a local-only backend when its configured endpoint is external', () => {
    withReasoningPayloadScope({ tier: 'confidential', tenant_slug: 'other-tenant' }, () => {
      expect(() =>
        assertReasoningEgressAllowedAtEndpoint('ollama', 'https://attacker.example/v1')
      ).toThrow(ReasoningEgressDeniedError);
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
    for (const name of [
      'stub',
      'ollama',
      'vllm',
      'lmstudio',
      'llamacpp',
      'local',
      'mlx',
      'localai',
      'apple-intelligence',
    ]) {
      expect(isLocalReasoningBackend(name)).toBe(true);
    }
    expect(isLocalReasoningBackend('agy-cli')).toBe(false);
    expect(isLocalReasoningBackend('anthropic')).toBe(false);
  });

  it('maps known providers to their endpoints', () => {
    expect(reasoningBackendEndpoint('anthropic')).toContain('api.anthropic.com');
    expect(reasoningBackendEndpoint('gemini')).toContain('googleapis.com');
    expect(reasoningBackendEndpoint('cursor-cli')).toContain('api2.cursor.sh');
    expect(reasoningBackendEndpoint('opencode-cli')).toContain('opencode.ai');
  });

  it('maps an unknown provider to an invalid host', () => {
    expect(reasoningBackendEndpoint('mystery')).toContain('unknown-provider.invalid');
  });
});

describe('zero_retention honours tenant provider attestations', () => {
  const REGISTRY_ROOT = pathResolver.sharedTmp('reasoning-egress-attestation-tests');
  const TENANTS_DIR = path.join(REGISTRY_ROOT, 'knowledge', 'personal', 'tenants');
  const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  function writeTenant(slug: string, attestations?: Record<string, unknown>): void {
    safeWriteFile(
      path.join(TENANTS_DIR, `${slug}.json`),
      JSON.stringify({
        tenant_slug: slug,
        display_name: slug,
        status: 'active',
        assigned_role: 'owner',
        ...(attestations ? { provider_attestations: attestations } : {}),
      })
    );
  }

  beforeEach(() => {
    safeMkdir(TENANTS_DIR, { recursive: true });
    // Tenant with a domain grant and a valid 'none' attestation for claude.
    writeTenant('attested-tenant', {
      claude: { training_use: 'none', attested_at: daysFromNow(-1) },
    });
    // Valid attestation, but no tenant domain grant in the egress policy.
    writeTenant('attested-no-domain', {
      claude: { training_use: 'none', attested_at: daysFromNow(-1) },
    });
    writeTenant('expired-tenant', {
      claude: { training_use: 'none', attested_at: daysFromNow(-10), expires_at: daysFromNow(-1) },
    });
    writeTenant('trained-tenant', {
      claude: { training_use: 'used', attested_at: daysFromNow(-1) },
    });
    writeTenant('codex-only-tenant', {
      codex: { training_use: 'none', attested_at: daysFromNow(-1) },
    });
    writeTenant('unattested-tenant');
    _setReasoningTenantRegistryRootForTests(REGISTRY_ROOT);
    _resetProviderEgressPolicyCacheForTests();
  });

  afterEach(() => {
    _setReasoningTenantRegistryRootForTests(undefined);
    safeRmSync(REGISTRY_ROOT, { recursive: true, force: true });
  });

  const zeroRetention = (tenant_slug: string | undefined, fn: () => void) =>
    withReasoningPayloadScope(
      {
        tier: 'confidential',
        ...(tenant_slug ? { tenant_slug } : {}),
        training_use: 'zero_retention',
      },
      fn
    );

  it('allows an external backend when the tenant attests training_use none', () => {
    zeroRetention('attested-tenant', () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).not.toThrow();
    });
  });

  it('still applies the tenant domain policy after the attestation passes', () => {
    zeroRetention('attested-no-domain', () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(ReasoningEgressDeniedError);
      expect(() => assertReasoningEgressAllowed('claude-cli')).not.toThrow(
        /no zero_retention declaration/
      );
    });
  });

  it('denies without an attestation', () => {
    zeroRetention('unattested-tenant', () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(
        /no zero_retention declaration .*no attestation for provider 'claude' \| next: .* \| tenant=unattested-tenant/
      );
    });
  });

  it('denies an expired attestation', () => {
    zeroRetention('expired-tenant', () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(/expired/);
    });
  });

  it("denies an attestation whose training_use is not 'none'", () => {
    zeroRetention('trained-tenant', () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(/training_use 'used'/);
    });
  });

  it('denies when only another provider is attested', () => {
    zeroRetention('codex-only-tenant', () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(/no attestation/);
    });
  });

  it("denies another tenant's attestation when the active tenant differs", () => {
    withExecutionContext(
      'mission_controller',
      () =>
        zeroRetention('attested-tenant', () => {
          expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(
            /conflicts with the active tenant scope/
          );
        }),
      undefined,
      'unattested-tenant'
    );
  });

  it('denies when the scope names no tenant', () => {
    withReasoningPayloadScope({ tier: 'public', training_use: 'zero_retention' }, () => {
      expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(/no tenant_slug/);
    });
  });

  it('denies a backend that maps to no egress provider id', () => {
    zeroRetention('attested-tenant', () => {
      expect(() => assertReasoningEgressAllowed('anthropic')).toThrow(/no egress provider id/);
    });
  });

  it('leaves local backends unaffected', () => {
    zeroRetention('unattested-tenant', () => {
      expect(() => assertReasoningEgressAllowed('ollama')).not.toThrow();
    });
  });

  it('leaves training_eligible and local_only unchanged', () => {
    withReasoningPayloadScope(
      { tier: 'confidential', tenant_slug: 'unattested-tenant', training_use: 'training_eligible' },
      () => {
        // No attestation consulted: only the domain policy decides (no grant here).
        expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(
          ReasoningEgressDeniedError
        );
      }
    );
    withReasoningPayloadScope(
      { tier: 'confidential', tenant_slug: 'attested-tenant', training_use: 'training_eligible' },
      () => {
        expect(() => assertReasoningEgressAllowed('claude-cli')).not.toThrow();
      }
    );
    withReasoningPayloadScope(
      { tier: 'confidential', tenant_slug: 'attested-tenant', training_use: 'local_only' },
      () => {
        expect(() => assertReasoningEgressAllowed('claude-cli')).toThrow(/local_only/);
      }
    );
  });
});
