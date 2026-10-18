import { randomUUID } from 'node:crypto';
import type express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import * as secureIO from '@agent/core/secure-io';

vi.mock('@agent/core/organization/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/organization/member-registry')>(
    '@agent/core/organization/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});
vi.mock('@agent/core/workforce/work-inventory-decompose', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/workforce/work-inventory-decompose')>(
    '@agent/core/workforce/work-inventory-decompose'
  )),
  proposeWorkDecomposition: vi.fn(),
}));
vi.mock('@agent/core/workforce/work-inventory', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/workforce/work-inventory')>(
    '@agent/core/workforce/work-inventory'
  )),
  saveWorkInventoryEntry: vi.fn(),
}));
vi.mock('./hearing-canvas.js', async () => ({
  ...(await vi.importActual<typeof import('./hearing-canvas.js')>('./hearing-canvas.js')),
  generateHearingCanvas: vi.fn(),
}));
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { proposeWorkDecomposition } from '@agent/core/workforce/work-inventory-decompose';
import { saveWorkInventoryEntry } from '@agent/core/workforce/work-inventory';
import { generateHearingCanvas } from './hearing-canvas.js';
import * as storageAccess from './hearing-storage-access.js';
import {
  createHearingRecord,
  hearingRevision,
  type HearingRecord,
  type HearingDecisionOperation,
} from './hearing.js';
import { loadHearingRecord, saveHearingRecord } from './hearing-runtime.js';
import { registerHearingRoutes } from './hearing-routes.js';
import { registerHearingMissionRoutes } from './hearing-mission-routes.js';
import * as security from './security.js';

const ROUTES = [
  'GET /api/hearing/:session',
  'GET /api/hearing/:session/canvas',
  'POST /api/hearing/:session/answer',
  'POST /api/hearing/:session/decide',
  'GET /api/hearing/:session/decision-receipts/:operation',
  'POST /api/hearing/:session/inventory',
  'POST /api/hearing/:session/handoff',
] as const;
const SCOPE_KEYS = ['tenant', 'organizationId', 'projectId'] as const;
type HearingResponse = {
  record: HearingRecord & { handoff_snapshot?: { version: 1; token: string } };
  canvas_url: string;
  persisted: boolean;
};

type Handler = (req: unknown, res: unknown) => unknown;
const handlers = new Map<string, Handler>();
const app = {
  get(path: string, handler: Handler) {
    handlers.set('GET ' + path, handler);
  },
  post(path: string, handler: Handler) {
    handlers.set('POST ' + path, handler);
  },
} as unknown as express.Express;
registerHearingRoutes(app);
registerHearingMissionRoutes(app);

async function call(
  route: string,
  session: string,
  query: Record<string, unknown> = {},
  body?: unknown
) {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(value: unknown) {
      response.body = value;
      return response;
    },
    send(value: unknown) {
      response.body = value;
      return response;
    },
    setHeader() {
      return response;
    },
    type() {
      return response;
    },
  };
  await handlers.get(route)!(
    {
      params: { session, operation: 'scope-operation' },
      query,
      body,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      path: '/api/hearing/test',
      originalUrl: '/api/hearing/test',
      url: '/api/hearing/test',
    },
    response
  );
  return response;
}

function decidedRecord(session: string): HearingRecord {
  const record = createHearingRecord(session, '2026-10-18T07:00:00.000Z');
  return {
    ...record,
    requirements: record.requirements.map((item) => ({
      ...item,
      answer: 'Synthetic answer',
      confidence: 1,
    })),
    decided_by: { kind: 'human', id: 'user:scope-member', role: 'owner' },
    decided_at: '2026-10-18T07:01:00.000Z',
  };
}

