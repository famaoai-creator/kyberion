/**
 * SM-01 contract (INFORMATION_ASSET_SCOPE P1): the reasoning-send face
 * (`withReasoningPayloadScope` + `assertReasoningEgressAllowed`, training_use
 * `no_training`) and the delegation face (`evaluateProviderEgress`) give the
 * same answer for the same custody owner, attestation state, data tier and
 * provider declaration — because both call the same evaluator.
 *
 * In every cell the custody owners that are NOT the subject hold a valid
 * `none` attestation, so a face that borrowed another owner's statement (the
 * installation's for tenant material, a tenant's for tenantless material, …)
 * would answer differently from the expectation.
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../daemon/ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

import { withExecutionContext } from '../authority.js';
import type { CustodyOwner } from '../contracts/custody-owner.js';
import { _resetEgressPolicyCacheForTests } from '../governance/egress-policy.js';
import { pathResolver } from '../path-resolver.js';
import {
  _setReasoningTenantRegistryRootForTests,
  assertReasoningEgressAllowed,
  ReasoningEgressDeniedError,
  withReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  CUSTODY_PROVIDER_ATTESTATION_ROOT,
  writeCustodyProviderAttestationEntry,
  type CustodyProviderAttestationEntry,
  type NonTenantCustodyOwner,
} from './custody-provider-attestation-store.js';
import {
  _resetProviderEgressPolicyCacheForTests,
  evaluateProviderEgress,
} from './provider-egress-gate.js';

const ROOT = pathResolver.sharedTmp(`custody-egress-face-agreement-${process.pid}`);
const TENANTS_DIR = path.join(ROOT, 'knowledge', 'personal', 'tenants');
const DOMAIN_POLICY = path.join(ROOT, 'egress-policy.json');
const DECLARED_POLICY = path.join(ROOT, 'provider-egress-declared.json');
const UNDECLARED_POLICY = path.join(ROOT, 'provider-egress-undeclared.json');
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

type AttestationState = 'absent' | 'valid' | 'expired' | 'used';
type CustodyKind = 'system' | 'tenant' | 'person';
type Tier = 'confidential' | 'personal';

function entry(state: Exclude<AttestationState, 'absent'>): CustodyProviderAttestationEntry {
  const base = {
    plan: 'Claude Team',
    basis: 'https://www.anthropic.com/legal/commercial-terms',
    attested_by: 'human:owner',
  };
  if (state === 'used') return { training_use: 'used', attested_at: daysFromNow(-1) };
  return {
    training_use: 'none',
    ...base,
    attested_at: state === 'expired' ? daysFromNow(-10) : daysFromNow(-1),
    ...(state === 'expired' ? { expires_at: daysFromNow(-1) } : {}),
    approval: { request_id: 'req-fixture', approved_by: 'human-owner' },
  };
}

const asOperator = <T>(fn: () => T): T => withExecutionContext('sovereign_concierge', fn);

function clearCustodyStore(): void {
  asOperator(() =>
    safeRmSync(pathResolver.rootResolve(CUSTODY_PROVIDER_ATTESTATION_ROOT), {
      recursive: true,
      force: true,
    })
  );
}

function writeTenant(state: AttestationState): void {
  const { approval: _approval, ...tenantEntry } = state === 'absent' ? ({} as never) : entry(state);
  asOperator(() =>
    safeWriteFile(
      path.join(TENANTS_DIR, 'acme.json'),
      JSON.stringify({
        tenant_slug: 'acme',
        display_name: 'Acme',
        status: 'active',
        assigned_role: 'owner',
        ...(state === 'absent' ? {} : { provider_attestations: { claude: tenantEntry } }),
      })
    )
  );
}

function writeCustody(owner: NonTenantCustodyOwner, state: AttestationState): void {
  if (state === 'absent') return;
  asOperator(() => writeCustodyProviderAttestationEntry(owner, 'claude', entry(state)));
}

/** Subject owner holds `state`; every other owner holds a valid `none`. */
function arrange(subject: CustodyKind, state: AttestationState): void {
  clearCustodyStore();
  writeTenant(subject === 'tenant' ? state : 'valid');
  writeCustody({ kind: 'system' }, subject === 'system' ? state : 'valid');
  writeCustody({ kind: 'person' }, subject === 'person' ? state : 'valid');
}

