// Exact-operation receipt recovery exercises the real route and durable store.
// Only member lookup is mocked: no personal registry or live tenant is a fixture.
import { randomUUID } from 'node:crypto';
import type express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import * as secureIO from '@agent/core/secure-io';
import type { MemberProfile, MemberRole } from '@agent/core/organization/member-registry';

vi.mock('@agent/core/organization/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/organization/member-registry')>(
    '@agent/core/organization/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});

import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import {
  applyHearingTurn,
  createHearingRecord,
  hearingRevision,
  type HearingDecisionOperation,
  type HearingRecord,
} from './hearing.js';
import { loadHearingRecord, saveHearingRecord, updateHearingRecord } from './hearing-runtime.js';
import { registerHearingRoutes } from './hearing-routes.js';
import * as security from './security.js';

type Handler = (req: unknown, res: unknown) => unknown;
type RequestInput = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
};

function createFakeApp(): { app: express.Express; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const fake = {
    get(routePath: string, handler: Handler) {
      handlers.set('GET ' + routePath, handler);
    },
    post(routePath: string, handler: Handler) {
      handlers.set('POST ' + routePath, handler);
    },
  };
  return { app: fake as unknown as express.Express, handlers };
}

function fakeRequest(input: RequestInput) {
  return {
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    path: '/api/hearing/test',
    originalUrl: '/api/hearing/test',
    url: '/api/hearing/test',
  };
}

function fakeResponse() {
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return response;
    },
  };
  return response;
}

const MEMBER_ID = 'zz-receipt-route-member';
const PRINCIPAL_ID = 'human:presence-studio-localadmin';
const { app, handlers } = createFakeApp();
registerHearingRoutes(app);

function callRoute(route: string, input: RequestInput) {
  const handler = handlers.get(route);
  if (!handler) throw new Error('Missing route: ' + route);
  const response = fakeResponse();
  handler(fakeRequest(input), response);
  return response;
}

