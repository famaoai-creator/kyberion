/**
 * Approval-mediated system / person custody attestations: `none` needs an
 * authenticated human decision by the installation owner, bound to the exact
 * claim, used once; self-approval is refused under separation of duties; a
 * tenant-bound caller cannot author the installation's statement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

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
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  computeApprovalPresentedDigest,
  decideApprovalRequest,
  loadApprovalRequest,
} from '../governance/approval-store.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  attestCustodyProvider,
  CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
  requestCustodyProviderAttestationApproval,
  type AttestCustodyProviderInput,
} from './custody-provider-attestation-governance.js';
import {
  CUSTODY_PROVIDER_ATTESTATION_ROOT,
  readCustodyProviderAttestationEntry,
} from './custody-provider-attestation-store.js';
import { checkProviderEgress } from './provider-egress-gate.js';

const claim: Omit<AttestCustodyProviderInput, 'invoker'> = {
  custody: { kind: 'system' },
  provider: 'claude',
  training_use: 'none',
  plan: 'Claude Team',
  basis: 'https://www.anthropic.com/legal/commercial-terms',
  attested_by: 'human:owner',
};

const asOperator = <T>(fn: () => T): T => withExecutionContext('sovereign_concierge', fn);
const egress = () => checkProviderEgress({ provider: 'claude', dataTier: 'confidential' }).allowed;

describe('custody provider attestation governance', () => {
  const requestIds: string[] = [];
  let record: ReturnType<typeof vi.spyOn>;

  function requestApproval(actor = 'agent-requester', overrides = {}): string {
    const request = asOperator(() =>
      requestCustodyProviderAttestationApproval({ ...claim, ...overrides, invoker: { actor } })
    );
    requestIds.push(request.request_id);
    return request.request_id;
  }

  function decide(
    requestId: string,
    decider: { type: 'human' | 'ai_agent'; authenticated: boolean; role?: string } = {
      type: 'human',
      authenticated: true,
    }
  ): void {
    const pending = loadApprovalRequest(CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL, requestId)!;
    decideApprovalRequest('mission_controller', {
      channel: pending.channel,
      storageChannel: pending.storageChannel,
      requestId,
      decision: 'approved',
      decidedBy: 'human-owner',
      decidedByRole: decider.role ?? 'owner',
      authMethod: 'surface_session',
      decidedByType: decider.type,
      authenticated: decider.authenticated,
      payloadHash: pending.accountability?.payloadHash,
      effectBinding: pending.accountability?.effectBinding,
      presentedDigest: computeApprovalPresentedDigest(pending),
    });
  }

  const apply = (approvalRequestId?: string, overrides = {}) =>
    asOperator(() =>
      attestCustodyProvider({
        ...claim,
        ...overrides,
        invoker: { actor: 'operator-cli' },
        ...(approvalRequestId ? { approvalRequestId } : {}),
      })
    );

  beforeEach(() => {
    record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    record.mockRestore();
    for (const id of requestIds.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id), {
        force: true,
      });
    }
    safeRmSync(approvalEventLogicalPath(CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL), {
      force: true,
    });
    asOperator(() =>
      safeRmSync(pathResolver.rootResolve(CUSTODY_PROVIDER_ATTESTATION_ROOT), {
        recursive: true,
        force: true,
      })
    );
  });

  it("refuses 'none' without an approval and writes nothing", () => {
    expect(() => apply()).toThrow(
      /needs a human approval: request one with 'pnpm onboarding llm attest --custody system --provider claude/
    );
    expect(readCustodyProviderAttestationEntry({ kind: 'system' }, 'claude')).toEqual({});
    expect(egress()).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('applies once after an authenticated installation-owner decision, storing the approval basis', () => {
    const id = requestApproval();
    const pending = loadApprovalRequest(CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id)!;
    expect(pending.scope).toMatchObject({ scope_kind: 'system' });
    expect(pending.scope?.tenant_slug).toBeUndefined();
    expect(() => apply(id)).toThrow(/is pending/);
    decide(id);
    const result = apply(id);
    expect(result.approval).toEqual({ request_id: id, approved_by: 'human-owner' });
    expect(result.attestation.approval).toEqual({ request_id: id, approved_by: 'human-owner' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'operator-cli',
        action: 'provider.attest_custody',
        metadata: expect.objectContaining({
          custody: 'system',
          approved_by: 'human-owner',
          approval_request_id: id,
        }),
      })
    );
    expect(egress()).toBe(true);
    expect(() => apply(id)).toThrow(/already used/);
  });

  it('refuses an approval bound to a different claim, and an unauthenticated or agent decision', () => {
    const otherPlan = requestApproval('agent-requester', { plan: 'Claude Free' });
    decide(otherPlan);
    expect(() => apply(otherPlan)).toThrow(/different training_use\/plan/);

    const agentDecided = requestApproval('agent-requester', { basis: 'ref:agent' });
    expect(() => {
      decide(agentDecided, { type: 'ai_agent', authenticated: true });
      apply(agentDecided, { basis: 'ref:agent' });
    }).toThrow(/POLICY_VIOLATION|human/);
    expect(egress()).toBe(false);
  });

  it('caps validity at the policy TTL and refuses an undeclared provider', () => {
    expect(() => requestApproval('agent-requester', { valid_for_days: 365 })).toThrow(
      /exceeds the policy attestation_ttl_days \(180\)/
    );
    expect(() => requestApproval('agent-requester', { provider: 'nope' })).toThrow(
      /unknown provider 'nope'/
    );
  });

  it('refuses a tenant-bound caller', () => {
    expect(() =>
      withExecutionContext(
        'mission_controller',
        () => requestCustodyProviderAttestationApproval({ ...claim, invoker: { actor: 'x' } }),
        undefined,
        'acme'
      )
    ).toThrow(/active tenant scope 'acme' cannot attest for the installation/);
    expect(() =>
      apply(undefined, { training_use: 'used', plan: undefined, basis: undefined })
    ).not.toThrow();
    expect(() =>
      asOperator(() =>
        attestCustodyProvider({
          ...claim,
          training_use: 'used',
          invoker: { actor: 'x', tenantSlug: 'acme' },
        })
      )
    ).toThrow(/active tenant scope 'acme'/);
  });

  describe('with approval separation of duties switched on', () => {
    const overlayPath = pathResolver.sharedTmp(`custody-attestation-sod-${process.pid}.json`);

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

    it('refuses the installation owner approving the attestation they requested', () => {
      const id = requestApproval('human-owner');
      expect(() => decide(id)).toThrow(/\[POLICY_VIOLATION\] Separation of duties/);
      expect(() => apply(id)).toThrow(/is pending/);
      expect(egress()).toBe(false);
    });

    it('applies an agent-requested attestation approved by the installation owner', () => {
      const id = requestApproval('agent-requester');
      decide(id);
      expect(apply(id).approval).toEqual({ request_id: id, approved_by: 'human-owner' });
      expect(egress()).toBe(true);
    });
  });
});
