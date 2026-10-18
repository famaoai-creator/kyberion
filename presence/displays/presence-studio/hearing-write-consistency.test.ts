import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type express from 'express';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { findHearingScenario } from '@agent/core/hearing-scenario-catalog';

const writeFault = vi.hoisted(() => ({ session: '', phase: '' as '' | 'reserve' | 'finish' }));
vi.mock('@agent/core/secure-io', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
  return {
    ...actual,
    safeWriteFile: (...args: Parameters<typeof actual.safeWriteFile>) => {
      if (writeFault.phase && String(args[0]).endsWith('/' + writeFault.session + '.json')) {
        const record = JSON.parse(String(args[1]));
        if (
          (writeFault.phase === 'reserve' && record.handoff_pending) ||
          (writeFault.phase === 'finish' && record.work_inventory_entry_id)
        ) {
          throw new Error('Injected hearing ' + writeFault.phase + ' write failure');
        }
      }
      return actual.safeWriteFile(...args);
    },
  };
});

vi.mock('@agent/core/organization/member-registry', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/organization/member-registry')>(
    '@agent/core/organization/member-registry'
  )),
  resolveMemberByPrincipal: vi.fn(),
}));
vi.mock('./hearing-canvas.js', () => ({ generateHearingCanvas: vi.fn() }));
vi.mock('./hearing-work-inventory.js', async () => ({
  ...(await vi.importActual<typeof import('./hearing-work-inventory.js')>(
    './hearing-work-inventory.js'
  )),
  renderWorkInventoryCanvasHtml: vi.fn(),
}));
vi.mock('@agent/core/workforce/work-inventory-decompose', () => ({
  proposeWorkDecomposition: vi.fn(),
}));
vi.mock('@agent/core/workforce/work-inventory', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/workforce/work-inventory')>(
    '@agent/core/workforce/work-inventory'
  )),
  saveWorkInventoryEntry: vi.fn(),
  loadWorkInventoryEntry: vi.fn(),
}));
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { proposeWorkDecomposition } from '@agent/core/workforce/work-inventory-decompose';
import {
  createWorkInventoryEntry,
  loadWorkInventoryEntry,
  saveWorkInventoryEntry,
} from '@agent/core/workforce/work-inventory';
import { generateHearingCanvas } from './hearing-canvas.js';
import { renderWorkInventoryCanvasHtml } from './hearing-work-inventory.js';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import { loadHearingRecord, saveHearingRecord, updateHearingRecord } from './hearing-runtime.js';
import { registerHearingRoutes } from './hearing-routes.js';
import {
  harness,
  response as clientResponse,
  flush as flushClient,
} from './ask-client-test-harness.js';

const TENANT = 'zz-hearing-write-consistency';
const NOW = '2026-10-17T10:00:00.000Z';
const HTML = '<html><head></head><body>current</body></html>';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
type Handler = (req: unknown, res: unknown) => unknown;
function routes() {
  const handlers = new Map<string, Handler>();
  registerHearingRoutes({
    get: (path: string, handler: Handler) => handlers.set('GET ' + path, handler),
    post: (path: string, handler: Handler) => handlers.set('POST ' + path, handler),
  } as unknown as express.Express);
  return handlers;
}
function request(session: string, body: unknown = {}) {
  return {
    params: { session },
    query: {},
    body,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    path: '/api/hearing/test',
    originalUrl: '/api/hearing/test',
    url: '/api/hearing/test',
  };
}
function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    type() {
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}
function seed(session: string, scenarioId = 'work_inventory', decided = false) {
  const scenario = findHearingScenario(scenarioId)!;
  let record = createHearingRecord(session, NOW, scenario);
  for (let i = 0; i < record.requirements.length; i++) {
    record = applyHearingTurn(
      record,
      { text: 'answer ' + i, request_id: 'seed-' + i },
      NOW,
      scenario
    );
  }
  if (decided)
    record = {
      ...record,
      decided_by: { kind: 'human', id: 'user:original', role: 'owner' },
      decided_at: NOW,
    };
  saveHearingRecord(TENANT, record);
  return loadHearingRecord(TENANT, session)!;
}
function edit(text: string, requirement = 'task_name') {
  return { text, intent_resolution: { missing_inputs: [requirement] } };
}

