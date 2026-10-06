import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '../dot/dot-charter.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type { DotActionRecord } from '../dot/dot-dispatch.js';
import type {
  FrontDeskExecutionBinding,
  FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';
import type { MemberProfile } from '../organization/member-registry.js';
const state = vi.hoisted(() => ({
  member: undefined as MemberProfile | undefined,
  mapping: undefined as FrontDeskExecutionMapping | undefined,
  charter: undefined as DotCharter | undefined,
  binding: undefined as FrontDeskExecutionBinding | undefined,
  record: undefined as ApprovalRequestRecord | undefined,
  action: undefined as DotActionRecord | undefined,
  admitted: true,
  locks: 0,
  write: vi.fn(),
  memberError: false,
  rotateKey: false,
  failReadback: false,
}));
vi.mock('../authn-providers.js', async (original) => {
  const actual = await original<typeof import('../authn-providers.js')>();
  return {
    ...actual,
    browserSessionKey: () => {
      if (state.rotateKey)
        vi.stubEnv('KYBERION_SESSION_SECRET', 'rotated-during-decision-fixture-key-over-32');
      return actual.browserSessionKey();
    },
  };
});
vi.mock('../organization/member-registry.js', async (original) => ({
  ...(await original<typeof import('../organization/member-registry.js')>()),
  readMemberProfile: (id: string) =>
    state.member?.member_id === id ? structuredClone(state.member) : null,
  resolveMemberByPrincipal: (input: { memberId?: string }) => {
    if (state.memberError)
      throw new Error(
        'private-marker: knowledge/personal/members/owner.json contains invalid secret data'
      );
    return state.member?.status === 'active' &&
      state.member.member_id === (input.memberId ?? 'owner')
      ? structuredClone(state.member)
      : null;
  },
  findMemberByExternalIdentity: (issuer: string, subject: string) =>
    state.member?.status === 'active' &&
    state.member.external_identities?.some((id) => id.issuer === issuer && id.subject === subject)
      ? structuredClone(state.member)
      : null,
  externalIdentityBindingDenied: () => true,
}));
vi.mock('../dot/dot-charter.js', async (original) => ({
  ...(await original<typeof import('../dot/dot-charter.js')>()),
  findDotCharter: () =>
    state.charter ? { charter: structuredClone(state.charter), path: 'fixture' } : undefined,
}));
vi.mock('../dot/dot-dispatch.js', async (original) => ({
  ...(await original<typeof import('../dot/dot-dispatch.js')>()),
  currentDotActions: () => (state.action ? [structuredClone(state.action)] : []),
}));
vi.mock('../lock-utils.js', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.locks++;
    return fn();
  },
}));
vi.mock('./first-job.js', () => ({
  FIRST_JOB_NEXT_ACTION: { kind: 'inspect_setup', href: '/first-job' },
  resolveFirstJobViewer: () =>
    state.mapping && state.charter?.status === 'active'
      ? { ready: true, viewer: structuredClone(state.mapping.viewer) }
      : { ready: false, status: 'mapping_unavailable' },
}));
vi.mock('./front-desk-execution-contract.js', async (original) => ({
  ...(await original<typeof import('./front-desk-execution-contract.js')>()),
  getFrontDeskExecutionMapping: (binding: FrontDeskExecutionBinding) =>
    state.mapping && binding.config_digest === 'a'.repeat(64)
      ? structuredClone(state.mapping)
      : undefined,
}));
vi.mock('./front-desk-conversation-store.js', () => ({
  conversationRef: () => ({ key: 'b'.repeat(64), sessionId: 'concierge-' + 'b'.repeat(64) }),
  listConfiguredFrontDeskExecutions: (include: (mapping: FrontDeskExecutionMapping) => boolean) =>
    state.mapping && state.binding && include(state.mapping)
      ? [
          {
            mapping: structuredClone(state.mapping),
            binding: structuredClone(state.binding),
            request: { status: 'pending' },
          },
        ]
      : [],
  inspectFrontDeskExecution: () => ({ ok: state.admitted }),
}));
vi.mock('../governance/approval-store.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store.js')>()),
  loadApprovalRequest: (_channel: string, id: string) =>
    state.record?.id === id && !(state.failReadback && state.record.status !== 'pending')
      ? structuredClone(state.record)
      : null,
  decideApprovalRequest: (role: string, input: Record<string, unknown>) => {
    state.write(role, input);
    state.record = {
      ...state.record!,
      status: input.decision,
      decidedBy: input.decidedBy,
      decidedByType: input.decidedByType,
      authenticated: input.authenticated,
      decidedAuthMethod: input.authMethod,
      diagnosticDecision: input.diagnosticDecision,
    } as ApprovalRequestRecord;
    return structuredClone(state.record);
  },
}));
import { mintBrowserSessionToken } from '../authn-providers.js';
import * as authnProviders from '../authn-providers.js';
import type express from 'express';
import { registerFirstJobRoutes } from '../../../presence/displays/presence-studio/first-job-routes.js';
import {
  firstJobApprovalEffect,
  hasVerifiedFirstJobDecision,
  hasFirstJobDiagnosticProvenance,
} from './first-job-approval-proof.js';
import { getDefaultWorkerEventStream } from '../workforce/worker-event-stream.js';
import { readFirstJobApprovals, decideFirstJobApproval } from './first-job-approval.js';
import { frontDeskExecutionProposal } from './front-desk-execution.js';
import { dotProposalHash } from '../dot/dot-dispatch.js';
const id = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const sessionId = 'concierge-' + 'b'.repeat(64);
let token = '';
function read(value = token) {
  return readFirstJobApprovals(state.mapping!.viewer, value, { session_id: sessionId });
}
function decide(
  decision: 'approved' | 'rejected' = 'approved',
  value = token,
  digest = read().approvals[0]?.display_digest
) {
  return decideFirstJobApproval(state.mapping!.viewer, value, id, {
    decision,
    display_digest: digest,
    session_id: sessionId,
  });
}
beforeEach(() => {
  vi.stubEnv('KYBERION_SESSION_SECRET', 'fixture-session-key-never-used-outside-tests-123456');
  vi.stubEnv('KYBERION_OIDC_ISSUER', 'https://fixture.example');
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  state.member = {
    member_id: 'owner',
    display_name: 'Fixture Owner',
    status: 'active',
    memberships: [{ tenant_slug: 'fixture-tenant', role: 'owner' }],
    access_registrations: [],
    external_identities: [{ issuer: 'https://fixture.example', subject: 'fixture-subject' }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  state.mapping = {
    id: 'fixture-diagnostic',
    dotId: 'fixture-dot',
    viewer: {
      source: 'loopback',
      role: 'localadmin',
      principalId: 'human:presence-studio-localadmin',
      tenantSlugs: ['fixture-tenant'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public'],
    },
    exactCommand: 'Create a local diagnostic request receipt artifact.',
    pipeline: { path: 'pipelines/front-desk-request-receipt.json', version: 'receipt-v1' },
  };
  state.charter = {
    kind: 'dot-charter',
    dot_id: 'fixture-dot',
    version: '1.0.0',
    title: 'Fixture',
    purpose: 'Fixture',
    status: 'active',
    scope: { tier: 'public', tenant_slug: 'fixture-tenant' },
    goal: { statement: 'Fixture' },
    attention: { triggers: [] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['pipeline'],
      allowed_pipelines: ['pipelines/front-desk-request-receipt.json'],
    },
    decisions: { default_decision: 'approve', escalate_channel: 'surface' },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { execution_mode: 'front_desk_diagnostic', heartbeat_id: 'fixture' },
  };
  state.binding = {
    diagnostic_protocol: 'first-job-v1',
    mapping_id: 'fixture-diagnostic',
    config_digest: 'a'.repeat(64),
    conversation_key: 'b'.repeat(64),
    request_id: requestId,
    revision: 1,
    request_digest: 'c'.repeat(64),
    work_item_id: 'WI-FD-' + 'd'.repeat(48),
  };
  const effect = firstJobApprovalEffect(state.charter, state.binding);
  state.record = {
    id,
    kind: 'channel-approval',
    storageChannel: 'autonomy',
    channel: 'inbox',
    threadTs: '',
    correlationId: 'fixture-correlation',
    requestedBy: 'dot:fixture-dot',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    title: 'Fixture',
    summary: 'Fixed diagnostic',
    status: 'pending',
    accountability: {
      finalDecision: 'human_only',
      payloadHash: effect.payloadHash,
      effectBinding: effect.effectBinding,
    },
    scope: effect.effect.scope as ApprovalRequestRecord['scope'],
  };
  const proposal = frontDeskExecutionProposal(state.binding);
  state.action = {
    ...proposal,
    dot_id: 'fixture-dot',
    actor_id: 'dot:fixture-dot',
    action_ref: 'fixture-action',
    proposal_hash: dotProposalHash('fixture-dot', proposal),
    status: 'parked',
    decision: 'approve',
    request_id: id,
    at: new Date().toISOString(),
  };
  state.admitted = true;
  state.locks = 0;
  state.write.mockReset();
  state.memberError = false;
  state.rotateKey = false;
  state.failReadback = false;
  token = mintBrowserSessionToken({
    idpIssuer: 'https://fixture.example',
    subject: 'fixture-subject',
    ttlSeconds: 1800,
  }).token;
});
afterEach(() => vi.unstubAllEnvs());
describe('verified diagnostic decisions', () => {
  it('keeps durable diagnostic provenance after mode removal without reclassifying legacy work', () => {
    const record = decide();
    delete state.charter!.runtime.execution_mode;
    expect(hasFirstJobDiagnosticProvenance(state.binding)).toBe(true);
    expect(hasVerifiedFirstJobDecision(record, state.charter!, state.binding!)).toBe(false);
    expect(hasFirstJobDiagnosticProvenance({})).toBe(false);
    expect(hasFirstJobDiagnosticProvenance({ diagnostic_protocol: undefined })).toBe(true);
    expect(
      hasFirstJobDiagnosticProvenance({}, { diagnosticDecision: record.diagnosticDecision })
    ).toBe(true);
    expect(hasFirstJobDiagnosticProvenance({}, { accountability: record.accountability })).toBe(
      true
    );
  });
  it('refuses opaque approval subscribers without persisting or invoking them', () => {
    const digest = read().approvals[0].display_digest;
    const listener = vi.fn();
    const unsubscribe = getDefaultWorkerEventStream().subscribe(listener);
    try {
      expect(() => decide('approved', token, digest)).toThrow('event_subscribers_unavailable');
      expect(() => firstJobApprovalEffect(state.charter!, state.binding!)).toThrow('builtin-only');
      expect(state.write).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it('rechecks late subscribers immediately before diagnostic approval persistence', () => {
    const digest = read().approvals[0].display_digest;
    const listener = vi.fn();
    let unsubscribe: (() => void) | undefined;
    const original = authnProviders.browserSessionKey;
    const lookup = vi.spyOn(authnProviders, 'browserSessionKey').mockImplementation(() => {
      unsubscribe ??= getDefaultWorkerEventStream().subscribe(listener);
      return original();
    });
    try {
      expect(() => decide('approved', token, digest)).toThrow('event_subscribers_unavailable');
      expect(state.write).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe?.();
      lookup.mockRestore();
    }
  });
  it('requires a real browser-session credential even for the fixed loopback owner', () => {
    for (const untrusted of ['', 'agent-token', 'generic-registry-token', 'kys1.forged.fake']) {
      expect(read(untrusted).auth.status).toBe('authentication_required');
      expect(() => decide('approved', untrusted, 'a'.repeat(64))).toThrow(
        'authentication_required'
      );
    }
    expect(state.write).not.toHaveBeenCalled();
  });
  it('honestly reports missing login configuration and never mutates a GET', () => {
    vi.stubEnv('KYBERION_OIDC_ISSUER', '');
    expect(read('').auth.status).toBe('authentication_configuration_required');
    expect(state.write).not.toHaveBeenCalled();
    expect(state.locks).toBe(0);
  });
  it('writes only the exact verified decision and proves it at execution', () => {
    const before = read();
    expect(before.auth.status).toBe('ready');
    expect(before.approvals).toHaveLength(1);
    expect(Date.parse(before.approvals[0].execution_deadline_at)).toBeLessThan(
      Date.parse(before.approvals[0].expires_at)
    );
    const record = decide();
    expect(state.write).toHaveBeenCalledWith(
      'infrastructure_sentinel',
      expect.objectContaining({
        requestId: id,
        storageChannel: 'autonomy',
        decidedBy: 'user:owner',
        authenticated: true,
      })
    );
    expect(JSON.stringify(record)).not.toContain(token);
    expect(hasVerifiedFirstJobDecision(record, state.charter!, state.binding!)).toBe(true);
    expect(() => decide('approved', token, before.approvals[0].display_digest)).toThrow(
      'approval_unavailable'
    );
    expect(state.write).toHaveBeenCalledTimes(1);
  });
  it('does not upgrade an old session when the signing key rotates after authentication', () => {
    const digest = read().approvals[0].display_digest;
    state.rotateKey = true;
    expect(() => decide('approved', token, digest)).toThrow('authentication_required');
    expect(state.write).not.toHaveBeenCalled();
  });
  it('projects operator recovery for an old unverified decision', () => {
    state.record!.status = 'approved';
    state.record!.authenticated = true;
    state.record!.decidedByType = 'human';
    expect(read().held_requests).toEqual([
      {
        request_id: requestId,
        status: 'approval_verification_failed',
        recovery: 'operator_recovery',
      },
    ]);
    expect(read().approvals).toEqual([]);
    expect(read().readiness.ready).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
  });
  it('does not mark a current signed approved request awaiting execution as failed', () => {
    decide();
    expect(read().held_requests).toEqual([]);
  });
  it('does not grant execution for rejected or plain generic human decisions', () => {
    const rejected = decide('rejected');
    expect(hasVerifiedFirstJobDecision(rejected, state.charter!, state.binding!)).toBe(false);
    expect(
      hasVerifiedFirstJobDecision(
        { ...rejected, status: 'approved', diagnosticDecision: undefined },
        state.charter!,
        state.binding!
      )
    ).toBe(false);
  });
  it.each([
    'wrong-digest',
    'expired',
    'terminal',
    'no-hashes',
    'changed-binding',
    'changed-charter',
    'changed-request',
    'steering',
    'workflow',
  ])('fails closed before writing: %s', (change) => {
    const digest = read().approvals[0].display_digest;
    if (change === 'expired') state.record!.expiresAt = new Date(0).toISOString();
    if (change === 'terminal') state.record!.status = 'approved';
    if (change === 'no-hashes') state.record!.accountability = { finalDecision: 'human_only' };
    if (change === 'changed-binding') state.binding!.config_digest = 'e'.repeat(64);
    if (change === 'changed-charter') state.charter!.purpose = 'New purpose';
    if (change === 'changed-request') state.admitted = false;
    if (change === 'steering') state.record!.steering = { kind: 'mission_lifecycle_verb' } as never;
    if (change === 'workflow') state.record!.workflow = {} as never;
    expect(() =>
      decide('approved', token, change === 'wrong-digest' ? 'f'.repeat(64) : digest)
    ).toThrow();
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each(['suspended', 'other-tenant', 'viewer', 'different-member', 'identity-revoked'])(
    'requires current owner identity and tenant approval role: %s',
    (change) => {
      if (change === 'suspended') state.member!.status = 'suspended';
      if (change === 'other-tenant') state.member!.memberships[0].tenant_slug = 'another';
      if (change === 'viewer') state.member!.memberships[0].role = 'viewer';
      if (change === 'different-member') state.member!.member_id = 'different';
      if (change === 'identity-revoked') state.member!.external_identities = [];
      // The fixture's loopback member lookup follows state; pin it for the different-member case.
      if (change === 'different-member') state.mapping!.viewer.memberId = 'owner';
      const result = read();
      expect(result.approvals).toHaveLength(0);
      expect(() => decide('approved', token, 'f'.repeat(64))).toThrow();
      expect(state.write).not.toHaveBeenCalled();
    }
  );
  it.each([
    'key-rotation',
    'member-revoked',
    'role-revoked',
    'identity-revoked',
    'scope-tamper',
    'proof-tamper',
    'approval-copy',
    'charter-change',
    'session-expiry',
  ])('rejects stale or copied proof: %s', (change) => {
    const approved = decide();
    if (change === 'key-rotation')
      vi.stubEnv('KYBERION_SESSION_SECRET', 'another-fixture-session-key-that-is-over-32');
    if (change === 'member-revoked') state.member!.status = 'suspended';
    if (change === 'role-revoked') state.member!.memberships[0].role = 'viewer';
    if (change === 'identity-revoked') state.member!.external_identities = [];
    if (change === 'scope-tamper') approved.scope!.tenant_slug = 'another';
    if (change === 'proof-tamper') approved.diagnosticDecision!.member_id = 'other';
    if (change === 'approval-copy') approved.id = requestId;
    if (change === 'charter-change') state.charter!.purpose = 'Changed';
    const now = change === 'session-expiry' ? Date.now() + 1801000 : Date.now();
    expect(hasVerifiedFirstJobDecision(approved, state.charter!, state.binding!, now)).toBe(false);
  });
});

// Retained authored test additions, combined with their later recorded fixes.
// This append fragment needs replayApprovalTestEdits(seed) and is not standalone.
const handlers = new Map<string, express.RequestHandler>();
registerFirstJobRoutes({
  get: (path: string, fn: express.RequestHandler) => handlers.set('GET ' + path, fn),
  post: (path: string, fn: express.RequestHandler) => handlers.set('POST ' + path, fn),
} as unknown as express.Express);
async function route(
  method: 'GET' | 'POST',
  options: {
    body?: unknown;
    headers?: Record<string, string | undefined>;
    address?: string;
    query?: Record<string, unknown>;
  } = {}
) {
  const req = {
    method,
    body: options.body ?? {},
    query: options.query ?? {},
    params: { requestId: id },
    headers: {
      host: '127.0.0.1:3031',
      origin: 'http://127.0.0.1:3031',
      cookie: 'kyberion_session=' + token,
      ...options.headers,
    },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
  } as unknown as express.Request;
  const res = {
    code: 200,
    body: {} as {
      ok?: boolean;
      error?: string;
      retry_safe?: boolean;
      auth?: { status: string };
      approvals?: ReturnType<typeof read>['approvals'];
      status?: string;
    },
    setHeader: () => res,
    status: (code: number) => {
      res.code = code;
      return res;
    },
    json: (body: typeof res.body) => {
      res.body = body;
      return res;
    },
  };
  await handlers.get(
    method +
      (method === 'GET'
        ? ' /api/first-job/approvals'
        : ' /api/first-job/approvals/:requestId/decision')
  )!(req, res as unknown as express.Response, vi.fn());
  return res;
}
describe('first-job approval HTTP integration', () => {
  it('validates locale semantics at approval read boundaries rather than the wire contract', async () => {
    expect((await route('GET', { query: { locale: 'en-US' } })).code).toBe(200);
    expect((await route('GET', { query: { locale: 'zz' } })).code).toBe(400);
    expect(() => readFirstJobApprovals(state.mapping!.viewer, token, { locale: 'zz' })).toThrow(
      'first_job_invalid_request'
    );
    expect(state.write).not.toHaveBeenCalled();
  });
  it('uses real fixture-session crypto for same-origin local approve and refuses replay', async () => {
    const got = await route('GET');
    expect(got.code).toBe(200);
    expect(got.body.auth?.status).toBe('ready');
    const body = {
      decision: 'approved',
      session_id: sessionId,
      display_digest: got.body.approvals![0].display_digest,
    };
    expect((await route('POST', { body })).code).toBe(200);
    expect((await route('POST', { body })).code).toBe(409);
    expect(state.write).toHaveBeenCalledTimes(1);
  });
  it('shows missing auth without exposing pending approvals', async () => {
    const result = await route('GET', { headers: { cookie: undefined } });
    expect(result.body.auth?.status).toBe('authentication_required');
    expect(result.body.approvals).toEqual([]);
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each([
    { origin: undefined },
    { origin: 'http://attacker.example' },
    { origin: 'https://127.0.0.1:3031' },
    { host: 'attacker.example', origin: 'http://attacker.example' },
    { origin: 'null' },
  ])('refuses hostile transport even with a valid session %#', async (headers) => {
    const body = {
      decision: 'approved',
      session_id: sessionId,
      display_digest: read().approvals[0].display_digest,
    };
    expect((await route('POST', { body, headers })).code).toBe(403);
    expect(state.write).not.toHaveBeenCalled();
  });
  it('refuses remote socket even with same origin and a valid browser token', async () => {
    expect((await route('GET', { address: '198.51.100.1' })).code).toBe(403);
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each(['authenticated', 'memberId', 'decidedBy', 'token', 'effect_binding', 'note'])(
    'rejects injected authority field %s',
    async (field) => {
      const body = {
        decision: 'approved',
        session_id: sessionId,
        display_digest: read().approvals[0].display_digest,
        [field]: 'spoof',
      };
      expect((await route('POST', { body })).code).toBe(400);
      expect(state.write).not.toHaveBeenCalled();
    }
  );
  it('does not let an explicit forged bearer fall back to a valid cookie', async () => {
    const body = {
      decision: 'approved',
      session_id: sessionId,
      display_digest: read().approvals[0].display_digest,
    };
    expect(
      (await route('POST', { body, headers: { authorization: 'Bearer kys1.forged.fake' } })).code
    ).toBe(401);
    expect(state.write).not.toHaveBeenCalled();
  });
  it('reports a failed post-write readback as uncertain and unsafe to retry', async () => {
    const body = {
      decision: 'approved',
      session_id: sessionId,
      display_digest: read().approvals[0].display_digest,
    };
    state.failReadback = true;
    const result = await route('POST', { body });
    expect(result.code).toBe(503);
    expect(result.body).toMatchObject({ error: 'first_job_decision_uncertain', retry_safe: false });
    expect(state.write).toHaveBeenCalledTimes(1);
  });
  it('sanitizes private-member parse failures at the reusable effect boundary', () => {
    state.memberError = true;
    expect(() => decide('approved', token, 'a'.repeat(64))).toThrow(/^first_job_access_denied$/);
    expect(() => firstJobApprovalEffect(state.charter!, state.binding!)).toThrow(
      /^first_job_owner_unavailable$/
    );
    expect(state.write).not.toHaveBeenCalled();
  });
});
