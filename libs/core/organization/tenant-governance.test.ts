import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

// Separation of duties is read from approval-policy.json; tests switch it on
// through a customer overlay of the product policy (the real config path).
const sod = vi.hoisted(() => ({ overlayPath: null as string | null }));
vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

import { withExecutionContext } from '../authority.js';
import { auditChain } from '../governance/audit-chain.js';
import { checkProviderEgress } from '../provider/provider-egress-gate.js';
import {
  attestTenantProvider,
  mutateTenant,
  PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
  requestTenantProviderAttestationApproval,
} from './tenant-governance.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
  loadApprovalRequest,
} from '../governance/approval-store.js';
import { readTenantProfile, recordTenantProviderAttestation } from './tenant-registry.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';

describe('tenant lifecycle preserves provider policy state', () => {
  const parent = pathResolver.sharedTmp('tenant-governance-preserve-tests');
  let rootDir = '';

  beforeEach(() => {
    rootDir = path.join(parent, `fixture-${process.pid}-${Date.now()}-${Math.random()}`);
    safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
    withExecutionContext('sovereign_concierge', () =>
      safeWriteFile(
        path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
          allowed_reasoning_backends: ['claude'],
          provider_attestations: {
            claude: {
              training_use: 'none',
              plan: 'paid',
              attested_at: '2026-09-20T00:00:00.000Z',
            },
          },
        })
      )
    );
  });

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('keeps the allowlist and attestations when the governed tenant facade updates metadata', () => {
    const result = withExecutionContext('sovereign_concierge', () =>
      mutateTenant({
        verb: 'update',
        slug: 'acme',
        displayName: 'Acme Renamed',
        rootDir,
        apply: true,
      })
    );

    expect(result.profile.display_name).toBe('Acme Renamed');
    expect(result.profile.allowed_reasoning_backends).toEqual(['claude']);
    expect(result.profile.provider_attestations?.claude).toMatchObject({
      training_use: 'none',
      plan: 'paid',
    });
    expect(
      withExecutionContext('mission_controller', () => readTenantProfile('acme', { rootDir }))
    ).toMatchObject({
      allowed_reasoning_backends: ['claude'],
      provider_attestations: { claude: { training_use: 'none' } },
    });
  });

  it('creates new tenants strictly isolated so activation can pass memory_policy', () => {
    const result = withExecutionContext('sovereign_concierge', () =>
      mutateTenant({ verb: 'create', slug: 'beta', displayName: 'Beta', rootDir, apply: true })
    );
    expect(result.profile.isolation_policy).toEqual({
      strict_isolation: true,
      allow_cross_distillation: false,
    });
    // An update never invents a policy the existing profile did not declare.
    const updated = withExecutionContext('sovereign_concierge', () =>
      mutateTenant({ verb: 'update', slug: 'acme', displayName: 'Acme', rootDir, apply: true })
    );
    expect(updated.profile.isolation_policy).toBeUndefined();
  });

  it('requires evidence and attribution for a non-training attestation', () => {
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        recordTenantProviderAttestation({
          slug: 'acme',
          provider: 'codex',
          training_use: 'none',
          rootDir,
        })
      )
    ).toThrow('requires plan, basis, attested_by');
  });

  it('rejects an attestation for a provider the egress policy does not declare', () => {
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        attestTenantProvider({
          slug: 'acme',
          provider: 'not-a-provider',
          training_use: 'unknown',
          rootDir,
        })
      )
    ).toThrow(/unknown provider 'not-a-provider'/);
    expect(
      withExecutionContext('sovereign_concierge', () => readTenantProfile('acme', { rootDir }))
        ?.provider_attestations?.['not-a-provider']
    ).toBeUndefined();
  });
});