describe('hearing selected request scope', () => {
  let tenant: string;
  let session: string;
  let otherTenant: string;
  let recordPath: string;
  let viewer: security.PresenceStudioViewerContext;
  function stored(namespace = tenant, sessionId = session) {
    return withExecutionContext(
      'ecosystem_architect',
      () => loadHearingRecord(namespace, sessionId),
      undefined,
      namespace
    );
  }

  function bytes() {
    return withExecutionContext(
      'ecosystem_architect',
      () => secureIO.safeReadFile(recordPath, { encoding: 'utf8' }),
      undefined,
      tenant
    );
  }

  function expectNoEffects() {
    expect(secureIO.safeExecResult).not.toHaveBeenCalled();
    expect(proposeWorkDecomposition).not.toHaveBeenCalled();
    expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
    expect(generateHearingCanvas).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    tenant = 'zz-scope-' + randomUUID().slice(0, 15);
    otherTenant = 'zz-scope-' + randomUUID().slice(0, 15);
    session = 'scope-' + randomUUID();
    viewer = {
      principalId: 'human:scope-owner',
      source: 'loopback',
      tenantSlugs: [tenant],
      organizationIds: ['org-a', 'org-b'],
      projectIds: ['project-a', 'project-b'],
    };
    vi.spyOn(security, 'resolvePresenceStudioViewerContext').mockImplementation(() => viewer);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
    vi.stubEnv('KYBERION_WISDOM_LLM_PROFILE', 'stub');
    vi.spyOn(secureIO, 'safeExecResult').mockImplementation(() => {
      throw new Error('No lifecycle subprocess is allowed in scope tests.');
    });
    vi.mocked(proposeWorkDecomposition)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('No decomposition is allowed in rejected scope tests.');
      });
    vi.mocked(saveWorkInventoryEntry)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('No inventory write is allowed in scope tests.');
      });
    vi.mocked(generateHearingCanvas).mockReset().mockResolvedValue({
      source: 'template',
      html: '<html><body>synthetic fallback</body></html>',
    });
    vi.mocked(resolveMemberByPrincipal)
      .mockReset()
      .mockReturnValue({
        member_id: 'scope-member',
        display_name: 'Scope owner',
        status: 'active',
        memberships: [tenant, otherTenant].map((tenant_slug) => ({
          tenant_slug,
          role: 'owner' as const,
        })),
        access_registrations: [],
        created_at: '2026-10-18T07:00:00.000Z',
        updated_at: '2026-10-18T07:00:00.000Z',
      });
    recordPath = withExecutionContext(
      'ecosystem_architect',
      () => saveHearingRecord(tenant, decidedRecord(session)),
      undefined,
      tenant
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const namespace of [tenant, otherTenant]) {
      withExecutionContext(
        'ecosystem_architect',
        () => {
          secureIO.safeRmSync(
            pathResolver.rootResolve('active/shared/runtime/hearing/confidential/' + namespace),
            { recursive: true, force: true }
          );
          secureIO.safeRmSync(pathResolver.sharedTmp('hearing/' + namespace), {
            recursive: true,
            force: true,
          });
        },
        undefined,
        namespace
      );
    }
    vi.unstubAllEnvs();
  });

  it('binds displayed snapshots to the selected organization and project', async () => {
    const first = await call('GET /api/hearing/:session', session, {
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    const second = await call('GET /api/hearing/:session', session, {
      organizationId: 'org-b',
      projectId: 'project-b',
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const snapshot = (value: typeof first) =>
      (value.body as { record: { handoff_snapshot: { token: string } } }).record.handoff_snapshot
        .token;
    expect(snapshot(first)).not.toBe(snapshot(second));
  });

  it('rejects a selected organization outside the server allowed set', async () => {
    const response = await call('GET /api/hearing/:session', session, {
      organizationId: 'org-denied',
    });
    expect(response.statusCode).toBe(403);
  });

  it('preserves the selected scope on the separate canvas URL', async () => {
    const response = await call('GET /api/hearing/:session', session, {
      tenant,
      organizationId: 'org-b',
      projectId: 'project-b',
    });
    expect(response.statusCode).toBe(200);
    const url = new URL((response.body as { canvas_url: string }).canvas_url, 'http://localhost');
    expect(url.searchParams.get('tenant')).toBe(tenant);
    expect(url.searchParams.get('organizationId')).toBe('org-b');
    expect(url.searchParams.get('projectId')).toBe('project-b');
  });

  it('registers all seven hearing endpoints behind the request scope boundary', () => {
    expect([...handlers.keys()].sort()).toEqual([...ROUTES].sort());
  });

  it.each(ROUTES)(
    '%s rejects denied selectors before storage, identity or effects',
    async (route) => {
      const before = bytes();
      const storage = vi.spyOn(storageAccess, 'hearingStorageForViewer');
      vi.mocked(resolveMemberByPrincipal).mockClear();
      for (const key of SCOPE_KEYS) {
        const response = await call(
          route,
          session,
          { [key]: 'denied-scope' },
          {
            text: 'Must never persist',
            scenario_id: 'work_inventory',
          }
        );
        expect(response.statusCode, key).toBe(403);
        expect(response.body).not.toHaveProperty('record');
        expect(response.body).not.toHaveProperty('decision_receipt');
        expect(response.body).not.toHaveProperty('decision_receipt_status');
      }
      expect(storage).not.toHaveBeenCalled();
      expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
      expectNoEffects();
      expect(bytes()).toBe(before);
    }
  );

  it.each(ROUTES)('%s rejects malformed scalar, array and object selectors', async (route) => {
    const before = bytes();
    const storage = vi.spyOn(storageAccess, 'hearingStorageForViewer');
    vi.mocked(resolveMemberByPrincipal).mockClear();
    for (const key of SCOPE_KEYS) {
      for (const value of [0, false, null, [], ['org-a'], { value: 'org-a' }, '../escape']) {
        const response = await call(
          route,
          session,
          { [key]: value },
          {
            text: 'Must never persist',
            scenario_id: 'work_inventory',
          }
        );
        expect(response.statusCode, key + ': ' + JSON.stringify(value)).toBe(403);
        expect(response.body).not.toHaveProperty('record');
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
    }
    expect(storage).not.toHaveBeenCalled();
    expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
    expectNoEffects();
    expect(bytes()).toBe(before);
  });

  it.each(ROUTES)(
    '%s rejects missing or empty selection for a finite multi-tenant viewer',
    async (route) => {
      viewer.tenantSlugs = [tenant, otherTenant];
      const before = bytes();
      const storage = vi.spyOn(storageAccess, 'hearingStorageForViewer');
      vi.mocked(resolveMemberByPrincipal).mockClear();
      for (const query of [{}, { tenant: '' }, { tenant: '  ' }]) {
        const response = await call(route, session, query, {});
        expect(response.statusCode).toBe(403);
        expect(response.body).not.toHaveProperty('record');
      }
      expect(storage).not.toHaveBeenCalled();
      expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
      expectNoEffects();
      expect(bytes()).toBe(before);
      expect(stored(otherTenant)).toBeNull();
    }
  );

  it('retains server-derived scope when selectors are omitted or empty', async () => {
    viewer.organizationIds = ['org-a'];
    viewer.projectIds = ['project-a'];
    const before = bytes();
    const explicit = await call('GET /api/hearing/:session', session, {
      tenant,
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    expect(explicit.statusCode).toBe(200);
    for (const query of [
      {},
      { tenant: '', organizationId: '', projectId: '' },
      { tenant: '  ', organizationId: '  ', projectId: '  ' },
    ]) {
      const response = await call('GET /api/hearing/:session', session, query);
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(explicit.body);
    }
    expect(bytes()).toBe(before);
    expectNoEffects();
  });

  it.each(['all', 'finite'] as const)(
    'isolates durable records and versioned canvas roundtrips for a %s multi-tenant viewer',
    async (breadth) => {
      viewer.tenantSlugs = breadth === 'all' ? 'all' : [tenant, otherTenant];
      const second = decidedRecord(session);
      second.requirements = second.requirements.map((item) => ({
        ...item,
        answer: 'Tenant B private answer',
      }));
      withExecutionContext(
        'ecosystem_architect',
        () => saveHearingRecord(otherTenant, second),
        undefined,
        otherTenant
      );
      const before = bytes();
      const selections = [
        { tenant, organizationId: 'org-a', projectId: 'project-a' },
        { tenant: otherTenant, organizationId: 'org-b', projectId: 'project-b' },
      ];
      const expectedAnswers = ['Synthetic answer', 'Tenant B private answer'];
      const writeSession = 'selected-' + randomUUID();
      const canvasBodies: string[] = [];
      for (const [index, selection] of selections.entries()) {
        const response = await call('GET /api/hearing/:session', session, selection);
        expect(response.statusCode).toBe(200);
        const existing = response.body as HearingResponse;
        expect(existing.persisted).toBe(true);
        expect(existing.record.requirements[0].answer).toBe(expectedAnswers[index]);
        const text = 'Tenant ' + (index === 0 ? 'A' : 'B') + ' isolated inventory task';
        const answer = await call('POST /api/hearing/:session/answer', writeSession, selection, {
          text,
          scenario_id: 'work_inventory',
          request_id: 'first-answer',
        });
        expect(answer.statusCode).toBe(200);
        const payload = answer.body as HearingResponse;
        expect(payload.record.canvas_versions).toEqual(['v1']);
        expect(stored(selection.tenant, writeSession)?.requirements[0].answer).toBe(text);
        const url = new URL(payload.canvas_url, 'http://localhost');
        for (const [key, value] of Object.entries(selection)) {
          expect(url.searchParams.get(key)).toBe(value);
        }
        expect(url.searchParams.get('scenario_id')).toBe('work_inventory');
        url.searchParams.set('version', 'v1');
        const canvas = await call(
          'GET /api/hearing/:session/canvas',
          writeSession,
          Object.fromEntries(url.searchParams)
        );
        expect(canvas.statusCode).toBe(200);
        expect(canvas.body).toContain(text);
        expect(canvas.body).not.toContain(index === 0 ? 'Tenant B isolated' : 'Tenant A isolated');
        canvasBodies.push(canvas.body as string);
      }
      expect(canvasBodies[0]).not.toBe(canvasBodies[1]);
      expect(bytes()).toBe(before);
      expectNoEffects();
    }
  );

  it('recovers only the exact selected decision scope without mutating changed-selector requests', async () => {
    viewer.tenantSlugs = [tenant, otherTenant];
    const selection = { tenant, organizationId: 'org-a', projectId: 'project-a' };
    const record = stored()!;
    const operation: HearingDecisionOperation = {
      version: 1,
      operation_id: 'scope-operation',
      scenario_id: record.scenario,
      requirements_revision: hearingRevision(record.requirements_revision),
    };
    const receiptQuery = {
      version: String(operation.version),
      scenario_id: operation.scenario_id,
      requirements_revision: String(operation.requirements_revision),
    };
    const decided = await call('POST /api/hearing/:session/decide', session, selection, operation);
    expect(decided.statusCode).toBe(200);
    expect(decided.body).toMatchObject({ decision_receipt: { status: 'current' } });
    const before = bytes();
    for (const response of [
      await call('POST /api/hearing/:session/decide', session, selection, operation),
      await call('GET /api/hearing/:session/decision-receipts/:operation', session, {
        ...selection,
        ...receiptQuery,
      }),
    ]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ decision_receipt: { status: 'current' } });
    }
    for (const changed of [{ organizationId: 'org-b' }, { projectId: 'project-b' }]) {
      for (const response of [
        await call(
          'POST /api/hearing/:session/decide',
          session,
          { ...selection, ...changed },
          operation
        ),
        await call('GET /api/hearing/:session/decision-receipts/:operation', session, {
          ...selection,
          ...changed,
          ...receiptQuery,
        }),
      ]) {
        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ hearing_conflict: 'operation_mismatch' });
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
    }
    const other = await call('GET /api/hearing/:session/decision-receipts/:operation', session, {
      ...selection,
      tenant: otherTenant,
      ...receiptQuery,
    });
    expect(other.statusCode).toBe(404);
    expect(other.body).toEqual({ ok: false, decision_receipt_status: 'unknown' });
    expect(bytes()).toBe(before);
    expect(stored(otherTenant)).toBeNull();
    expectNoEffects();
  });

  it.each(['mission', 'inventory'] as const)(
    'rejects a stale displayed %s snapshot when selected query scope changes before effects',
    async (kind) => {
      if (kind === 'inventory') {
        session = 'inventory-' + randomUUID();
        const inventory: HearingRecord = {
          ...decidedRecord(session),
          scenario: 'work_inventory',
          requirements: [
            {
              id: 'task_name',
              label_key: 'front_desk:hearing_inventory_task_name',
              answer: 'Synthetic inventory task',
              confidence: 1,
            },
          ],
        };
        recordPath = withExecutionContext(
          'ecosystem_architect',
          () => saveHearingRecord(tenant, inventory),
          undefined,
          tenant
        );
      }
      viewer.tenantSlugs = [tenant, otherTenant];
      const sameRecord = stored()!;
      withExecutionContext(
        'ecosystem_architect',
        () => saveHearingRecord(otherTenant, sameRecord),
        undefined,
        otherTenant
      );
      const selection = { tenant, organizationId: 'org-a', projectId: 'project-a' };
      const displayed = await call('GET /api/hearing/:session', session, selection);
      expect(displayed.statusCode).toBe(200);
      const snapshot = (displayed.body as HearingResponse).record.handoff_snapshot;
      expect(snapshot).toBeDefined();
      const before = bytes();
      const otherBefore = stored(otherTenant);
      for (const changed of [
        { tenant: otherTenant },
        { organizationId: 'org-b' },
        { projectId: 'project-b' },
      ]) {
        const response = await call(
          'POST /api/hearing/:session/' + (kind === 'mission' ? 'handoff' : 'inventory'),
          session,
          { ...selection, ...changed },
          { handoff_snapshot: snapshot }
        );
        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ hearing_conflict: 'stale_snapshot' });
        expect(bytes()).toBe(before);
        expect(stored(otherTenant)).toEqual(otherBefore);
      }
      expect(stored()).not.toHaveProperty('handoff_pending');
      expectNoEffects();
    }
  );

  it.each(ROUTES)(
    '%s rejects explicit legacy tenant sentinels for an unrestricted viewer',
    async (route) => {
      viewer.tenantSlugs = 'all';
      const before = bytes();
      const storage = vi.spyOn(storageAccess, 'hearingStorageForViewer');
      vi.mocked(resolveMemberByPrincipal).mockClear();
      for (const tenantSelection of ['all', 'unscoped']) {
        const response = await call(route, session, { tenant: tenantSelection }, {});
        expect(response.statusCode, tenantSelection).toBe(403);
        expect(response.body).not.toHaveProperty('record');
        expect(response.body).not.toHaveProperty('decision_receipt');
      }
      expect(storage).not.toHaveBeenCalled();
      expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
      expectNoEffects();
      expect(bytes()).toBe(before);
    }
  );
});
