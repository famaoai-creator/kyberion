import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvalRequestLogicalPath,
  approvalStoreRoots,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  resolveApprovalAssuranceMode,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { resolvePolicyApprovalAssuranceMode, resolveApprovalPolicy } from './approval-policy.js';
import { auditChain } from './audit-chain.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';

/**
 * HA-07 / HA-08: the governed assurance mode, the A3 classes, and how the
 * validator treats requests created before it (pending: judged now; decided:
 * never re-graded).
 */
const CHANNEL = `assurance-migration-${process.pid}`;
const PROJECT_TRUST = 'project-trust';
const ROLE = 'mission_controller' as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  withExecutionContext(ROLE, () => {
    for (const root of Object.values(approvalStoreRoots())) {
      for (const channel of [CHANNEL, PROJECT_TRUST]) {
        const dir = pathResolver.rootResolve(`${root}/${channel}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

function request(
  correlationId: string,
  options: { channel?: string; min_assurance?: 'A2' | 'A3' } = {}
): ApprovalRequestRecord {
  return createApprovalRequest(ROLE, {
    channel: options.channel ?? CHANNEL,
    threadTs: '1',
    correlationId,
    requestedBy: 'agent:planner',
    draft: { title: `Fixture ${correlationId}`, summary: 'HA-08 fixture' },
    accountability: {
      finalDecision: 'human_only',
      ...(options.min_assurance ? { min_assurance: options.min_assurance } : {}),
      payloadHash: computeApprovalPayloadHash({ fixture: correlationId }),
      effectBinding: `fixture:${correlationId}`,
    },
  });
}

/** Rewrite a stored request as it would have been written before a rule existed. */
function rewriteAsLegacy(record: ApprovalRequestRecord, accountability: Record<string, unknown>) {
  const legacy = { ...record, accountability } as ApprovalRequestRecord;
  writeGovernedArtifactJson(
    ROLE,
    approvalRequestLogicalPath(record.storageChannel, record.id),
    legacy
  );
  return legacy;
}

function decide(
  record: ApprovalRequestRecord,
  authMethod: 'manual' | 'surface_session' | 'terminal_attested'
) {
  return decideApprovalRequest(ROLE, {
    channel: record.channel,
    storageChannel: record.storageChannel,
    requestId: record.id,
    decision: 'approved',
    decidedBy: 'user:owner',
    decidedByType: 'human',
    authenticated: true,
    authMethod,
    presentedDigest: computeApprovalPresentedDigest(record),
  });
}

describe('assurance mode (HA-08)', () => {
  it('ships warn in the governed approval policy', () => {
    expect(resolvePolicyApprovalAssuranceMode()).toBe('warn');
    expect(resolveApprovalAssuranceMode({})).toBe('warn');
  });

  it('is the stricter of the policy and KYBERION_APPROVAL_ASSURANCE', () => {
    expect(resolveApprovalAssuranceMode({}, undefined)).toBe('warn');
    expect(resolveApprovalAssuranceMode({}, 'warn')).toBe('warn');
    expect(resolveApprovalAssuranceMode({}, 'enforce')).toBe('enforce');
    expect(resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'enforce' }, 'warn')).toBe(
      'enforce'
    );
    expect(
      resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'enforce' }, undefined)
    ).toBe('enforce');
    // The deciding process's environment cannot relax a governed enforce.
    expect(resolveApprovalAssuranceMode({ KYBERION_APPROVAL_ASSURANCE: 'warn' }, 'enforce')).toBe(
      'enforce'
    );
  });
});

describe('A3 classes (HA-07)', () => {
  it('raises dual-key and policy-change rules to A3 in the governed policy', () => {
    expect(resolveApprovalPolicy({ intentId: 'secret:grant_access' }).minAssurance).toBe('A3');
    expect(resolveApprovalPolicy({ intentId: 'vault:write' }).minAssurance).toBe('A3');
    expect(
      resolveApprovalPolicy({ intentId: 'config:update', payload: { scope: 'policy' } })
        .minAssurance
    ).toBe('A3');
    expect(resolveApprovalPolicy({ intentId: 'ingress:expose' }).minAssurance).toBeUndefined();
  });

  it('refuses an A3 request decided with a session under enforce, pointing to the passkey', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const record = request('a3-enforce', { min_assurance: 'A3' });
    expect(() => decide(record, 'surface_session')).toThrow(
      /requires assurance A3; surface_session provides A2 \| next: approve it with a passkey/u
    );
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });

  it('lets an A3 shortfall through under warn and records it', () => {
    const audit = vi.spyOn(auditChain, 'record');
    const record = request('a3-warn', { min_assurance: 'A3' });
    const decided = decide(record, 'surface_session');
    expect(decided.status).toBe('approved');
    expect(decided.assuranceShortfall).toEqual({
      required: 'A3',
      provided: 'A2',
      authMethod: 'surface_session',
      mode: 'warn',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'assurance_shortfall', result: 'allowed' })
    );
  });
});

describe('requests created before the validator (HA-08)', () => {
  it('judges a pending pre-HA-03 request (no min_assurance) by today’s validator', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const record = request('legacy-pending');
    const legacy = rewriteAsLegacy(record, {
      finalDecision: 'human_only',
      payloadHash: record.accountability!.payloadHash,
      effectBinding: record.accountability!.effectBinding,
    });
    expect(loadApprovalRequest(CHANNEL, record.id)?.accountability?.min_assurance).toBeUndefined();
    expect(() => decide(legacy, 'manual')).toThrow(/requires assurance A2; manual provides A1/u);
    expect(decide(legacy, 'surface_session').status).toBe('approved');
  });

  it('raises a pending project-trust request created at A2 to today’s A3 floor', () => {
    const record = request('legacy-trust', { channel: PROJECT_TRUST, min_assurance: 'A2' });
    expect(record.accountability?.min_assurance).toBe('A2');
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    expect(() => decide(record, 'terminal_attested')).toThrow(/requires assurance A3/u);
    vi.unstubAllEnvs();
    const decided = decide(record, 'terminal_attested');
    expect(decided.assuranceShortfall).toMatchObject({ required: 'A3', provided: 'A2' });
  });

  it('never re-grades a decided record, even once enforce is on', () => {
    const record = request('legacy-decided');
    const decided = decide(record, 'manual');
    expect(decided.status).toBe('approved');
    expect(decided.assuranceShortfall).toMatchObject({ required: 'A2', provided: 'A1' });
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    expect(
      validateHumanFinalDecision({
        accountability: decided.accountability,
        decidedByType: decided.decidedByType,
        authenticated: decided.authenticated,
        authMethod: decided.decidedAuthMethod,
        payloadHash: decided.accountability?.payloadHash,
        effectBinding: decided.accountability?.effectBinding,
        phase: 'recheck',
        channel: CHANNEL,
      })
    ).toBeUndefined();
    const reloaded = loadApprovalRequest(CHANNEL, record.id);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.decidedAuthMethod).toBe('manual');
    expect(reloaded?.assuranceShortfall).toMatchObject({ mode: 'warn' });
  });
});

describe('pending requests created before this policy (M2)', () => {
  function legacyGateRecord(correlationId: string, effectBinding: string) {
    const record = request(correlationId, { min_assurance: 'A2' });
    // A gate request written before HA-07: A2, no policy_rule_id.
    return rewriteAsLegacy(record, {
      finalDecision: 'human_only',
      min_assurance: 'A2',
      payloadHash: record.accountability!.payloadHash,
      effectBinding,
    });
  }

  it('judges a pending pre-PR dual-key request at A3', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const legacy = legacyGateRecord('legacy-dual-key', 'vault:write');
    expect(() => decide(legacy, 'surface_session')).toThrow(
      /requires assurance A3; surface_session provides A2/u
    );
    expect(loadApprovalRequest(CHANNEL, legacy.id)?.status).toBe('pending');
  });

  it('judges a pending pre-PR policy-change request at A3 (warn: shortfall recorded)', () => {
    const legacy = legacyGateRecord('legacy-policy-change', 'config:update');
    const decided = decide(legacy, 'surface_session');
    expect(decided.assuranceShortfall).toEqual({
      required: 'A3',
      provided: 'A2',
      authMethod: 'surface_session',
      mode: 'warn',
    });
  });

  it('takes the union of the recorded rule and the effect: a gate-internal id never lowers it', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const record = request('rule-id', { min_assurance: 'A2' });
    const recorded = rewriteAsLegacy(record, {
      finalDecision: 'human_only',
      min_assurance: 'A2',
      policy_rule_id: 'strict-posture-floor',
      payloadHash: record.accountability!.payloadHash,
      effectBinding: 'vault:write',
    });
    expect(() => decide(recorded, 'surface_session')).toThrow(/requires assurance A3/u);
  });

  it('judges a pending pre-PR dual-key request from the built-in secret fallback at A3', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const legacy = legacyGateRecord('legacy-fallback-secret', 'secret:rotate');
    expect(() => decide(legacy, 'surface_session')).toThrow(/requires assurance A3/u);
  });

  it('leaves an effect no A3 rule names at its recorded level', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const legacy = legacyGateRecord('legacy-ingress', 'ingress:expose');
    expect(decide(legacy, 'surface_session').status).toBe('approved');
  });

  it('leaves a decided pre-PR request alone', () => {
    const legacy = legacyGateRecord('legacy-decided-dual-key', 'vault:write');
    const decided = decide(legacy, 'surface_session');
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    expect(
      validateHumanFinalDecision({
        accountability: decided.accountability,
        decidedByType: decided.decidedByType,
        authenticated: decided.authenticated,
        authMethod: decided.decidedAuthMethod,
        payloadHash: decided.accountability?.payloadHash,
        effectBinding: decided.accountability?.effectBinding,
        phase: 'recheck',
        channel: CHANNEL,
      })
    ).toBeUndefined();
  });

  it('records the matched rule on new gate requests', () => {
    expect(resolveApprovalPolicy({ intentId: 'vault:write' }).matchedRuleId).toBe(
      'vault-direct-write'
    );
  });
});

describe('agent refusal stays enforced in warn mode (HA-02)', () => {
  it('refuses an agent principal on a human-only request while the mode is warn', () => {
    expect(resolveApprovalAssuranceMode()).toBe('warn');
    const record = request('agent-in-warn');
    expect(() =>
      decideApprovalRequest(ROLE, {
        channel: record.channel,
        storageChannel: record.storageChannel,
        requestId: record.id,
        decision: 'approved',
        decidedBy: 'user:owner',
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'surface_session',
        presentedDigest: computeApprovalPresentedDigest(record),
        deciderPrincipal: {
          actor: { kind: 'agent', id: 'agent:planner' },
          source: 'agent',
          provider: 'agent-token',
          principalId: 'agent:planner',
        },
      })
    ).toThrow(/\[APPROVAL_HUMAN_PROOF_REQUIRED\]/u);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });
});