describe('training_use none attestations go through the human approval gate', () => {
  const parent = pathResolver.sharedTmp('tenant-governance-approval-tests');
  let rootDir = '';
  let record: ReturnType<typeof vi.spyOn>;
  const requestIds: string[] = [];

  const claim = {
    slug: 'beta',
    provider: 'codex',
    training_use: 'none' as const,
    plan: 'ChatGPT Enterprise',
    basis: 'https://openai.com/enterprise-privacy',
    attested_by: 'human:owner',
  };

  function egress(slug: string): boolean {
    return checkProviderEgress({
      provider: 'codex',
      dataTier: 'confidential',
      tenant_slug: slug,
      tenant_registry_root_dir: rootDir,
    }).allowed;
  }

  function requestApproval(overrides: Partial<typeof claim> = {}): string {
    const request = withExecutionContext('sovereign_concierge', () =>
      requestTenantProviderAttestationApproval({
        ...claim,
        ...overrides,
        rootDir,
        invoker: { actor: 'agent-requester' },
      })
    );
    requestIds.push(request.request_id);
    expect(request.approve_command).toBe(`pnpm kyberion approvals --approve ${request.request_id}`);
    return request.request_id;
  }

  function decide(
    requestId: string,
    decision: 'approved' | 'rejected',
    decider: { type: 'human' | 'ai_agent'; authenticated: boolean } = {
      type: 'human',
      authenticated: true,
    }
  ): void {
    const pending = loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, requestId)!;
    decideApprovalRequest('mission_controller', {
      channel: pending.channel,
      storageChannel: pending.storageChannel,
      requestId,
      decision,
      decidedBy: 'human-owner',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: decider.type,
      authenticated: decider.authenticated,
      payloadHash: pending.accountability?.payloadHash,
      effectBinding: pending.accountability?.effectBinding,
    });
  }

  function apply(approvalRequestId?: string, overrides: Partial<typeof claim> = {}) {
    return withExecutionContext('sovereign_concierge', () =>
      attestTenantProvider({
        ...claim,
        ...overrides,
        rootDir,
        invoker: { actor: 'operator-cli' },
        ...(approvalRequestId ? { approvalRequestId } : {}),
      })
    );
  }

  beforeEach(() => {
    rootDir = path.join(parent, `fixture-${process.pid}-${Date.now()}-${Math.random()}`);
    safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
    record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
    withExecutionContext('sovereign_concierge', () => {
      mutateTenant({ verb: 'create', slug: 'beta', rootDir, apply: true });
      mutateTenant({ verb: 'create', slug: 'gamma', rootDir, apply: true });
    });
    record.mockClear();
  });

  afterEach(() => {
    record.mockRestore();
    for (const id of requestIds.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id), {
        force: true,
      });
    }
    safeRmSync(approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), { force: true });
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('refuses to write without an approval request', () => {
    expect(() => apply()).toThrow(/needs a human approval/);
    expect(egress('beta')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a pending, a rejected and a mismatched request', () => {
    const pending = requestApproval();
    expect(() => apply(pending)).toThrow(/is pending/);

    const mismatched = requestApproval({ plan: 'Free tier' });
    decide(mismatched, 'approved');
    expect(() => apply(mismatched)).toThrow(/different training_use\/plan/);

    // The pending request above is reused for the same claim; reject it.
    decide(pending, 'rejected');
    expect(() => apply(pending)).toThrow(/is rejected/);
    expect(egress('beta')).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('writes and audits with the approver once a human approves the exact claim — once', () => {
    const id = requestApproval();
    decide(id, 'approved');
    const result = apply(id);
    expect(result.approval).toEqual({ request_id: id, approved_by: 'human-owner' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'operator-cli',
        action: 'tenant.attest_provider',
        tenantSlug: 'beta',
        metadata: expect.objectContaining({
          provider: 'codex',
          training_use: 'none',
          approved_by: 'human-owner',
          approval_request_id: id,
        }),
      })
    );
    expect(egress('beta')).toBe(true);
    expect(egress('gamma')).toBe(false);
    // At most once: the approval cannot be replayed to refresh the claim.
    expect(() => apply(id)).toThrow(/already used/);
  });

  it('cannot be approved by an agent or an unauthenticated decider', () => {
    const id = requestApproval();
    expect(() => decide(id, 'approved', { type: 'ai_agent', authenticated: true })).toThrow(
      /requires a human decider/
    );
    expect(() => decide(id, 'approved', { type: 'human', authenticated: false })).toThrow(
      /authenticated human/
    );
    expect(() => apply(id)).toThrow(/is pending/);
  });

  it('records used/unknown without approval (they never open egress)', () => {
    const result = apply(undefined, { training_use: 'used' } as never);
    expect(result.attestation.training_use).toBe('used');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'operator-cli', action: 'tenant.attest_provider' })
    );
    expect(egress('beta')).toBe(false);
  });

  it('refuses a cross-tenant request and a validity beyond the policy TTL', () => {
    expect(() =>
      withExecutionContext(
        'sovereign_concierge',
        () => requestTenantProviderAttestationApproval({ ...claim, slug: 'beta', rootDir }),
        undefined,
        'gamma'
      )
    ).toThrow(/cross-tenant attestation refused/);
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        attestTenantProvider({
          ...claim,
          training_use: 'unknown',
          rootDir,
          invoker: { actor: 'x', tenantSlug: 'gamma' },
        })
      )
    ).toThrow(/cross-tenant attestation refused/);
    expect(() => requestApproval({ valid_for_days: 365 } as never)).toThrow(
      /exceeds the policy attestation_ttl_days \(180\)/
    );
  });

  describe('with approval separation of duties switched on', () => {
    const overlayPath = pathResolver.sharedTmp(`tenant-governance-sod-${process.pid}.json`);

    beforeEach(() => {
      const product = JSON.parse(
        safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
          encoding: 'utf8',
        }) as string
      );
      safeWriteFile(
        overlayPath,
        JSON.stringify({ ...product, separation_of_duties: { enabled: true } })
      );
      sod.overlayPath = overlayPath;
    });

    afterEach(() => {
      sod.overlayPath = null;
      safeRmSync(overlayPath, { force: true });
    });

    it('refuses a human approving the attestation they requested, and nothing is written', () => {
      const request = withExecutionContext('sovereign_concierge', () =>
        requestTenantProviderAttestationApproval({
          ...claim,
          rootDir,
          invoker: { actor: 'human-owner' },
        })
      );
      requestIds.push(request.request_id);
      expect(() => decide(request.request_id, 'approved')).toThrow(
        /\[POLICY_VIOLATION\] Separation of duties/
      );
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'separation_of_duties',
          result: 'denied',
          metadata: expect.objectContaining({
            requestId: request.request_id,
            violation: 'self_approval',
          }),
        })
      );
      expect(() => apply(request.request_id)).toThrow(/is pending/);
      expect(egress('beta')).toBe(false);
    });

    it('still applies an agent-requested attestation approved by a different human', () => {
      const id = requestApproval();
      decide(id, 'approved');
      const result = apply(id);
      expect(result.approval).toEqual({ request_id: id, approved_by: 'human-owner' });
      expect(egress('beta')).toBe(true);
    });
  });
});