describe('hearing writer consistency across async boundaries', () => {
  let previousTenant: string | undefined;
  const handlers = routes();
  const answer = handlers.get('POST /api/hearing/:session/answer')!;
  const decide = handlers.get('POST /api/hearing/:session/decide')!;
  const inventory = handlers.get('POST /api/hearing/:session/inventory')!;
  function viewedHandoffRequest(session: string) {
    const viewed = response();
    handlers.get('GET /api/hearing/:session')!(request(session), viewed);
    const body = viewed.body as { record: { handoff_snapshot?: unknown } };
    return request(session, { handoff_snapshot: body.record.handoff_snapshot });
  }

  beforeEach(() => {
    previousTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = TENANT;
    vi.clearAllMocks();
    writeFault.phase = '';
    writeFault.session = '';
    vi.mocked(renderWorkInventoryCanvasHtml).mockReset().mockResolvedValue(HTML);
    vi.mocked(generateHearingCanvas)
      .mockReset()
      .mockResolvedValue({ source: 'template', html: HTML });
    vi.mocked(proposeWorkDecomposition).mockReset();
    vi.mocked(loadWorkInventoryEntry).mockReset().mockReturnValue(null);
    vi.mocked(saveWorkInventoryEntry)
      .mockReset()
      .mockImplementation((entry) => entry);
    vi.mocked(resolveMemberByPrincipal).mockReturnValue({
      member_id: 'current-decider',
      display_name: 'Current decider',
      status: 'active',
      memberships: [{ tenant_slug: TENANT, role: 'owner' }],
      access_registrations: [],
      created_at: NOW,
      updated_at: NOW,
    });
  });
  afterEach(async () => {
    await flush();
    vi.useRealTimers();
    if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = previousTenant;
    safeRmSync(pathResolver.rootResolve('active/shared/runtime/hearing/confidential/' + TENANT), {
      recursive: true,
      force: true,
    });
    safeRmSync(pathResolver.sharedTmp('hearing/' + TENANT), { recursive: true, force: true });
  });

  it('does not roll back a newer answer when an older inventory canvas finishes last', async () => {
    const session = 'answer-' + randomUUID();
    seed(session);
    const render = deferred<string>();
    vi.mocked(renderWorkInventoryCanvasHtml).mockReturnValueOnce(render.promise);
    const first = response();
    const pending = answer(request(session, edit('older edit')), first);
    const second = response();
    await answer(request(session, edit('newest edit')), second);
    expect(second.statusCode).toBe(200);
    render.resolve(HTML);
    await pending;
    expect(loadHearingRecord(TENANT, session)?.requirements[0].answer).toBe('newest edit');
  });

  it('does not erase a newer human decision when an inventory canvas completes', async () => {
    const session = 'decision-' + randomUUID();
    seed(session);
    const render = deferred<string>();
    vi.mocked(renderWorkInventoryCanvasHtml).mockReturnValueOnce(render.promise);
    const pending = answer(request(session, edit('new answer')), response());
    const decision = response();
    await decide(request(session), decision);
    expect(decision.statusCode).toBe(200);
    render.resolve(HTML);
    await pending;
    expect(loadHearingRecord(TENANT, session)?.decided_by?.id).toBe('user:current-decider');
  });

  it('invalidates decision after the decided answer changes', async () => {
    const session = 'invalidate-' + randomUUID();
    seed(session, 'work_inventory', true);
    await answer(request(session, edit('changed after decision')), response());
    const stored = loadHearingRecord(TENANT, session);
    expect(stored?.decided_by).toBeUndefined();
    expect(stored?.decided_at).toBeUndefined();
  });

  it('rejects an older displayed decision when a new decision already exists before the click', async () => {
    const session = 'old-view-' + randomUUID();
    seed(session, 'work_inventory', true);
    const viewed = response();
    await handlers.get('GET /api/hearing/:session')!(request(session), viewed);
    const oldView = viewed.body as { record: { handoff_snapshot?: unknown } };
    await answer(request(session, edit('newer answer from another tab')), response());
    const newer = response();
    await decide(request(session), newer);
    expect(newer.statusCode).toBe(200);
    const entry = createWorkInventoryEntry({
      title: 'newer answer from another tab',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    vi.mocked(proposeWorkDecomposition).mockResolvedValue({
      entry,
      warnings: [],
      source: 'heuristic',
    });
    const result = response();
    await inventory(
      request(session, { handoff_snapshot: oldView.record.handoff_snapshot }),
      result
    );
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({ hearing_conflict: 'stale_snapshot' });
    expect(proposeWorkDecomposition).not.toHaveBeenCalled();
    expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
    expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('handoff_pending');
  });

  it('keeps a real stale inventory route response guarded in the client with the unsent draft intact', async () => {
    const session = 'client-stale-' + randomUUID();
    seed(session, 'work_inventory', true);
    let postStatus = 0;
    let displayed: unknown;
    const h = harness({
      query: '?mode=hearing&scenario=work_inventory&tenant=' + TENANT,
      storage: new Map([['kyberion.ask.session_id', session]]),
      hearing: async (_url, init) => {
        const result = response();
        if (init?.method === 'POST') {
          await inventory(request(session, JSON.parse(init.body!)), result);
          postStatus = result.statusCode;
        } else {
          await handlers.get('GET /api/hearing/:session')!(request(session), result);
          displayed = (result.body as { record: { handoff_snapshot?: unknown } }).record
            .handoff_snapshot;
        }
        return clientResponse(result.body, result.statusCode);
      },
    });
    await flushClient();
    const oldSnapshot = structuredClone(displayed);
    expect(oldSnapshot).toBeDefined();
    await answer(request(session, edit('Changed in tab B')), response());
    const newer = response();
    await decide(request(session), newer);
    expect(newer.statusCode).toBe(200);
    h.input.value = 'Unsent next thought';
    h.input.fire('input');
    h.elements.get('hearing-handoff')!.fire('click');
    await flushClient();
    expect(postStatus).toBe(409);
    const posts = () => h.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1]!.body!)).toEqual({ handoff_snapshot: oldSnapshot });
    expect(h.input.value).toBe('Unsent next thought');
    expect(h.elements.get('hearing-handoff-status')!.textContent).toBe(
      'front_desk:hearing_conflict_stale_snapshot'
    );
    const markerKey = 'kyberion.ask.hearing.completion.' + session;
    const marker = h.storage.get(markerKey);
    expect(marker).toBeTruthy();
    h.elements.get('hearing-handoff')!.fire('click');
    h.form.fire('submit');
    h.elements.get('hearing-completion-check')!.fire('click');
    await flushClient();
    expect(posts()).toHaveLength(1);
    expect(h.storage.get(markerKey)).toBe(marker);
    expect(h.input.value).toBe('Unsent next thought');
    expect(proposeWorkDecomposition).not.toHaveBeenCalled();
    expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
    expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('handoff_pending');
    h.browserEvent('pagehide');
  });

  it('rejects stale inventory decomposition before creating an orphan entry or restoring a decision', async () => {
    const session = 'inventory-' + randomUUID();
    seed(session, 'work_inventory', true);
    const decomposition = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
    vi.mocked(proposeWorkDecomposition).mockReturnValueOnce(decomposition.promise);
    const result = response();
    const pending = inventory(viewedHandoffRequest(session), result);
    await answer(request(session, edit('changed during decomposition')), response());
    const entry = createWorkInventoryEntry({
      title: 'stale',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    decomposition.resolve({ entry, warnings: [], source: 'heuristic' });
    await pending;
    expect(result.statusCode).toBe(409);
    expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
    const stored = loadHearingRecord(TENANT, session);
    expect(stored?.requirements[0].answer).toBe('changed during decomposition');
    expect(stored?.decided_by).toBeUndefined();
    expect(stored).not.toHaveProperty('work_inventory_entry_id');
  });

  it.each(['legacy', 'versioned'] as const)(
    'rejects a same-actor same-timestamp %s redecision during decomposition',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
      const session = 'same-decision-' + randomUUID();
      seed(session, 'work_inventory');
      const decisionBody = () =>
        mode === 'legacy'
          ? {}
          : {
              version: 1,
              operation_id: 'op-' + randomUUID(),
              scenario_id: 'work_inventory',
              requirements_revision: loadHearingRecord(TENANT, session)!.requirements_revision,
            };
      const firstDecision = response();
      await decide(request(session, decisionBody()), firstDecision);
      expect(firstDecision.statusCode).toBe(200);
      const before = loadHearingRecord(TENANT, session)!;
      const viewedRequest = viewedHandoffRequest(session);
      const decomposition = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
      vi.mocked(proposeWorkDecomposition).mockReturnValueOnce(decomposition.promise);
      const result = response();
      const pending = inventory(viewedRequest, result);
      const nextDecision = response();
      await decide(request(session, decisionBody()), nextDecision);
      expect(nextDecision.statusCode).toBe(200);
      const after = loadHearingRecord(TENANT, session)!;
      expect(after.decided_at).toBe(before.decided_at);
      expect(after.decided_by).toEqual(before.decided_by);
      expect(after.decision_revision).toBeGreaterThan(before.decision_revision!);
      const entry = createWorkInventoryEntry({
        title: 'stale',
        scope: { tenant_slug: TENANT },
        trigger: { kind: 'ad_hoc', description: 'test' },
      });
      decomposition.resolve({ entry, warnings: [], source: 'heuristic' });
      await pending;
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({ hearing_conflict: 'stale_snapshot' });
      expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
      expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('handoff_pending');
    }
  );

  it('accepts the same displayed decision after canvas-only metadata advances', async () => {
    const session = 'canvas-only-' + randomUUID();
    seed(session, 'work_inventory', true);
    const viewedRequest = viewedHandoffRequest(session);
    updateHearingRecord(TENANT, session, (current) => ({
      ...current!,
      canvas_generation: 'generated',
      updated_at: '2026-10-18T00:00:00Z',
    }));
    const entry = createWorkInventoryEntry({
      title: 'current',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    vi.mocked(proposeWorkDecomposition).mockResolvedValue({
      entry,
      warnings: [],
      source: 'heuristic',
    });
    const result = response();
    await inventory(viewedRequest, result);
    expect(result.statusCode).toBe(200);
    expect(saveWorkInventoryEntry).toHaveBeenCalledTimes(1);
  });

  it('discards stale model canvas even when both answers have identical timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const session = 'same-time-' + randomUUID();
    const generated = deferred<Awaited<ReturnType<typeof generateHearingCanvas>>>();
    vi.mocked(generateHearingCanvas).mockReturnValueOnce(generated.promise);
    const first = response();
    await answer(request(session, { text: 'first' }), first);
    const second = response();
    await answer(request(session, { text: 'second' }), second);
    expect((first.body as { record: HearingRecord }).record.updated_at).toBe(
      (second.body as { record: HearingRecord }).record.updated_at
    );
    generated.resolve({
      source: 'generated',
      html: '<html><head></head><body>stale</body></html>',
    });
    await flush();
    await flush();
    expect(loadHearingRecord(TENANT, session)?.canvas_versions).toEqual(['v1', 'v2']);
  });
  it.each(['web_app_build', 'legacy_inline'])(
    'preserves the ordinary %s answer, decide, and reload flow',
    async (scenarioId) => {
      const session = 'ordinary-' + randomUUID();
      const scenario =
        scenarioId === 'legacy_inline'
          ? {
              id: scenarioId,
              requirements: [{ id: 'audience', label_key: 'front_desk:hearing_req_audience' }],
            }
          : findHearingScenario(scenarioId)!;
      for (let index = 0; index < scenario.requirements.length; index++) {
        const res = response();
        await answer(
          request(session, {
            text: 'answer ' + index,
            ...(scenarioId === 'legacy_inline' ? { scenario } : {}),
          }),
          res
        );
        expect(res.statusCode).toBe(200);
        await flush();
      }
      const decided = response();
      await decide(request(session), decided);
      expect(decided.statusCode).toBe(200);
      const reload = response();
      await handlers.get('GET /api/hearing/:session')!(request(session), reload);
      const body = reload.body as { record: HearingRecord; persisted: boolean };
      expect(body.persisted).toBe(true);
      expect(body.record.scenario).toBe(scenarioId);
      expect(body.record.decided_by?.id).toBe('user:current-decider');
      expect(body.record.requirements.every((requirement) => requirement.answer)).toBe(true);
    }
  );

  it('preserves the human decision for an unchanged answer', async () => {
    const session = 'unchanged-' + randomUUID();
    seed(session, 'work_inventory', true);
    await answer(request(session, edit('answer 0')), response());
    expect(loadHearingRecord(TENANT, session)?.decided_by?.id).toBe('user:original');
  });

  it('keeps completion unavailable and hides raw markers belonging to another scope', async () => {
    const session = 'foreign-' + randomUUID();
    const record = seed(session, 'work_inventory', true);
    saveHearingRecord(TENANT, {
      ...record,
      work_inventory_entry_id: 'foreign-entry',
      work_inventory_scope: { tenant_slug: 'foreign-tenant' },
      work_inventory_steps: 1,
    } as HearingRecord);
    const res = response();
    await handlers.get('GET /api/hearing/:session')!(request(session), res);
    const body = res.body as { completion: unknown; record: HearingRecord };
    expect(body.completion).toEqual({ kind: 'inventory', status: 'unavailable' });
    expect(body.record).not.toHaveProperty('work_inventory_entry_id');
    expect(body.record).not.toHaveProperty('work_inventory_scope');
    expect(loadWorkInventoryEntry).not.toHaveBeenCalled();
  });

  it('preserves a completed handoff rather than changing its answered requirements', async () => {
    const session = 'completed-' + randomUUID();
    const record = seed(session, 'work_inventory', true);
    saveHearingRecord(TENANT, {
      ...record,
      work_inventory_entry_id: 'completed-entry',
      work_inventory_scope: { tenant_slug: TENANT },
      work_inventory_steps: 1,
    } as HearingRecord);
    const res = response();
    await answer(request(session, edit('attempted later edit')), res);
    expect(res.statusCode).toBe(409);
    expect(loadHearingRecord(TENANT, session)?.requirements[0].answer).toBe('answer 0');
    expect(loadHearingRecord(TENANT, session)).toHaveProperty(
      'work_inventory_entry_id',
      'completed-entry'
    );
  });

  it('does not restore an older decision when decomposition finishes after a new decision', async () => {
    const session = 'inventory-decision-' + randomUUID();
    seed(session, 'work_inventory', true);
    const decomposition = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
    vi.mocked(proposeWorkDecomposition).mockReturnValueOnce(decomposition.promise);
    const result = response();
    const pending = inventory(viewedHandoffRequest(session), result);
    const decision = response();
    await decide(request(session), decision);
    expect(decision.statusCode).toBe(200);
    const entry = createWorkInventoryEntry({
      title: 'stale',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    decomposition.resolve({ entry, warnings: [], source: 'heuristic' });
    await pending;
    expect(result.statusCode).toBe(409);
    expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
    expect(loadHearingRecord(TENANT, session)?.decided_by?.id).toBe('user:current-decider');
  });

  it.each(['removed', 'remapped'] as const)(
    'rejects an actor %s during inventory preparation before reservation',
    async (mode) => {
      const session = 'changed-actor-' + randomUUID();
      seed(session, 'work_inventory', true);
      const viewedRequest = viewedHandoffRequest(session);
      const originalMember = resolveMemberByPrincipal({ principalId: 'test', source: 'loopback' })!;
      const decomposition = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
      vi.mocked(proposeWorkDecomposition).mockReturnValueOnce(decomposition.promise);
      const result = response();
      const pending = inventory(viewedRequest, result);
      expect(proposeWorkDecomposition).toHaveBeenCalledTimes(1);
      vi.mocked(resolveMemberByPrincipal).mockReturnValue(
        mode === 'removed' ? null : { ...originalMember, member_id: 'remapped-member' }
      );
      const entry = createWorkInventoryEntry({
        title: 'uncommitted',
        scope: { tenant_slug: TENANT },
        trigger: { kind: 'ad_hoc', description: 'test' },
      });
      decomposition.resolve({ entry, warnings: [], source: 'heuristic' });
      await pending;
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({ hearing_conflict: 'stale_snapshot' });
      expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
      expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('handoff_pending');
      expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('work_inventory_entry_id');
    }
  );

  it('does not hold the write lock during a pending decomposition for another session', async () => {
    const session = 'inventory-parallel-' + randomUUID();
    seed(session, 'work_inventory', true);
    const decomposition = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
    vi.mocked(proposeWorkDecomposition).mockReturnValueOnce(decomposition.promise);
    const pending = inventory(viewedHandoffRequest(session), response());
    const other = 'parallel-' + randomUUID();
    const answerResult = response();
    await answer(request(other, { text: 'independent answer' }), answerResult);
    expect(answerResult.statusCode).toBe(200);
    expect(loadHearingRecord(TENANT, other)?.requirements[0].answer).toBe('independent answer');
    const entry = createWorkInventoryEntry({
      title: 'current',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    decomposition.resolve({ entry, warnings: [], source: 'heuristic' });
    await pending;
  });
  it('rejects direct stale snapshot saves even when the timestamp did not change', () => {
    const session = 'cas-' + randomUUID();
    seed(session);
    const oldSnapshot = loadHearingRecord(TENANT, session)!;
    saveHearingRecord(TENANT, {
      ...oldSnapshot,
      decided_by: { kind: 'human', id: 'user:newest', role: 'owner' },
      decided_at: NOW,
    });
    expect(() => saveHearingRecord(TENANT, oldSnapshot)).toThrow();
    const stored = loadHearingRecord(TENANT, session)!;
    expect(stored.updated_at).toBe(oldSnapshot.updated_at);
    expect(stored.decided_by?.id).toBe('user:newest');
  });

  it('reconstructs a completed same-scope inventory after reload without exposing stored markers', async () => {
    const session = 'completion-' + randomUUID();
    seed(session, 'work_inventory', true);
    const entry = createWorkInventoryEntry({
      title: 'confirmed',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    vi.mocked(proposeWorkDecomposition).mockResolvedValue({
      entry,
      warnings: [],
      source: 'heuristic',
    });
    vi.mocked(loadWorkInventoryEntry).mockReturnValue({ ...entry, status: 'confirmed' });
    const first = response();
    await inventory(viewedHandoffRequest(session), first);
    expect(first.statusCode).toBe(200);
    const repeat = response();
    await inventory(viewedHandoffRequest(session), repeat);
    expect(repeat.statusCode).toBe(200);
    expect(proposeWorkDecomposition).toHaveBeenCalledTimes(1);
    expect(saveWorkInventoryEntry).toHaveBeenCalledTimes(1);
    const reload = response();
    await handlers.get('GET /api/hearing/:session')!(request(session), reload);
    const body = reload.body as {
      record: HearingRecord;
      completion: { kind: string; status: string; id: string };
    };
    expect(body.completion).toMatchObject({
      kind: 'inventory',
      status: 'ready',
      id: entry.entry_id,
    });
    expect(body.record).not.toHaveProperty('work_inventory_entry_id');
    expect(body.record).not.toHaveProperty('work_inventory_scope');
  });
  it('upgrades an existing revisionless hearing without retaining its stale decision', async () => {
    const session = 'legacy-record-' + randomUUID();
    const legacy = seed(session, 'work_inventory', true);
    safeRmSync(
      pathResolver.rootResolve(
        'active/shared/runtime/hearing/confidential/' + TENANT + '/' + TENANT + '/' + session
      ),
      { recursive: true, force: true }
    );
    delete legacy.record_revision;
    delete legacy.requirements_revision;
    // Deliberate old-format fixture, using the governed I/O boundary.
    safeWriteFile(
      pathResolver.sharedTmp('hearing/' + TENANT + '/' + session + '.json'),
      JSON.stringify(legacy)
    );
    expect(loadHearingRecord(TENANT, session)?.record_revision).toBeUndefined();
    const res = response();
    await answer(request(session, edit('revised legacy answer')), res);
    expect(res.statusCode).toBe(200);
    const stored = loadHearingRecord(TENANT, session)!;
    expect(stored.requirements[0].answer).toBe('revised legacy answer');
    expect(stored.decided_by).toBeUndefined();
    expect(stored.decided_at).toBeUndefined();
    expect(stored.record_revision).toBeGreaterThan(0);
    expect(stored.requirements_revision).toBeGreaterThan(0);
  });
  it.each([-1, '1', 1.5, null])(
    'fails closed on malformed persisted revision %s',
    async (revision) => {
      const session = 'bad-revision-' + randomUUID();
      const record = seed(session, 'work_inventory', true);
      safeWriteFile(
        pathResolver.rootResolve(
          'active/shared/runtime/hearing/confidential/' +
            TENANT +
            '/' +
            TENANT +
            '/' +
            session +
            '/' +
            session +
            '.json'
        ),
        JSON.stringify({ ...record, record_revision: revision })
      );
      expect(() => loadHearingRecord(TENANT, session)).toThrow('HEARING_REVISION_INVALID');
      const res = response();
      await answer(request(session, edit('must not overwrite malformed state')), res);
      expect(res.statusCode).toBe(500);
      expect(() => loadHearingRecord(TENANT, session)).toThrow('HEARING_REVISION_INVALID');
    }
  );
  it.each([-1, '1', 1.5, null, 99])(
    'fails closed on invalid persisted decision revision %s',
    (revision) => {
      const session = 'bad-decision-revision-' + randomUUID();
      const record = seed(session, 'work_inventory', true);
      safeWriteFile(
        pathResolver.rootResolve(
          'active/shared/runtime/hearing/confidential/' +
            TENANT +
            '/' +
            TENANT +
            '/' +
            session +
            '/' +
            session +
            '.json'
        ),
        JSON.stringify({ ...record, decision_revision: revision })
      );
      expect(() => loadHearingRecord(TENANT, session)).toThrow(
        /HEARING_(?:REVISION|RECORD)_INVALID/u
      );
      expect(proposeWorkDecomposition).not.toHaveBeenCalled();
    }
  );

  it('does not create an inventory entry when reservation persistence fails', async () => {
    const session = 'reserve-failure-' + randomUUID();
    seed(session, 'work_inventory', true);
    const entry = createWorkInventoryEntry({
      title: 'not-created',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    vi.mocked(proposeWorkDecomposition).mockResolvedValue({
      entry,
      warnings: [],
      source: 'heuristic',
    });
    writeFault.session = session;
    writeFault.phase = 'reserve';
    const res = response();
    await inventory(viewedHandoffRequest(session), res);
    expect(res.statusCode).toBe(500);
    expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
    expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('handoff_pending');
    expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('work_inventory_entry_id');
  });

  it('keeps an uncertain post-effect handoff unavailable, hides its token, and blocks repeat effects', async () => {
    const session = 'finish-failure-' + randomUUID();
    seed(session, 'work_inventory', true);
    const entry = createWorkInventoryEntry({
      title: 'created-before-failure',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    vi.mocked(proposeWorkDecomposition).mockResolvedValue({
      entry,
      warnings: [],
      source: 'heuristic',
    });
    writeFault.session = session;
    writeFault.phase = 'finish';
    const first = response();
    await inventory(viewedHandoffRequest(session), first);
    expect(first.statusCode).toBe(409);
    expect(saveWorkInventoryEntry).toHaveBeenCalledTimes(1);
    const stored = loadHearingRecord(TENANT, session)!;
    expect(stored.handoff_pending?.kind).toBe('inventory');
    const token = stored.handoff_pending!.token;
    const reload = response();
    await handlers.get('GET /api/hearing/:session')!(request(session), reload);
    expect((reload.body as { completion: unknown }).completion).toEqual({
      kind: 'inventory',
      status: 'unavailable',
    });
    expect((reload.body as { record: HearingRecord }).record).not.toHaveProperty('handoff_pending');
    expect(JSON.stringify(reload.body)).not.toContain(token);
    const repeat = response();
    await inventory(viewedHandoffRequest(session), repeat);
    expect(repeat.statusCode).toBe(409);
    const edited = response();
    await answer(request(session, edit('must remain frozen')), edited);
    expect(edited.statusCode).toBe(409);
    const decided = response();
    await decide(request(session), decided);
    expect(decided.statusCode).toBe(409);
    for (const result of [first, repeat, edited, decided])
      expect(JSON.stringify(result.body)).not.toContain(token);
    expect(saveWorkInventoryEntry).toHaveBeenCalledTimes(1);
    expect(proposeWorkDecomposition).toHaveBeenCalledTimes(1);
    expect(loadHearingRecord(TENANT, session)?.requirements[0].answer).toBe('answer 0');
  });

  it('allows only one inventory effect when two decompositions finish for the same snapshot', async () => {
    const session = 'double-inventory-' + randomUUID();
    seed(session, 'work_inventory', true);
    const a = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
    const b = deferred<Awaited<ReturnType<typeof proposeWorkDecomposition>>>();
    vi.mocked(proposeWorkDecomposition)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const first = response();
    const second = response();
    const firstPending = inventory(viewedHandoffRequest(session), first);
    const secondPending = inventory(viewedHandoffRequest(session), second);
    expect(proposeWorkDecomposition).toHaveBeenCalledTimes(2);
    const entry = createWorkInventoryEntry({
      title: 'one-effect',
      scope: { tenant_slug: TENANT },
      trigger: { kind: 'ad_hoc', description: 'test' },
    });
    a.resolve({ entry, warnings: [], source: 'heuristic' });
    await firstPending;
    b.resolve({ entry, warnings: [], source: 'heuristic' });
    await secondPending;
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(saveWorkInventoryEntry).toHaveBeenCalledTimes(1);
    expect(loadHearingRecord(TENANT, session)).toHaveProperty(
      'work_inventory_entry_id',
      entry.entry_id
    );
    expect(loadHearingRecord(TENANT, session)).not.toHaveProperty('handoff_pending');
  });
  it.each(['pending', 'mixed'] as const)(
    'rejects completed inventory replay with %s markers',
    async (mode) => {
      const session = 'replay-' + randomUUID();
      const record = seed(session, 'work_inventory', true);
      const replayRecord: HearingRecord & {
        work_inventory_entry_id: string;
        work_inventory_scope: { tenant_slug: string };
        work_inventory_steps: number;
      } = {
        ...record,
        work_inventory_entry_id: 'previous-entry',
        work_inventory_scope: { tenant_slug: TENANT },
        work_inventory_steps: 0,
        ...(mode === 'pending'
          ? {
              handoff_pending: {
                token: 'private-reservation-token',
                kind: 'inventory',
                requirements_revision: record.requirements_revision!,
                started_at: NOW,
              },
            }
          : { mission_id: 'MSN-OTHER-HANDOFF' }),
      };
      saveHearingRecord(TENANT, replayRecord);
      const res = response();
      await inventory(viewedHandoffRequest(session), res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({
        hearing_conflict: mode === 'pending' ? 'handoff_unresolved' : 'completion_locked',
      });
      expect(proposeWorkDecomposition).not.toHaveBeenCalled();
      expect(saveWorkInventoryEntry).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain('previous-entry');
      expect(JSON.stringify(res.body)).not.toContain('private-reservation-token');
      expect(JSON.stringify(res.body)).not.toContain('MSN-OTHER-HANDOFF');
    }
  );

  it('locks answer and decide even when the only completion marker is zero steps', async () => {
    const session = 'partial-marker-' + randomUUID();
    const record = seed(session, 'work_inventory', true);
    saveHearingRecord(TENANT, { ...record, work_inventory_steps: 0 } as HearingRecord);
    for (const [handler, body] of [
      [answer, edit('must not mutate')],
      [decide, {}],
    ] as const) {
      const res = response();
      await handler(request(session, body), res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ hearing_conflict: 'completion_locked' });
    }
    const stored = loadHearingRecord(TENANT, session)!;
    expect(stored.requirements[0].answer).toBe('answer 0');
    expect(stored.decided_by?.id).toBe('user:original');
    expect(stored).toHaveProperty('work_inventory_steps', 0);
  });
});
