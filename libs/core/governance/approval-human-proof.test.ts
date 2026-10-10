import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvalEventLogicalPath,
  approvalPresentedDigestMatches,
  approvalStoreRoots,
  compactApprovalPresentedDigest,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  createApprovalRequest,
  decideApprovalRequest,
  loadApprovalRequest,
  lookupSessionApprovalCache,
  resolveCompactPresentedDigest,
  surfaceDecisionBinding,
} from './approval-store.js';
import { auditChain } from './audit-chain.js';
import { surfaceDecisionAuthMethod } from './approval-assurance.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';

/**
 * HA-06 presented-digest binding, the store-level refusal of human-only
 * decisions from an agent process (with the surface-server exemption), and
 * the warn-mode session-cache carry-over.
 */
const CHANNEL = `human-proof-${process.pid}`;
const PAYLOAD_HASH = computeApprovalPayloadHash({ effect: 'deploy', target: 'prod' });

const CARD = {
  question: 'Deploy the reviewed build to prod?',
  recommendation: 'Approve after CI is green.',
  riskTier: 'approve' as const,
  riskReasons: ['touches production'],
  reversible: false,
  evidence: [{ label: 'PR', ref: 'https://example.com/pr/1' }],
};

function humanOnly(correlationId: string, title = 'Deploy to prod') {
  return createApprovalRequest('mission_controller', {
    channel: CHANNEL,
    threadTs: '1',
    correlationId,
    requestedBy: 'agent:planner',
    draft: { title, summary: 'HA-06 fixture' },
    justification: { reason: 'release train' },
    decisionCard: CARD,
    risk: { level: 'high', restartScope: 'service', requiresStrongAuth: true },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: PAYLOAD_HASH,
      effectBinding: 'deploy:prod',
    },
  });
}

const human = {
  decidedBy: 'user:owner',
  decidedByType: 'human' as const,
  authenticated: true,
  authMethod: 'surface_session' as const,
};