function fixtureMember(tenant: string, role: MemberRole = 'owner', id = MEMBER_ID): MemberProfile {
  return {
    member_id: id,
    display_name: 'Receipt Route Tester',
    status: 'active',
    memberships: [{ tenant_slug: tenant, role }],
    access_registrations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function fullyAnsweredRecord(session: string): HearingRecord {
  let record = createHearingRecord(session, '2026-09-14T00:00:00.000Z');
  for (let index = 0; index < record.requirements.length; index += 1) {
    record = applyHearingTurn(
      record,
      { text: 'answer ' + index, request_id: 'turn-' + index },
      '2026-09-14T00:01:00.000Z'
    );
  }
  return record;
}

describe('hearing decision receipt HTTP contract', () => {
  let tenant: string;
  let otherTenant: string;
  let session: string;
  let recordPath: string;
  let operation: HearingDecisionOperation;

  function stored() {
    const record = withExecutionContext('ecosystem_architect', () =>
      loadHearingRecord(tenant, session)
    );
    if (!record) throw new Error('Expected persisted hearing fixture');
    return record;
  }

  function bytes() {
    return withExecutionContext('ecosystem_architect', () =>
      String(secureIO.safeReadFile(recordPath, { encoding: 'utf8' }))
    );
  }

  function decide(body: unknown = operation, sessionId = session) {
    return callRoute('POST /api/hearing/:session/decide', { params: { session: sessionId }, body });
  }

  function receiptQuery(input = operation): Record<string, unknown> {
    return {
      version: String(input.version),
      scenario_id: input.scenario_id,
      requirements_revision: String(input.requirements_revision),
    };
  }

  function receipt(input = operation, query = receiptQuery(input), sessionId = session) {
    return callRoute('GET /api/hearing/:session/decision-receipts/:operation', {
      params: { session: sessionId, operation: input.operation_id },
      query,
    });
  }

  function expectCommitted() {
    const response = decide();
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, decision_receipt: { status: 'current' } });
    return response;
  }

  beforeEach(() => {
    tenant = 'zz-receipt-' + randomUUID().slice(0, 16);
    otherTenant = 'zz-receipt-' + randomUUID().slice(0, 16);
    session = 'session-' + randomUUID();
    vi.stubEnv('KYBERION_TENANT', tenant);
    vi.stubEnv('KYBERION_WISDOM_LLM_PROFILE', 'stub');
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
    vi.stubEnv('KYBERION_DISABLE_EMBEDDINGS', '1');
    vi.stubEnv('KYBERION_PROVIDER_CAPABILITY_PROBE', '0');
    vi.mocked(resolveMemberByPrincipal).mockReset();
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember(tenant));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    recordPath = withExecutionContext('ecosystem_architect', () =>
      saveHearingRecord(tenant, fullyAnsweredRecord(session))
    );
    const record = stored();
    operation = {
      version: 1,
      operation_id: 'operation-' + randomUUID(),
      scenario_id: record.scenario,
      requirements_revision: hearingRevision(record.requirements_revision),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    withExecutionContext('ecosystem_architect', () => {
      for (const namespace of [tenant, otherTenant]) {
        secureIO.safeRmSync(
          pathResolver.rootResolve('active/shared/runtime/hearing/confidential/' + namespace),
          { recursive: true, force: true }
        );
        secureIO.safeRmSync(pathResolver.sharedTmp('hearing/' + namespace), {
          recursive: true,
          force: true,
        });
      }
    });
    vi.unstubAllEnvs();
  });

  it('registers the exact receipt endpoint alongside the decision endpoint', () => {
    expect(handlers.has('POST /api/hearing/:session/decide')).toBe(true);
    expect(handlers.has('GET /api/hearing/:session/decision-receipts/:operation')).toBe(true);
  });

  it('binds successful proof to the server-resolved actor, tenant, session and exact operation', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember(tenant, 'approver'));
    const before = stored();
    const response = expectCommitted();
    const record = stored();
    expect(record.record_revision).toBe(hearingRevision(before.record_revision) + 1);
    expect(record.requirements_revision).toBe(before.requirements_revision);
    expect(record.decision_receipts).toEqual([
      {
        operation,
        identity: {
          principal_id: PRINCIPAL_ID,
          member_id: MEMBER_ID,
          source: 'loopback',
          scope_key: expect.any(String),
        },
        namespace: tenant,
        session_id: session,
        record_revision: record.record_revision,
        decided_at: record.decided_at,
      },
    ]);
    expect(response.body).toMatchObject({
      record: { decided_by: { kind: 'human', id: 'user:' + MEMBER_ID, role: 'approver' } },
      decision_receipt: { status: 'current', receipt: record.decision_receipts?.[0] },
      next_action: { kind: 'alignment_review' },
    });
    expect(response.body).not.toHaveProperty('record.decision_receipts');
    expect(response.body).not.toHaveProperty('record.current_decision_operation_id');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(resolveMemberByPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: PRINCIPAL_ID,
        source: 'loopback',
      })
    );

    const proof = receipt();
    expect(proof.statusCode).toBe(200);
    expect(proof.body).toEqual({
      ok: true,
      decision_receipt: { status: 'current', receipt: record.decision_receipts?.[0] },
    });
    expect(proof.headers.get('Cache-Control')).toBe('no-store');
  });

  it('replays duplicate POSTs and exact GETs without a record write or revision bump', () => {
    expectCommitted();
    const before = stored();
    const beforeBytes = bytes();
    const write = vi.spyOn(secureIO, 'safeWriteFile');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(decide().statusCode).toBe(200);
      expect(receipt().statusCode).toBe(200);
    }
    expect(stored()).toEqual(before);
    expect(bytes()).toBe(beforeBytes);
    expect(write.mock.calls.filter(([path]) => path === recordPath)).toHaveLength(0);
  });

  it.each(['requirements_revision', 'scenario_id'] as const)(
    'rejects stale %s without a decision',
    (field) => {
      const stale =
        field === 'requirements_revision'
          ? { ...operation, requirements_revision: operation.requirements_revision + 1 }
          : { ...operation, scenario_id: 'different_scenario' };
      const before = bytes();
      const response = decide(stale);
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ hearing_conflict: 'stale_snapshot' });
      expect(bytes()).toBe(before);
      expect(stored().decision_receipts).toBeUndefined();
    }
  );

  it.each(['requirements_revision', 'scenario_id'] as const)(
    'rejects operation ID reuse with another %s on POST and GET',
    (field) => {
      expectCommitted();
      const mismatch =
        field === 'requirements_revision'
          ? { ...operation, requirements_revision: operation.requirements_revision + 1 }
          : { ...operation, scenario_id: 'different_scenario' };
      const before = bytes();
      for (const response of [decide(mismatch), receipt(mismatch)]) {
        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ hearing_conflict: 'operation_mismatch' });
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
      expect(bytes()).toBe(before);
    }
  );

  it.each(['legacy', 'versioned'] as const)(
    'rejects a %s decision when requirements change during member resolution',
    (contract) => {
      const before = stored();
      let racedRecord: HearingRecord | undefined;
      vi.mocked(resolveMemberByPrincipal).mockImplementationOnce(() => {
        racedRecord = withExecutionContext('ecosystem_architect', () =>
          updateHearingRecord(tenant, session, (record) => {
            if (!record) throw new Error('Missing fixture');
            return {
              ...record,
              requirements: record.requirements.map((requirement, index) =>
                index === 0
                  ? { ...requirement, answer: 'Changed during authentication' }
                  : requirement
              ),
            };
          })
        );
        return fixtureMember(tenant);
      });

      const response = decide(contract === 'legacy' ? {} : operation);
      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ hearing_conflict: 'stale_snapshot' });
      expect(racedRecord).toBeDefined();
      expect(stored()).toEqual(racedRecord);
      expect(stored().record_revision).toBe(hearingRevision(before.record_revision) + 1);
      expect(stored().requirements_revision).toBe(
        hearingRevision(before.requirements_revision) + 1
      );
      expect(stored().requirements[0].answer).toBe('Changed during authentication');
      expect(stored().decided_by).toBeUndefined();
      expect(stored().decided_at).toBeUndefined();
      expect(stored().decision_receipts).toBeUndefined();
      expect(stored().current_decision_operation_id).toBeUndefined();
    }
  );

  it.each(['member', 'principal'] as const)(
    'rejects an exact operation claimed by a different %s',
    (identityField) => {
      expectCommitted();
      const before = bytes();
      if (identityField === 'member') {
        vi.mocked(resolveMemberByPrincipal).mockReturnValue(
          fixtureMember(tenant, 'owner', 'zz-another-member')
        );
      } else {
        vi.spyOn(security, 'resolvePresenceStudioViewerContext').mockReturnValue({
          principalId: 'human:another-server-principal',
          tenantSlugs: [tenant],
          source: 'loopback',
        });
      }
      for (const response of [decide(), receipt()]) {
        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ hearing_conflict: 'operation_mismatch' });
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
      expect(bytes()).toBe(before);
    }
  );

  it.each(['organizationIds', 'projectIds'] as const)(
    'rejects exact receipt recovery after the same actor changes %s scope',
    (scopeField) => {
      expectCommitted();
      const before = bytes();
      vi.spyOn(security, 'resolvePresenceStudioViewerContext').mockReturnValue({
        principalId: PRINCIPAL_ID,
        tenantSlugs: [tenant],
        source: 'loopback',
        [scopeField]: ['changed-scope'],
      });
      for (const response of [decide(), receipt()]) {
        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ hearing_conflict: 'operation_mismatch' });
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
      expect(bytes()).toBe(before);
    }
  );

  it('canonicalizes equivalent server organization and project scope sets for exact replay', () => {
    const viewer = vi.spyOn(security, 'resolvePresenceStudioViewerContext');
    viewer.mockReturnValue({
      principalId: PRINCIPAL_ID,
      tenantSlugs: [tenant],
      source: 'loopback',
      organizationIds: ['org-z', 'org-a'],
      projectIds: ['project-z', 'project-a'],
    });
    expectCommitted();
    const before = bytes();
    viewer.mockReturnValue({
      principalId: PRINCIPAL_ID,
      tenantSlugs: [tenant],
      source: 'loopback',
      organizationIds: ['org-a', 'org-z'],
      projectIds: ['project-a', 'project-z'],
    });
    for (const response of [decide(), receipt()]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ decision_receipt: { status: 'current' } });
    }
    expect(bytes()).toBe(before);
  });

  it('refuses a token-sourced viewer before exposing or replaying loopback proof', () => {
    expectCommitted();
    const before = bytes();
    vi.spyOn(security, 'resolvePresenceStudioViewerContext').mockReturnValue({
      principalId: PRINCIPAL_ID,
      tenantSlugs: [tenant],
      source: 'token',
    });
    vi.mocked(resolveMemberByPrincipal).mockClear();
    for (const response of [decide(), receipt()]) {
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toHaveProperty('decision_receipt');
    }
    expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
    expect(bytes()).toBe(before);
  });

  it.each(['unregistered', 'viewer', 'operator', 'other-tenant'] as const)(
    'refuses %s members on both receipt and decision endpoints',
    (kind) => {
      expectCommitted();
      const before = bytes();
      vi.mocked(resolveMemberByPrincipal).mockReturnValue(
        kind === 'unregistered'
          ? null
          : kind === 'other-tenant'
            ? fixtureMember(otherTenant)
            : fixtureMember(tenant, kind)
      );
      for (const response of [decide(), receipt()]) {
        expect(response.statusCode).toBe(403);
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
      expect(bytes()).toBe(before);
    }
  );

  it('does not allow a different server tenant to recover proof using a client-supplied tenant', () => {
    expectCommitted();
    const before = bytes();
    vi.stubEnv('KYBERION_TENANT', otherTenant);
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember(otherTenant));
    const response = receipt(operation, { ...receiptQuery(), tenant });
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ ok: false, decision_receipt_status: 'unknown' });
    expect(bytes()).toBe(before);
    expect(
      withExecutionContext('ecosystem_architect', () => loadHearingRecord(otherTenant, session))
    ).toBeNull();
  });

  it('returns only superseded historical proof after newer requirements and never restores the old decision', () => {
    expectCommitted();
    const originalReceipt = stored().decision_receipts?.[0];
    withExecutionContext('ecosystem_architect', () =>
      updateHearingRecord(tenant, session, (record) => {
        if (!record) throw new Error('Missing fixture');
        return {
          ...record,
          requirements: record.requirements.map((requirement, index) =>
            index === 0 ? { ...requirement, answer: 'Changed after decision' } : requirement
          ),
        };
      })
    );
    const before = bytes();
    expect(stored().decided_by).toBeUndefined();
    expect(stored().decided_at).toBeUndefined();
    expect(stored().current_decision_operation_id).toBeUndefined();
    for (const response of [receipt(), decide()]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        decision_receipt: { status: 'superseded', receipt: originalReceipt },
      });
      expect(response.body).not.toHaveProperty('record');
      expect(response.body).not.toHaveProperty('next_action');
    }
    expect(bytes()).toBe(before);
    expect(stored().decided_by).toBeUndefined();
  });

  it('keeps a newer decision current while an older exact operation is replayed', () => {
    expectCommitted();
    const newer = { ...operation, operation_id: 'newer-' + randomUUID() };
    expect(decide(newer).statusCode).toBe(200);
    const before = bytes();
    expect(decide().body).toMatchObject({ decision_receipt: { status: 'superseded' } });
    expect(receipt().body).toMatchObject({ decision_receipt: { status: 'superseded' } });
    expect(receipt(newer).body).toMatchObject({ decision_receipt: { status: 'current' } });
    expect(stored().current_decision_operation_id).toBe(newer.operation_id);
    expect(bytes()).toBe(before);
  });

  it('marks missing proof unknown for an existing decision and for an absent session', () => {
    expectCommitted();
    const before = bytes();
    const absent = { ...operation, operation_id: 'absent-' + randomUUID() };
    for (const response of [
      receipt(absent),
      receipt(operation, receiptQuery(), 'missing-session'),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ ok: false, decision_receipt_status: 'unknown' });
      expect(response.body).not.toHaveProperty('unexecuted');
      expect(response.body).not.toHaveProperty('next_action');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(bytes()).toBe(before);
    expect(
      withExecutionContext('ecosystem_architect', () =>
        loadHearingRecord(tenant, 'missing-session')
      )
    ).toBeNull();
  });

  it.each([
    ['missing version', { version: undefined }],
    ['unsupported version', { version: '2' }],
    ['missing scenario', { scenario_id: undefined }],
    ['unsafe scenario', { scenario_id: '../web_app_build' }],
    ['missing revision', { requirements_revision: undefined }],
    ['negative revision', { requirements_revision: '-1' }],
    ['fractional revision', { requirements_revision: '1.5' }],
    ['noncanonical revision', { requirements_revision: '01' }],
    ['unsafe integer revision', { requirements_revision: '9007199254740992' }],
    ['array revision', { requirements_revision: ['1', '2'] }],
  ])('rejects malformed receipt query: %s', (_name, patch) => {
    const before = bytes();
    const response = receipt(operation, { ...receiptQuery(), ...patch });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toHaveProperty('decision_receipt');
    expect(response.body).not.toHaveProperty('decision_receipt_status', 'unexecuted');
    expect(bytes()).toBe(before);
  });

  it.each([
    ['unsupported version', { version: 2 }],
    ['string revision', { requirements_revision: '1' }],
    ['negative revision', { requirements_revision: -1 }],
    ['missing scenario', { scenario_id: undefined }],
    ['unsafe operation', { operation_id: '../operation' }],
    ['client actor injection', { member_id: 'another-member' }],
    ['client namespace injection', { namespace: 'another-tenant' }],
  ])('rejects malformed decision body: %s', (_name, patch) => {
    const before = bytes();
    const response = decide({ ...operation, ...patch });
    expect(response.statusCode).toBe(400);
    expect(bytes()).toBe(before);
    expect(stored().decision_receipts).toBeUndefined();
  });

  it('keeps empty legacy decision bodies compatible without creating receipt proof', () => {
    const response = decide({});
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ record: { decided_by: { id: 'user:' + MEMBER_ID } } });
    expect(response.body).not.toHaveProperty('decision_receipt');
    expect(stored().decision_receipts).toBeUndefined();
    expect(stored().current_decision_operation_id).toBeUndefined();
    const before = bytes();
    expect(receipt().body).toEqual({ ok: false, decision_receipt_status: 'unknown' });
    expect(bytes()).toBe(before);
  });

  it('strips internal receipts from generic GET while preserving the stored decision proof', () => {
    expectCommitted();
    const before = bytes();
    const response = callRoute('GET /api/hearing/:session', { params: { session } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      persisted: true,
      record: { decided_by: { id: 'user:' + MEMBER_ID } },
    });
    expect(response.body).not.toHaveProperty('record.decision_receipts');
    expect(response.body).not.toHaveProperty('record.current_decision_operation_id');
    expect(response.body).not.toHaveProperty('decision_receipt');
    expect(stored().decision_receipts).toHaveLength(1);
    expect(bytes()).toBe(before);
  });
});