function scopeFor(
  subject: CustodyKind,
  tier: Tier
): { tenant_slug?: string; custody?: CustodyOwner } {
  if (subject === 'tenant') return { tenant_slug: 'acme' };
  // Tenantless material: confidential derives system custody, personal
  // derives person custody; anything else is declared explicitly.
  if (subject === 'system') return tier === 'confidential' ? {} : { custody: { kind: 'system' } };
  return tier === 'personal' ? {} : { custody: { kind: 'person' } };
}

function delegationFace(subject: CustodyKind, tier: Tier): boolean {
  const scope = scopeFor(subject, tier);
  return evaluateProviderEgress({
    provider: 'claude',
    dataTier: tier,
    ...scope,
    tenant_registry_root_dir: ROOT,
  }).allowed;
}

function reasoningFace(subject: CustodyKind, tier: Tier): { allowed: boolean; error?: string } {
  const scope = scopeFor(subject, tier);
  try {
    withReasoningPayloadScope({ tier, ...scope, training_use: 'no_training' }, () =>
      assertReasoningEgressAllowed('claude-cli')
    );
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof ReasoningEgressDeniedError)) throw error;
    return { allowed: false, error: error.message };
  }
}

function useProviderPolicy(file: string): void {
  process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH = file;
  _resetProviderEgressPolicyCacheForTests();
}

beforeAll(() => {
  asOperator(() => {
    safeMkdir(TENANTS_DIR, { recursive: true });
    // The endpoint-domain layer is held open for both tenant and tenantless
    // material so the matrix isolates the provider-egress decision.
    safeWriteFile(
      DOMAIN_POLICY,
      JSON.stringify({
        version: '1',
        mode: 'warn',
        manual_allowed_domains: ['api.anthropic.com'],
        tenant_allowed_domains: { '*': ['api.anthropic.com'] },
      })
    );
    const tierPolicy = {
      confidential: { mode: 'approved-only', approved_providers: [] },
      personal: { mode: 'local-only-or-approved', approved_providers: [] },
    };
    safeWriteFile(
      DECLARED_POLICY,
      JSON.stringify({
        version: '1.3.0',
        attestation_ttl_days: 180,
        providers: {
          claude: { egress: 'external-api', training_use: 'unknown' },
          codex: { egress: 'external-api', training_use: 'unknown' },
        },
        tier_policy: tierPolicy,
      })
    );
    safeWriteFile(
      UNDECLARED_POLICY,
      JSON.stringify({
        version: '1.3.0',
        attestation_ttl_days: 180,
        providers: { codex: { egress: 'external-api', training_use: 'unknown' } },
        tier_policy: tierPolicy,
      })
    );
  });
  process.env.KYBERION_EGRESS_POLICY_PATH = DOMAIN_POLICY;
  _resetEgressPolicyCacheForTests();
  _setReasoningTenantRegistryRootForTests(ROOT);
});

afterAll(() => {
  delete process.env.KYBERION_EGRESS_POLICY_PATH;
  delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
  _resetEgressPolicyCacheForTests();
  _resetProviderEgressPolicyCacheForTests();
  _setReasoningTenantRegistryRootForTests(undefined);
  clearCustodyStore();
  asOperator(() => safeRmSync(ROOT, { recursive: true, force: true }));
});

const CELLS: Array<[CustodyKind, AttestationState, Tier, 'declared' | 'undeclared']> = [];
for (const subject of ['system', 'tenant', 'person'] as const)
  for (const state of ['absent', 'valid', 'expired', 'used'] as const)
    for (const tier of ['confidential', 'personal'] as const)
      for (const declaration of ['declared', 'undeclared'] as const)
        CELLS.push([subject, state, tier, declaration]);

