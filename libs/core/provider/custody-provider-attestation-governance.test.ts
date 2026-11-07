/**
 * Approval-mediated system / person custody attestations: `none` needs an
 * authenticated human decision by the installation owner, bound to the exact
 * claim, used once; self-approval is refused under separation of duties; a
 * tenant-bound caller cannot author the installation's statement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../daemon/ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

const sod = vi.hoisted(() => ({ overlayPath: null as string | null }));
vi.mock('../authn/stance-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authn/stance-resolver.js')>();
  return {
    ...actual,
    stanceRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.stanceRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

import { withExecutionContext } from '../authority.js';
import { auditChain } from '../governance/audit-chain.js';
import { resolveSeparationOfDutiesPolicy } from '../governance/approval-policy.js';
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
  INSTALLATION_OWNER_APPROVAL_PRINCIPAL,
  readCustodyProviderAttestationEntry,
  writeCustodyProviderAttestationEntry,
} from './custody-provider-attestation-store.js';
import { checkProviderEgress, lookupCustodyProviderAttestation } from './provider-egress-gate.js';
import { INSTALLATION_OWNER_MEMBER_ID } from '../surface/installation-owner-access.js';

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
    decider: {
      type: 'human' | 'ai_agent';
      authenticated: boolean;
      role?: string;
      decidedBy?: string;
    } = {
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
      decidedBy: decider.decidedBy ?? 'human-owner',
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

  describe("person custody: the attestation is the person's own consent", () => {
    const alice = { kind: 'person', principal_id: 'user:alice' } as const;
    const asHuman = (decidedBy: string) => ({
      type: 'human' as const,
      authenticated: true,
      decidedBy,
    });
    const personalEgress = (custody: AttestCustodyProviderInput['custody'] = alice) =>
      checkProviderEgress({ provider: 'claude', dataTier: 'personal', custody });

    it('records the subject on the request and refuses the installation owner deciding it', () => {
      const id = requestApproval('agent-requester', { custody: alice });
      const pending = loadApprovalRequest(CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id)!;
      expect(pending.accountability?.consent).toEqual({
        subject: 'user:alice',
        subject_only: true,
      });
      expect(pending.details).toContain(
        "Decided by: user:alice only — this is the person's own consent"
      );
      expect(() => decide(id, asHuman('human-owner'))).toThrow(
        /\[POLICY_VIOLATION\] approval refused — request .* records the consent of 'user:alice', which only that principal can give \| next: have 'user:alice' decide it .* \| evidence: decided_by=human-owner consent_subject=user:alice/
      );
      expect(() => apply(id, { custody: alice })).toThrow(/is pending/);
    });

    it("applies the person's own decision, which opens egress only with the installation's no-training attestation", () => {
      const id = requestApproval('agent-requester', { custody: alice });
      decide(id, asHuman('user:alice'));
      expect(apply(id, { custody: alice }).approval).toEqual({
        request_id: id,
        approved_by: 'user:alice',
      });
      // Consent alone is not evidence that the provider does not train.
      const denied = personalEgress();
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toMatch(
        /person custody \(person:user:alice\) consents to 'claude', but its consent is not evidence that the provider does not train and the installation \(system custody\) has no training_use none attestation/
      );
      const system = requestApproval('agent-requester');
      decide(system);
      apply(system);
      expect(personalEgress().allowed).toBe(true);
      // The system attestation never speaks for a person who has not consented.
      expect(personalEgress({ kind: 'person', principal_id: 'user:bob' }).allowed).toBe(false);
    });

    it('reads a person attestation decided by someone else as no consent, without deleting it', () => {
      asOperator(() =>
        writeCustodyProviderAttestationEntry(alice, 'claude', {
          training_use: 'none',
          plan: 'Claude Team',
          basis: 'ref:legacy',
          attested_by: 'human:owner',
          attested_at: new Date().toISOString(),
          approval: { request_id: 'legacy-req', approved_by: 'human-owner' },
        })
      );
      const system = requestApproval('agent-requester');
      decide(system);
      apply(system);
      expect(personalEgress().allowed).toBe(false);
      expect(readCustodyProviderAttestationEntry(alice, 'claude').error).toBeUndefined();
      expect(
        lookupCustodyProviderAttestation({ custody: alice, provider: 'claude' }).error
      ).toMatch(
        /is not the person's consent: it was decided by 'human-owner', not by 'user:alice'/
      );
    });
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
      expect(resolveSeparationOfDutiesPolicy()).toEqual({ enabled: true });
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

    it('lets a person decide the consent they requested, and keeps system self-approval refused', () => {
      const alice = { kind: 'person', principal_id: 'user:alice' } as const;
      const asAlice = { type: 'human' as const, authenticated: true, decidedBy: 'user:alice' };
      const id = requestApproval('user:alice', { custody: alice });
      decide(id, asAlice);
      expect(apply(id, { custody: alice }).approval).toEqual({
        request_id: id,
        approved_by: 'user:alice',
      });
      // The exception is narrow: a system attestation is still refused to its requester.
      const system = requestApproval('user:alice');
      expect(() => decide(system, asAlice)).toThrow(/Separation of duties/);
    });

    it('single-user install: the owner records the system attestation and their own consent without deadlock', () => {
      expect(INSTALLATION_OWNER_APPROVAL_PRINCIPAL).toBe(`user:${INSTALLATION_OWNER_MEMBER_ID}`);
      const operator = { kind: 'person' } as const;
      const asOwner = { type: 'human' as const, authenticated: true, decidedBy: 'user:owner' };
      const personalEgress = () =>
        checkProviderEgress({ provider: 'claude', dataTier: 'personal' }).allowed;
      // System attestation: opened by an agent, decided by the owner (SoD as before).
      const system = requestApproval('agent-requester');
      decide(system, asOwner);
      apply(system);
      expect(personalEgress()).toBe(false);
      // Consent: the owner opens and decides it — the owner is the subject.
      const consent = requestApproval('user:owner', { custody: operator });
      expect(
        loadApprovalRequest(CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL, consent)!.accountability
          ?.consent
      ).toEqual({ subject: 'user:owner', subject_only: false });
      decide(consent, asOwner);
      expect(apply(consent, { custody: operator }).approval).toEqual({
        request_id: consent,
        approved_by: 'user:owner',
      });
      expect(personalEgress()).toBe(true);
    });
  });
});