function events(): Array<Record<string, unknown>> {
  const text = withExecutionContext('mission_controller', () =>
    safeReadFile(pathResolver.rootResolve(approvalEventLogicalPath(CHANNEL)), { encoding: 'utf8' })
  ) as string;
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(approvalStoreRoots())) {
      const dir = pathResolver.rootResolve(`${root}/${CHANNEL}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('presented digest (HA-06)', () => {
  it('covers the action, target and effect the decider was shown', () => {
    const record = humanOnly('digest-shape');
    const digest = computeApprovalPresentedDigest(record);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(approvalPresentedDigestMatches(record, digest)).toBe(true);
    const compact = compactApprovalPresentedDigest(record);
    // The compact prefix is a chat-callback affordance only (explicit option).
    expect(approvalPresentedDigestMatches(record, compact)).toBe(false);
    expect(approvalPresentedDigestMatches(record, compact, { allowCompact: true })).toBe(true);
    expect(approvalPresentedDigestMatches(record, digest.slice(0, 20))).toBe(false);
    expect(approvalPresentedDigestMatches(record, 'not-hex')).toBe(false);
    for (const changed of [
      { ...record, title: 'Deploy to staging' },
      { ...record, accountability: { ...record.accountability!, payloadHash: '0'.repeat(64) } },
      { ...record, accountability: { ...record.accountability!, effectBinding: 'deploy:dev' } },
    ]) {
      expect(approvalPresentedDigestMatches(changed, digest)).toBe(false);
    }
  });

  it('covers every field a surface displays: requester, justification and the card body', () => {
    const record = humanOnly('digest-displayed');
    const digest = computeApprovalPresentedDigest(record);
    expect(record.work_loop).toBeDefined();
    expect(record.risk).toBeDefined();
    const card = record.decisionCard!;
    for (const changed of [
      { ...record, requestedBy: 'agent:other' },
      { ...record, requestedByContext: { ...record.requestedByContext, actorId: 'agent:relay' } },
      { ...record, justification: { reason: 'something else' } },
      { ...record, decisionCard: { ...card, question: 'Deploy to staging?' } },
      { ...record, decisionCard: { ...card, recommendation: 'Reject.' } },
      { ...record, decisionCard: { ...card, riskReasons: [] } },
      { ...record, decisionCard: { ...card, reversible: true } },
      { ...record, decisionCard: { ...card, evidence: [] } },
      { ...record, decisionCard: undefined },
      // Chronos approvals workspace / mission intelligence, Concierge queue,
      // Presence Studio inbox, Slack and chat text cards.
      { ...record, kind: 'mission_gate' as const },
      { ...record, channel: 'other-channel' },
      { ...record, severity: 'high' as const },
      { ...record, sourceText: 'deploy prod please' },
      { ...record, requestedAt: '2026-01-01T00:00:00.000Z' },
      { ...record, expiresAt: '2026-01-02T00:00:00.000Z' },
      { ...record, requestedByDisplayName: 'Mallory' },
      {
        ...record,
        requestedByContext: { ...record.requestedByContext, missionId: 'MSN-OTHER' },
      },
      { ...record, justification: { reason: 'release train', impactSummary: 'none' } },
      { ...record, justification: { reason: 'release train', requestedEffects: ['wipe db'] } },
      {
        ...record,
        risk: { level: 'low', restartScope: 'none', requiresStrongAuth: false },
      },
      {
        ...record,
        risk: { level: 'low', restartScope: 'none', requiresStrongAuth: false, policyId: 'p-2' },
      },
      { ...record, scope: { ...record.scope, organization_id: 'org-other' } },
      { ...record, track_name: 'Other track' },
      {
        ...record,
        work_loop: {
          ...record.work_loop!,
          context: { ...record.work_loop!.context, project_id: 'project-other' },
        },
      },
      { ...record, veto: { windowMinutes: 30, deliveryDeadlineAt: '2026-01-01T00:00:00.000Z' } },
    ]) {
      expect(computeApprovalPresentedDigest(changed)).not.toBe(digest);
    }
    // Delivery bookkeeping is not displayed and does not move the digest.
    expect(
      computeApprovalPresentedDigest({ ...record, decisionCard: { ...card, actionId: 'a-1' } })
    ).toBe(digest);
  });

  it('covers the work-loop disclosure and the tenant Chronos reads from the requester', () => {
    const record = humanOnly('digest-work-loop');
    const digest = computeApprovalPresentedDigest(record);
    const loop = record.work_loop!;
    for (const changed of [
      { ...record, work_loop: { ...loop, intent: { label: 'wipe production' } } },
      {
        ...record,
        work_loop: {
          ...loop,
          resolution: { ...loop.resolution, execution_shape: 'mission' as const },
        },
      },
      {
        ...record,
        work_loop: { ...loop, outcome_design: { ...loop.outcome_design, labels: ['other'] } },
      },
      { ...record, work_loop: { ...loop, teaming: { ...loop.teaming, team_roles: ['owner'] } } },
      { ...record, work_loop: { ...loop, authority: { requires_approval: false } } },
      {
        ...record,
        work_loop: { ...loop, context: { ...loop.context, tenant_slug: 'tenant-b' } },
      },
      {
        ...record,
        requestedByContext: {
          surface: 'chronos' as const,
          actorId: 'agent:planner',
          actorRole: 'planner',
          tenant_slug: 'tenant-b',
        },
      },
    ]) {
      expect(computeApprovalPresentedDigest(changed)).not.toBe(digest);
    }
  });

  it('covers the creation-time workflow shape but not the approvals collected so far', () => {
    const record = {
      ...humanOnly('digest-workflow'),
      workflow: {
        workflowId: 'wf-1',
        mode: 'all_required' as const,
        requiredRoles: ['owner', 'security'],
        stages: [{ stageId: 's-1', requiredRoles: ['owner'] }],
        approvals: [],
      },
    };
    const digest = computeApprovalPresentedDigest(record);
    expect(
      computeApprovalPresentedDigest({
        ...record,
        workflow: { ...record.workflow, mode: 'any_of' },
      })
    ).not.toBe(digest);
    expect(
      computeApprovalPresentedDigest({
        ...record,
        workflow: { ...record.workflow, requiredRoles: ['owner'] },
      })
    ).not.toBe(digest);
    expect(
      computeApprovalPresentedDigest({
        ...record,
        workflow: { ...record.workflow, stages: [{ stageId: 's-2', requiredRoles: ['owner'] }] },
      })
    ).not.toBe(digest);
    expect(
      computeApprovalPresentedDigest({
        ...record,
        workflow: {
          ...record.workflow,
          currentStage: 's-1',
          approvals: [{ role: 'owner', status: 'approved' as const, approvedBy: 'user:owner' }],
        },
      })
    ).toBe(digest);
  });

  it("covers a steering request's verb and mission but not its reply routing", () => {
    const steering = {
      kind: 'mission_lifecycle_verb' as const,
      verb: 'verify' as const,
      missionId: 'MSN-A',
      surface: 'slack' as const,
      channel: 'c-1',
      threadTs: 't-1',
      correlationId: 'corr-1',
    };
    const record = { ...humanOnly('digest-steering'), steering };
    const digest = computeApprovalPresentedDigest(record);
    expect(
      computeApprovalPresentedDigest({ ...record, steering: { ...steering, verb: 'finish' } })
    ).not.toBe(digest);
    expect(
      computeApprovalPresentedDigest({ ...record, steering: { ...steering, missionId: 'MSN-B' } })
    ).not.toBe(digest);
    expect(
      computeApprovalPresentedDigest({
        ...record,
        steering: { ...steering, threadTs: 't-2', correlationId: 'corr-2' },
      })
    ).toBe(digest);
  });

  it('refuses a decision whose shown card differs from the stored one', () => {
    const record = humanOnly('digest-card-stale');
    const shown = computeApprovalPresentedDigest({
      ...record,
      decisionCard: { ...record.decisionCard!, recommendation: 'Approve now, CI is optional.' },
    });
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        ...human,
        presentedDigest: shown,
      })
    ).toThrow(/changed since it was shown to the decider/);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });

  it('refuses the compact prefix outside the chat callback path (HTTP routes, store)', () => {
    const record = humanOnly('digest-compact-http');
    const compact = compactApprovalPresentedDigest(record);
    expect(surfaceDecisionBinding(record, compact)).toEqual({ presentedDigest: compact });
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        ...human,
        ...surfaceDecisionBinding(record, compact),
      })
    ).toThrow(/changed since it was shown to the decider/);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
    expect(resolveCompactPresentedDigest(record, compact)).toBe(
      computeApprovalPresentedDigest(record)
    );
    expect(resolveCompactPresentedDigest(record, '000000000000')).toBeNull();
  });

  it('enforce: a loopback (manual) human-only decision is refused even with a digest', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const record = humanOnly('loopback-manual-enforce');
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        ...human,
        authMethod: surfaceDecisionAuthMethod({ provider: 'loopback-local' }, true),
        presentedDigest: computeApprovalPresentedDigest(record),
      })
    ).toThrow(/requires assurance A2; manual provides A1/u);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });

  it('binds a decision to the stored effect through the digest, without echoing payloadHash', () => {
    const record = humanOnly('digest-bound');
    const decided = decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      ...human,
      presentedDigest: computeApprovalPresentedDigest(record),
    });
    expect(decided.status).toBe('approved');
    const event = events().find((entry) => entry.event === 'approved')!;
    expect(event.payload_hash).toBe(PAYLOAD_HASH);
    expect(event.effect_binding).toBe('deploy:prod');
    expect(event.presented_digest).toBe(computeApprovalPresentedDigest(record));
  });

  it('refuses a decision taken on a view the request no longer matches', () => {
    const record = humanOnly('digest-stale');
    const stale = computeApprovalPresentedDigest({ ...record, title: 'What was shown earlier' });
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        ...human,
        presentedDigest: stale,
      })
    ).toThrow(/changed since it was shown to the decider/);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });

  it('warn: a human-only decision without a digest falls back to self-matching and is audited', () => {
    const audit = vi.spyOn(auditChain, 'record');
    const record = humanOnly('digest-missing-warn');
    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      ...human,
      payloadHash: PAYLOAD_HASH,
      effectBinding: 'deploy:prod',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'presented_digest_missing', result: 'allowed' })
    );
  });

  it('enforce: a human-only decision without a digest is refused', () => {
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE', 'enforce');
    const record = humanOnly('digest-missing-enforce');
    expect(() =>
      decideApprovalRequest('mission_controller', {
        channel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        ...human,
        payloadHash: PAYLOAD_HASH,
        effectBinding: 'deploy:prod',
      })
    ).toThrow(/decided without the digest of what the decider was shown/);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });
});

describe('store-level refusal of agent processes', () => {
  const decide = (id: string, extra: Partial<Parameters<typeof decideApprovalRequest>[1]> = {}) =>
    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: id,
      decision: 'approved',
      ...human,
      presentedDigest: computeApprovalPresentedDigest(loadApprovalRequest(CHANNEL, id)!),
      ...extra,
    });

  it('refuses a human-only decision from a process inside a provider CLI session', () => {
    vi.stubEnv('CLAUDECODE', '1');
    const record = humanOnly('agent-process');
    expect(() => decide(record.id)).toThrow(
      /^\[APPROVAL_HUMAN_PROOF_REQUIRED\] approval store refused .* \| next: decide it in a signed-in Concierge or Chronos session.* \| evidence: CLAUDECODE/
    );
    // presence-studio records `manual` (A1), which enforce refuses: never the next step.
    expect(() => decide(record.id)).not.toThrow(/presence-studio/);
    expect(loadApprovalRequest(CHANNEL, record.id)?.status).toBe('pending');
  });

  it('refuses a rejection the same way (an agent settles nothing human-only)', () => {
    vi.stubEnv('KYBERION_AGENT_ID', 'planner');
    const record = humanOnly('agent-process-reject');
    expect(() => decide(record.id, { decision: 'rejected' })).toThrow(
      /\[APPROVAL_HUMAN_PROOF_REQUIRED\]/
    );
  });

  it('exempts a human-decision surface server from the markers it inherited', () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('SYSTEM_ROLE', 'concierge');
    const record = humanOnly('surface-server');
    expect(decide(record.id).status).toBe('approved');
  });

  it('does not exempt an agent-facing surface server', () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('SYSTEM_ROLE', 'mcp_server_cowork');
    const record = humanOnly('agent-surface-server');
    expect(() => decide(record.id)).toThrow(/\[APPROVAL_HUMAN_PROOF_REQUIRED\]/);
  });

  it('refuses an agent principal even on a human-decision surface server', () => {
    vi.stubEnv('SYSTEM_ROLE', 'chronos_mirror_v2');
    const record = humanOnly('agent-principal');
    expect(() =>
      decide(record.id, {
        deciderPrincipal: {
          actor: { kind: 'agent', id: 'agent:planner' },
          source: 'agent',
          provider: 'agent-token',
          principalId: 'agent:planner',
        },
      })
    ).toThrow(/\[APPROVAL_HUMAN_PROOF_REQUIRED\].*principal:agent-token/);
  });

  it('leaves decisions that are not human-only alone', () => {
    vi.stubEnv('CLAUDECODE', '1');
    const record = createApprovalRequest('mission_controller', {
      channel: CHANNEL,
      threadTs: '1',
      correlationId: 'not-human-only',
      requestedBy: 'agent:planner',
      draft: { title: 'Routine', summary: 'no accountability' },
    });
    expect(decide(record.id, { decidedByType: 'ai_agent', authenticated: false }).status).toBe(
      'approved'
    );
  });
});

describe('session cache seeding (warn-mode shortfall)', () => {
  const descriptor = { action: 'deploy:run', targetClass: `service:${CHANNEL}` };
  const lookup = () =>
    lookupSessionApprovalCache(descriptor, Date.now(), {
      agentId: 'agent:planner',
      payloadHash: PAYLOAD_HASH,
      effectBinding: 'deploy:prod',
    });

  it('a decision let through below its assurance level does not seed the cache', () => {
    const record = humanOnly('cache-shortfall');
    const decided = decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      ...human,
      authMethod: 'channel_identity',
      presentedDigest: computeApprovalPresentedDigest(record),
      sessionCache: descriptor,
    });
    expect(decided.assuranceShortfall).toMatchObject({ required: 'A2', provided: 'A1' });
    expect(lookup()).toBeNull();
    expect(events().some((entry) => entry.event === 'session_cache_written')).toBe(false);
  });

  it('a decision that meets its level still seeds it', () => {
    const record = humanOnly('cache-ok');
    decideApprovalRequest('mission_controller', {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      ...human,
      presentedDigest: computeApprovalPresentedDigest(record),
      sessionCache: descriptor,
    });
    expect(lookup()?.grantedByRequestId).toBe(record.id);
  });
});

describe('surface decision authMethod (HA-05)', () => {
  it('records surface_session only for a member resolved from a verified session', () => {
    for (const provider of ['browser-session', 'oidc-jwt', 'registry-token']) {
      expect(surfaceDecisionAuthMethod({ provider }, true)).toBe('surface_session');
      expect(surfaceDecisionAuthMethod({ provider }, false)).toBe('local_admin_token');
    }
  });

  it('records the localadmin bearer and the sovereign fallback as local_admin_token', () => {
    expect(surfaceDecisionAuthMethod({ provider: 'env-token' }, true)).toBe('local_admin_token');
    expect(surfaceDecisionAuthMethod(undefined, true)).toBe('local_admin_token');
    expect(surfaceDecisionAuthMethod(null, false)).toBe('local_admin_token');
  });

  it('never records an agent principal as a verified session', () => {
    for (const provider of ['browser-session', 'oidc-jwt', 'registry-token', 'loopback-local']) {
      expect(surfaceDecisionAuthMethod({ provider, actor: { kind: 'agent' } }, true)).toBe(
        'local_admin_token'
      );
    }
    expect(surfaceDecisionAuthMethod({ provider: 'oidc-jwt', actor: { kind: 'user' } }, true)).toBe(
      'surface_session'
    );
  });

  it('records a credential-free loopback viewer as manual', () => {
    expect(surfaceDecisionAuthMethod({ provider: 'loopback-local' }, true)).toBe('manual');
  });
});