describe('reasoning-send and delegation faces agree (custody x attestation x tier x declaration)', () => {
  it.each(CELLS)(
    '%s custody, %s attestation, %s tier, provider %s',
    (subject, state, tier, declaration) => {
      useProviderPolicy(declaration === 'declared' ? DECLARED_POLICY : UNDECLARED_POLICY);
      arrange(subject, state);
      // Only the subject's own valid `none` for a declared provider opens
      // egress; system custody can never hold personal material. (A person's
      // `none` is consent and also needs the system attestation, which every
      // person cell holds as a non-subject — see the block below.)
      const expected =
        state === 'valid' &&
        declaration === 'declared' &&
        !(subject === 'system' && tier === 'personal');
      const delegation = delegationFace(subject, tier);
      const reasoning = reasoningFace(subject, tier);
      expect({ delegation, reasoning: reasoning.allowed }).toEqual({
        delegation: expected,
        reasoning: expected,
      });
      if (
        !reasoning.allowed &&
        subject !== 'tenant' &&
        !(subject === 'system' && tier === 'personal')
      ) {
        // Tenantless denials name the attestation command for that custody owner.
        expect(reasoning.error).toContain(
          `pnpm onboarding llm attest --custody ${subject} --provider claude`
        );
      }
    }
  );
});

describe('a tenantless reasoning send (e.g. a system role draft) under the shipped provider policy', () => {
  const draft = () =>
    withReasoningPayloadScope(
      { tier: 'confidential', purpose: 'system role draft', training_use: 'no_training' },
      () => assertReasoningEgressAllowed('claude-cli')
    );

  it('is denied without a system attestation and names the system attest command', () => {
    delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
    _resetProviderEgressPolicyCacheForTests();
    clearCustodyStore();
    expect(draft).toThrow(
      /the installation \(system custody\) has no attestation for provider 'claude'.* \| next: record one with 'pnpm onboarding llm attest --custody system --provider claude .*--request-approval'/
    );
  });

  it('passes once the installation holds a valid training_use none attestation', () => {
    delete process.env.KYBERION_PROVIDER_EGRESS_POLICY_PATH;
    _resetProviderEgressPolicyCacheForTests();
    clearCustodyStore();
    writeCustody({ kind: 'system' }, 'valid');
    expect(draft).not.toThrow();
    // A person attestation alone never covers confidential system material.
    clearCustodyStore();
    writeCustody({ kind: 'person' }, 'valid');
    expect(draft).toThrow(ReasoningEgressDeniedError);
  });

  it('fails closed on a custody declaration that contradicts the scope, whatever the training_use', () => {
    clearCustodyStore();
    writeCustody({ kind: 'system' }, 'valid');
    for (const training_use of ['no_training', 'training_eligible', 'local_only'] as const) {
      expect(() =>
        withReasoningPayloadScope(
          {
            tier: 'confidential',
            tenant_slug: 'acme',
            custody: { kind: 'system' },
            training_use,
          },
          () => assertReasoningEgressAllowed('claude-cli')
        )
      ).toThrow(/\[CUSTODY_OWNER_CONFLICT\] system custody cannot hold material of tenant 'acme'/);
    }
    expect(() =>
      withReasoningPayloadScope(
        { tier: 'personal', custody: { kind: 'system' }, training_use: 'no_training' },
        () => assertReasoningEgressAllowed('claude-cli')
      )
    ).toThrow(/\[CUSTODY_OWNER_CONFLICT\] system custody cannot hold personal-tier material/);
  });
});

describe("person custody: the person's attestation is consent, not no-training evidence", () => {
  it('denies person consent without the installation attestation on both faces, and allows it with one', () => {
    useProviderPolicy(DECLARED_POLICY);
    clearCustodyStore();
    writeCustody({ kind: 'person' }, 'valid');
    expect({
      delegation: delegationFace('person', 'personal'),
      reasoning: reasoningFace('person', 'personal').allowed,
    }).toEqual({ delegation: false, reasoning: false });
    const reasoning = reasoningFace('person', 'personal');
    expect(reasoning.error).toContain("consents to 'claude', but its consent is not evidence");
    expect(reasoning.error).toContain(
      'pnpm onboarding llm attest --custody system --provider claude'
    );
    writeCustody({ kind: 'system' }, 'expired');
    expect(delegationFace('person', 'personal')).toBe(false);
    writeCustody({ kind: 'system' }, 'valid');
    expect({
      delegation: delegationFace('person', 'personal'),
      reasoning: reasoningFace('person', 'personal').allowed,
    }).toEqual({ delegation: true, reasoning: true });
  });
});
