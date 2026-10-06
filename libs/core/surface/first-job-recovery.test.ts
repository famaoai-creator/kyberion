import type express from 'express';
import { registerFirstJobRoutes } from '../../../presence/displays/presence-studio/first-job-routes.js';
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
  receipt: undefined as
    import('./front-desk-conversation-store.js').FrontDeskExecutionRecoveryReceipt | undefined,
  requestStatus: 'pending',
  history: [] as DotActionRecord[],
  results: [] as unknown[],
  noExecution: true,
  probeError: false,
  outputExists: false,
  failDecline: false,
  verifiedProof: false,
  sequence: [] as string[],
  duringProof: undefined as (() => void) | undefined,
  beforeLock: undefined as (() => void) | undefined,
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
  readDotActionLedgerStrict: () => structuredClone(state.history),
  declineRecoveredDotAction: (
    expected: DotActionRecord,
    receipt: import('./front-desk-conversation-store.js').FrontDeskExecutionRecoveryReceipt
  ) => {
    if (state.failDecline) throw new Error('crash-after-tombstone');
    state.sequence.push('decline');
    state.action = { ...expected, status: 'declined', recovery_receipt: receipt };
    state.history.push(structuredClone(state.action));
    return state.action;
  },
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
  frontDeskRuntimeScope: () => ({ tenant_slug: 'fixture-tenant', tier: 'public' }),
  readFrontDeskExecutionRecovery: () => ({
    binding: structuredClone(state.binding),
    sessionId,
    revision: 1,
    requestDigest: state.binding?.request_digest,
    status: state.requestStatus,
    recoveryReceipt: state.receipt,
  }),
  withFrontDeskExecutionRecovery: (
    _binding: unknown,
    fn: (
      request: unknown,
      terminate: (
        receipt: import('./front-desk-conversation-store.js').FrontDeskExecutionRecoveryReceipt
      ) => void
    ) => unknown
  ) =>
    fn({}, (receipt) => {
      if (!state.receipt) {
        state.sequence.push('receipt');
        state.receipt = structuredClone(receipt);
        state.requestStatus = 'terminated_unstarted';
      }
    }),
  conversationRef: () => ({ key: 'b'.repeat(64), sessionId: 'concierge-' + 'b'.repeat(64) }),
  listConfiguredFrontDeskExecutions: (include: (mapping: FrontDeskExecutionMapping) => boolean) =>
    state.mapping && state.binding && include(state.mapping)
      ? [
          {
            mapping: structuredClone(state.mapping),
            binding: structuredClone(state.binding),
            request: { status: state.requestStatus },
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

vi.mock('../workforce/work-coordination.js', async (original) => ({
  ...(await original<typeof import('../workforce/work-coordination.js')>()),
  readUndispatchedWorkItemEvidence: () => {
    if (state.duringProof) state.duringProof();
    return { ok: state.noExecution, digest: 'e'.repeat(64) };
  },
  withUndispatchedWorkItemEvidence: (_input: unknown, fn: () => unknown) => {
    if (!state.noExecution) throw new Error('private-evidence-failure');
    return fn();
  },
}));
vi.mock('../foundation/json.js', async (original) => {
  const actual = await original<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJsonLines: (path: string, options?: unknown) =>
      path.endsWith('work-results.jsonl')
        ? state.results
        : actual.readJsonLines(path, options as never),
  };
});
vi.mock('../secure-io.js', async (original) => {
  const actual = await original<typeof import('../secure-io.js')>();
  return {
    ...actual,
    assertSafeRepositoryPath: (path: string) => path,
    safeLstat: (path: string) => {
      if (
        !path.endsWith('work-results.jsonl') &&
        !path.includes('front-desk-execution/') &&
        !path.includes('/front-desk/')
      )
        return actual.safeLstat(path);
      if (state.probeError) throw new Error('private-marker-path-denied');
      if (path.endsWith('work-results.jsonl')) return { isFile: () => true, size: 0 };
      if (state.outputExists) return { isFile: () => true, size: 1 };
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
  };
});
vi.mock('./front-desk-dispatch-lock.js', () => ({
  withFrontDeskDispatchLock: (_binding: unknown, fn: () => unknown) => {
    state.locks++;
    if (state.beforeLock) state.beforeLock();
    return fn();
  },
}));

vi.mock('./first-job-approval-proof.js', async (original) => ({
  ...(await original<typeof import('./first-job-approval-proof.js')>()),
  hasVerifiedFirstJobDecision: () => state.verifiedProof,
}));
import { mintBrowserSessionToken } from '../authn-providers.js';
import { firstJobApprovalEffect } from './first-job-approval-proof.js';
import { readFirstJobRecoveries, terminateFirstJobRequest } from './first-job-recovery.js';
import { frontDeskExecutionProposal } from './front-desk-execution.js';
import { dotProposalHash } from '../dot/dot-dispatch.js';
const id = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const sessionId = 'concierge-' + 'b'.repeat(64);
let token = '';
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
    status: 'approved',
    decidedBy: 'user:owner',
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
  state.history = [structuredClone(state.action!)];
  state.results = [];
  state.receipt = undefined;
  state.requestStatus = 'pending';
  state.noExecution = true;
  state.outputExists = false;
  state.probeError = false;
  state.failDecline = false;
  state.sequence = [];
  state.beforeLock = undefined;
  state.duringProof = undefined;
  state.verifiedProof = false;
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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('explicit safe diagnostic recovery', () => {
  function reads(value = token) {
    return readFirstJobRecoveries(state.mapping!.viewer, value, { session_id: sessionId });
  }
  function terminate(digest = reads()[0]?.display_digest, value = token) {
    return terminateFirstJobRequest(state.mapping!.viewer, value, requestId, {
      action: 'terminate_unstarted',
      session_id: sessionId,
      display_digest: digest,
    });
  }
  it('uses a real signed browser session and leaves GET entirely read-only', () => {
    expect(reads()[0]).toMatchObject({
      request_id: requestId,
      status: 'eligible',
      tenant: 'fixture-tenant',
    });
    expect(state.locks).toBe(0);
    expect(state.write).not.toHaveBeenCalled();
    expect(state.receipt).toBeUndefined();
    expect(reads('forged')).toEqual([]);
    expect(reads(token.slice(0, -2) + 'xx')).toEqual([]);
  });
  it('commits terminal receipt before declined action, retaining original approved bytes', () => {
    const before = structuredClone(state.record);
    const digest = reads()[0].display_digest;
    expect(terminate(digest)).toMatchObject({ ok: true, status: 'terminated_unstarted' });
    expect(state.sequence).toEqual(['receipt', 'decline']);
    expect(state.receipt).toMatchObject({
      member_id: 'owner',
      actor_id: 'user:owner',
      display_digest: digest,
    });
    expect(state.record).toEqual(before);
    expect(reads()[0].status).toBe('terminated_unstarted');
    expect(terminate(reads()[0].display_digest).status).toBe('terminated_unstarted');
    expect(state.sequence).toEqual(['receipt', 'decline']);
  });
  it('rejects changed digest or body instead of deciding the original approval', () => {
    expect(() => terminate('0'.repeat(64))).toThrow('recovery_unavailable');
    expect(() =>
      terminateFirstJobRequest(state.mapping!.viewer, token, requestId, {
        action: 'terminate_unstarted',
        session_id: sessionId,
        display_digest: reads()[0].display_digest,
        tenant: 'other',
      } as never)
    ).toThrow('invalid_request');
    expect(state.receipt).toBeUndefined();
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each([
    'work',
    'result',
    'malformed-result',
    'output',
    'probe-error',
    'action-dispatched',
    'action-duplicate',
    'wrong-owner',
    'wrong-tenant',
    'missing-approval',
    'changed-config',
    'changed-request',
    'valid-proof',
  ] as const)('fails closed without private disclosure for %s', (change) => {
    if (change === 'work') state.noExecution = false;
    if (change === 'result')
      state.results = [
        {
          dot_id: 'fixture-dot',
          work_item_id: state.binding!.work_item_id,
          action_ref: 'fixture-action',
          mode: 'pipeline',
          status: 'failed',
          summary: 'private-marker',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
      ];
    if (change === 'malformed-result') state.results = [{}];
    if (change === 'output') state.outputExists = true;
    if (change === 'probe-error') state.probeError = true;
    if (change === 'action-dispatched')
      state.history.push({ ...state.action!, status: 'dispatched' });
    if (change === 'action-duplicate')
      state.history.push({ ...state.action!, action_ref: 'ambiguous' });
    if (change === 'wrong-owner') state.member!.member_id = 'other';
    if (change === 'wrong-tenant')
      state.member!.memberships = [{ tenant_slug: 'elsewhere', role: 'owner' }];
    if (change === 'missing-approval') state.record = undefined;
    if (change === 'changed-config') state.binding!.config_digest = 'f'.repeat(64);
    if (change === 'changed-request') state.admitted = false;
    if (change === 'valid-proof') state.verifiedProof = true;
    const result = reads();
    expect(result).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-marker');
    expect(state.receipt).toBeUndefined();
  });
  it('revalidates evidence and owner after waiting for the shared fence', () => {
    const digest = reads()[0].display_digest;
    state.beforeLock = () => {
      state.noExecution = false;
    };
    expect(() => terminate(digest)).toThrow();
    expect(state.receipt).toBeUndefined();
    state.noExecution = true;
    state.beforeLock = () => {
      state.member!.status = 'suspended';
    };
    expect(() => terminate(digest)).toThrow();
    expect(state.receipt).toBeUndefined();
  });
  it('preserves and reconciles the same receipt after crash before decline', () => {
    const digest = reads()[0].display_digest;
    state.failDecline = true;
    expect(() => terminate(digest)).toThrow('crash-after-tombstone');
    const receipt = structuredClone(state.receipt);
    expect(state.action!.status).toBe('parked');
    expect(reads()[0].status).toBe('eligible');
    state.failDecline = false;
    expect(terminate(reads()[0].display_digest).status).toBe('terminated_unstarted');
    expect(state.receipt).toEqual(receipt);
    expect(state.record!.status).toBe('approved');
  });
  it('recovers lost response via read only without minting any new work', () => {
    terminate();
    const receipt = structuredClone(state.receipt);
    const writes = state.sequence.length;
    expect(reads()[0].status).toBe('terminated_unstarted');
    expect(state.sequence.length).toBe(writes);
    expect(state.receipt).toEqual(receipt);
  });
  it('requires fresh sign-in after session expiry, rotation, and cross-session display replay', () => {
    const digest = reads()[0].display_digest;
    const otherToken = mintBrowserSessionToken({
      idpIssuer: 'https://fixture.example',
      subject: 'fixture-subject',
      ttlSeconds: 1800,
    }).token;
    expect(() => terminate(digest, otherToken)).toThrow('recovery_unavailable');
    vi.useFakeTimers({ now: Date.now() + 2 * 3600000, toFake: ['Date'] });
    expect(reads()).toEqual([]);
    expect(() => terminate(digest)).toThrow('authentication_required');
    vi.useRealTimers();
    vi.stubEnv('KYBERION_SESSION_SECRET', 'rotated-fixture-only-session-key-length-1234567');
    expect(reads()).toEqual([]);
    expect(() => terminate(digest)).toThrow('authentication_required');
    expect(state.receipt).toBeUndefined();
  });
  it('rechecks session expiry immediately before the terminal write after a slow locked scan', () => {
    const digest = reads()[0].display_digest;
    state.beforeLock = () => {
      state.duringProof = () => {
        vi.useFakeTimers({ now: Date.now() + 2 * 3600000, toFake: ['Date'] });
        state.duringProof = undefined;
      };
    };
    expect(() => terminate(digest)).toThrow('authentication_required');
    expect(state.receipt).toBeUndefined();
  });
  it('does not expose another conversation through recovery selectors', () => {
    expect(
      readFirstJobRecoveries(state.mapping!.viewer, token, {
        session_id: 'concierge-' + 'f'.repeat(64),
      })
    ).toEqual([]);
    expect(() =>
      terminateFirstJobRequest(state.mapping!.viewer, token, requestId, {
        action: 'terminate_unstarted',
        session_id: 'concierge-' + 'f'.repeat(64),
        display_digest: 'e'.repeat(64),
      })
    ).toThrow('scope_changed');
    expect(state.receipt).toBeUndefined();
  });
  it('will not reconcile terminal receipt under a new owner or altered approved record', () => {
    terminate();
    state.record!.summary = 'changed';
    expect(reads()).toEqual([]);
    expect(() => terminate('0'.repeat(64))).toThrow();
  });
});

const handlers = new Map<string, express.RequestHandler>();
registerFirstJobRoutes({
  get: (url: string, fn: express.RequestHandler) => handlers.set('GET ' + url, fn),
  post: (url: string, fn: express.RequestHandler) => handlers.set('POST ' + url, fn),
} as unknown as express.Express);
async function recoveryRoute(
  method: 'GET' | 'POST',
  options: {
    body?: unknown;
    headers?: Record<string, string | undefined>;
    query?: Record<string, string>;
    address?: string;
  } = {}
) {
  const req = {
    method,
    headers: {
      host: '127.0.0.1:3031',
      origin: 'http://127.0.0.1:3031',
      cookie: 'kyberion_session=' + token,
      ...options.headers,
    },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    params: { requestId },
    query: options.query ?? {},
    body: options.body,
  } as unknown as express.Request;
  const res = {
    code: 200,
    headers: {} as Record<string, string>,
    body: {} as Record<string, unknown>,
    setHeader: (key: string, value: string) => {
      res.headers[key] = value;
      return res;
    },
    status: (code: number) => {
      res.code = code;
      return res;
    },
    json: (body: Record<string, unknown>) => {
      res.body = body;
      return res;
    },
  };
  await handlers.get(
    method +
      (method === 'GET' ? ' /api/first-job/approvals' : ' /api/first-job/recovery/:requestId')
  )!(req, res as unknown as express.Response, vi.fn());
  return res;
}
describe('recovery HTTP boundary with signed session', () => {
  const body = () => ({
    action: 'terminate_unstarted',
    session_id: sessionId,
    display_digest: readFirstJobRecoveries(state.mapping!.viewer, token, {
      session_id: sessionId,
    })[0].display_digest,
  });
  it('delivers only bounded scoped GET rows and filters overlapping held requests', async () => {
    const got = await recoveryRoute('GET');
    expect(got.headers['Cache-Control']).toBe('no-store');
    expect(got.body.recovery_requests).toMatchObject([
      { request_id: requestId, status: 'eligible' },
    ]);
    expect(got.body.held_requests).toEqual([]);
    expect(JSON.stringify(got.body)).not.toContain('recoveryReceipt');
    expect(state.locks).toBe(0);
    expect((await recoveryRoute('POST', { body: body() })).body).toMatchObject({
      ok: true,
      status: 'terminated_unstarted',
    });
  });
  it.each([
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: 'https://127.0.0.1:3031' },
    { host: 'evil.example', origin: 'http://evil.example' },
  ])('rejects hostile origin before effects %#', async (headers) => {
    expect((await recoveryRoute('POST', { body: body(), headers })).code).toBe(403);
    expect(state.receipt).toBeUndefined();
  });
  it('does not disclose candidates without session or to remote sockets', async () => {
    expect(
      (await recoveryRoute('GET', { headers: { cookie: undefined } })).body.recovery_requests
    ).toEqual([]);
    expect((await recoveryRoute('GET', { address: '198.51.100.1' })).code).toBe(403);
    expect(
      (await recoveryRoute('POST', { body: body(), headers: { authorization: 'Bearer forged' } }))
        .code
    ).toBe(401);
    expect(state.receipt).toBeUndefined();
  });
  it.each(['tenant', 'authenticated', 'memberId', 'token', 'reason', 'request_id'])(
    'rejects injected authority or operation field %s',
    async (field) => {
      expect((await recoveryRoute('POST', { body: { ...body(), [field]: 'spoof' } })).code).toBe(
        400
      );
      expect(state.receipt).toBeUndefined();
    }
  );
  it('redacts private failure paths and marks post-write failure uncertain', async () => {
    const request = body();
    state.failDecline = true;
    const result = await recoveryRoute('POST', { body: request });
    expect(result.code).toBe(503);
    expect(result.body).toMatchObject({ error: 'first_job_recovery_uncertain', retry_safe: false });
    expect(JSON.stringify(result.body)).not.toContain('crash-after-tombstone');
    expect(state.record!.status).toBe('approved');
  });
});
