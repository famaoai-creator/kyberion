import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARING_TENANT,
  OTHER_TENANT,
  call,
  hr,
  sessionId,
  setUpHearing,
  storedHearing,
  tearDownHearing,
} from '../../../../test/hearing-route-harness';

// The /api/hearing/* routes on a real installation under SYSTEM_ROLE=concierge
// (test/hearing-route-harness.ts): the installation owner and a second member
// of the same tenant, both signed in with a real browser session. The step
// assertions are presence-studio's (hearing-routes, hearing-mission-routes,
// hearing-ledger-routes, hearing-decision-receipt-routes tests) — same body,
// status and error codes; the authority assertions are Concierge's own.
// Narrow fault seams only, off unless a case turns them on: Concierge's own
// refusals (rate limit, the shared write guard).
const fault = vi.hoisted(() => ({
  viewer: null as null | (() => Response),
  guard: null as null | (() => Response | null),
}));
vi.mock('../../../lib/viewer-context', async (original) => {
  const actual = await original<typeof import('../../../lib/viewer-context')>();
  return {
    ...actual,
    resolveConciergeViewer: (req: Parameters<typeof actual.resolveConciergeViewer>[0]) =>
      fault.viewer ? { response: fault.viewer() } : actual.resolveConciergeViewer(req),
  };
});
vi.mock('../../../lib/api-guard', async (original) => {
  const actual = await original<typeof import('../../../lib/api-guard')>();
  return {
    ...actual,
    requireConciergeMutationAccess: (
      req: Parameters<typeof actual.requireConciergeMutationAccess>[0]
    ) => (fault.guard ? fault.guard() : actual.requireConciergeMutationAccess(req)),
  };
});

// The model canvas call is observed (never replaced) to prove a ledger hearing
// never reaches it (SD-05).
vi.mock('@agent/core/surface/hearing-canvas', async (original) => {
  const actual = await original<typeof import('@agent/core/surface/hearing-canvas')>();
  return { ...actual, generateHearingCanvas: vi.fn(actual.generateHearingCanvas) };
});
import { generateHearingCanvas } from '@agent/core/surface/hearing-canvas';
// The installation write audit is observed (never replaced): a write that ends
// in the ledger refusal does nothing and is not recorded as admitted. Captured
// lazily (no static import), so the module loads inside the temporary root.
const audit = vi.hoisted(() => ({
  calls: [] as Array<{ allowed: boolean; operation: string }>,
}));
vi.mock('../../../lib/installation-access', async (original) => {
  const actual = await original<typeof import('../../../lib/installation-access')>();
  return {
    ...actual,
    auditConciergeInstallationWrite: (
      ...args: Parameters<typeof actual.auditConciergeInstallationWrite>
    ) => {
      audit.calls.push({ allowed: args[0].allowed === true, operation: args[1] });
      return actual.auditConciergeInstallationWrite(...args);
    },
  };
});
import { createHearingRecord } from '@agent/core/surface/hearing';

beforeAll(() => setUpHearing(), 120_000);
afterAll(() => tearDownHearing());
beforeEach(() => {
  Object.assign(fault, { viewer: null, guard: null });
});

const scoped = (id: string, suffix = '', query = '') =>
  `/api/hearing/${id}${suffix}?tenant=${HEARING_TENANT}${query}`;

async function answer(id: string, text: string, extra: Record<string, unknown> = {}) {
  return call(
    'answer',
    'POST',
    scoped(id, '/answer'),
    { session: id },
    {
      body: { text, ...extra },
    }
  );
}

describe('concierge /api/hearing (頼む › ヒアリング)', { timeout: 120_000 }, () => {
  it('runs inside the temporary root under the Concierge process role', () => {
    expect(process.env.SYSTEM_ROLE).toBe('concierge');
    expect(process.env.KYBERION_ROOT).toBe(hr.root);
  });

  describe('steps (Studio parity)', () => {
    it('returns an unpersisted default record with its canvas url and first question', async () => {
      const id = sessionId();
      const res = await call('record', 'GET', scoped(id), { session: id });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body).toMatchObject({ ok: true, persisted: false });
      const record = res.body.record as { session_id: string; is_ledger: boolean };
      expect(record.session_id).toBe(id);
      expect(record.is_ledger).toBe(false);
      expect(res.body.canvas_url).toBe(
        `/api/hearing/${id}/canvas?scenario_id=web_app_build&locale=en&tenant=${HEARING_TENANT}`
      );
      expect(res.body.next_question).toMatchObject({ id: expect.any(String) });
      expect(typeof res.body.prompt).toBe('string');
      expect(res.body.completion).toBeUndefined();
    });

    it('records an answer as the owner, persists it and serves the versioned canvas', async () => {
      const id = sessionId();
      const res = await answer(id, 'goal: a booking page for the clinic');
      expect(res.status, res.text).toBe(200);
      const record = res.body.record as {
        canvas_versions: string[];
        canvas_generation: string;
      };
      expect(res.body.ok).toBe(true);
      expect(record.canvas_versions).toEqual(['v1']);
      expect(record.canvas_generation).toBe('pending');
      expect(res.body.canvas_url).toBe(
        `/api/hearing/${id}/canvas?scenario_id=web_app_build&version=v1&locale=en&tenant=${HEARING_TENANT}`
      );
      const stored = storedHearing(HEARING_TENANT, id);
      expect(stored?.session_id).toBe(id);
      const again = await call('record', 'GET', scoped(id), { session: id });
      expect(again.body.persisted).toBe(true);
      const canvas = await call('canvas', 'GET', scoped(id, '/canvas', '&version=v1'), {
        session: id,
      });
      expect(canvas.status).toBe(200);
      expect(canvas.headers.get('content-type')).toContain('text/html');
      expect(canvas.headers.get('content-security-policy')).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
      );
      expect(canvas.text).toContain('<');
    });

    it('refuses an unknown canvas version, an invalid session id and an unknown scenario with 400', async () => {
      const id = sessionId();
      const version = await call('canvas', 'GET', scoped(id, '/canvas', '&version=v9'), {
        session: id,
      });
      expect(version.status).toBe(400);
      expect(version.body).toMatchObject({ ok: false, error_code: expect.any(String) });
      const invalid = await call('record', 'GET', scoped('..bad'), { session: '..bad' });
      expect(invalid.status).toBe(400);
      const unknown = await answer(sessionId(), 'goal: x', { scenario_id: 'no-such-scenario' });
      expect(unknown.status).toBe(400);
      const empty = await answer(sessionId(), '   ');
      expect(empty.status).toBe(400);
    });

    it('creates the record from the catalog entry when scenario_id is given (work inventory canvas is final)', async () => {
      const id = sessionId();
      const res = await answer(id, 'The weekly report takes two hours', {
        scenario_id: 'work_inventory',
      });
      expect(res.status).toBe(200);
      const record = res.body.record as { scenario: string; canvas_generation: string };
      expect(record.scenario).toBe('work_inventory');
      expect(record.canvas_generation).toBe('template');
    });

    it('refuses a decision before the record exists, and one with unanswered requirements', async () => {
      const id = sessionId();
      const missing = await call(
        'decide',
        'POST',
        scoped(id, '/decide'),
        { session: id },
        {
          body: {},
        }
      );
      expect(missing.status).toBe(400);
      expect(missing.body.ok).toBe(false);
      await answer(id, 'goal: a partial answer');
      const partial = await call(
        'decide',
        'POST',
        scoped(id, '/decide'),
        { session: id },
        {
          body: {},
        }
      );
      expect(partial.status).toBe(400);
    });

    it('requires an exact requirements revision for a decision receipt', async () => {
      const id = sessionId();
      const noRevision = await call('receipt', 'GET', scoped(id, '/decision-receipts/op-1'), {
        session: id,
        operation: 'op-1',
      });
      expect(noRevision.status).toBe(400);
    });

    it('refuses the inventory hand-off for a scenario that is not a work inventory', async () => {
      const id = sessionId();
      await answer(id, 'goal: not an inventory');
      const res = await call(
        'inventory',
        'POST',
        scoped(id, '/inventory'),
        { session: id },
        {
          body: {},
        }
      );
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('refuses the mission hand-off before the record exists (409) and for a work inventory scenario (400)', async () => {
      const id = sessionId();
      const missing = await call(
        'handoff',
        'POST',
        scoped(id, '/handoff'),
        { session: id },
        {
          body: {},
        }
      );
      expect(missing.status).toBe(409);
      const inventory = sessionId();
      await answer(inventory, 'The weekly report', { scenario_id: 'work_inventory' });
      const wrong = await call(
        'handoff',
        'POST',
        scoped(inventory, '/handoff'),
        { session: inventory },
        { body: {} }
      );
      expect(wrong.status).toBe(400);
    });

    it('does not serve decision-ledger hearings: the concierge role may not read the ledger (CD-12)', async () => {
      // role-assumption-policy.json grants decision_ledger to customer_decision_reader
      // and presence_studio, not to concierge: refused with a code, never widened.
      for (const query of [`&case=case-a&actor=product`, '&case=..']) {
        const agenda = await call(
          'agenda',
          'GET',
          `/api/hearing/decisions/agenda?tenant=${HEARING_TENANT}${query}`,
          {}
        );
        expect(agenda.status).toBe(503);
        expect(agenda.body).toEqual({
          ok: false,
          error: 'hearing_ledger_unavailable',
          error_code: 'hearing_ledger_unavailable',
        });
      }
      const id = sessionId();
      for (const extra of [
        { scenario_ref: 'decisions-case-a-product' },
        { scenario_id: 'decisions-case-a-product' },
      ]) {
        const ref = await answer(id, 'value', extra);
        expect(ref.status, JSON.stringify(extra)).toBe(extra.scenario_ref ? 503 : 200);
      }
      // A ledger scenario id in a read is refused before any ledger is read
      // (Studio resolves it from the ledger, also for a persisted record).
      for (const target of [id, sessionId()]) {
        const read = await call(
          'record',
          'GET',
          scoped(target, '', '&scenario_id=decisions-case-a-product'),
          { session: target }
        );
        expect(read.status).toBe(503);
        expect(read.body).toMatchObject({ ok: false, error_code: 'hearing_ledger_unavailable' });
      }
      const recorded = await call(
        'recordDecisions',
        'POST',
        scoped(id, '/record-decisions'),
        { session: id },
        { body: { case: 'case-a' } }
      );
      expect(recorded.status).toBe(503);
      expect(recorded.body.error_code).toBe('hearing_ledger_unavailable');
      // The gate still runs first: a member who is not the owner is refused as on every write.
      const member = await call(
        'recordDecisions',
        'POST',
        scoped(id, '/record-decisions'),
        { session: id },
        { token: hr.memberToken, body: { case: 'case-a' } }
      );
      expect(member.status).toBe(403);
    });
  });

  describe('stored decision-ledger hearings (no ledger on Concierge)', () => {
    it('refuses every step that loads the record, before any effect or model call', async () => {
      const id = sessionId();
      const scenario = 'decisions-case-a-product';
      const record = createHearingRecord(id, '2026-11-08T00:00:00.000Z', {
        id: scenario,
        requirements: [
          {
            id: 'DEC-1',
            label_key: 'front_desk:hearing_req_problem',
            label_source: 'tenant',
            label_text: 'Secret tenant decision label',
          },
        ],
      });
      hr.authority.withExecutionContext(
        'ecosystem_architect',
        () => hr.runtime.saveHearingRecord(HEARING_TENANT, record),
        undefined,
        HEARING_TENANT
      );
      const before = JSON.stringify(storedHearing(HEARING_TENANT, id));
      vi.mocked(generateHearingCanvas).mockClear();
      audit.calls.length = 0;
      const cases = [
        ['record', 'GET', scoped(id), {}],
        ['canvas', 'GET', scoped(id, '/canvas'), {}],
        ['answer', 'POST', scoped(id, '/answer'), { body: { text: 'goal: a new answer' } }],
        ['decide', 'POST', scoped(id, '/decide'), { body: {} }],
        [
          'decide',
          'POST',
          scoped(id, '/decide'),
          {
            body: {
              version: 1,
              operation_id: 'op-ledger',
              scenario_id: scenario,
              requirements_revision: 0,
            },
          },
        ],
        [
          'receipt',
          'GET',
          scoped(
            id,
            '/decision-receipts/op-ledger',
            `&requirements_revision=0&version=1&scenario_id=${scenario}`
          ),
          {},
        ],
        ['inventory', 'POST', scoped(id, '/inventory'), { body: {} }],
        ['handoff', 'POST', scoped(id, '/handoff'), { body: {} }],
      ] as const;
      for (const [route, method, target, options] of cases) {
        const res = await call(
          route,
          method,
          target,
          { session: id, operation: 'op-ledger' },
          {
            ...options,
          }
        );
        expect(res.status, `${route} ${target}`).toBe(503);
        expect(res.body, route).toEqual({
          ok: false,
          error: 'hearing_ledger_unavailable',
          error_code: 'hearing_ledger_unavailable',
        });
        expect(res.text).not.toContain('Secret tenant decision label');
      }
      expect(JSON.stringify(storedHearing(HEARING_TENANT, id))).toBe(before);
      // Every way a scenario can arrive with a new hearing: the legacy inline
      // object too (scenario_ref / scenario_id are covered above).
      const fresh = sessionId();
      const inline = await call(
        'answer',
        'POST',
        scoped(fresh, '/answer'),
        { session: fresh },
        {
          body: {
            text: 'goal: inline ledger scenario',
            scenario: {
              id: scenario,
              requirements: [
                {
                  id: 'DEC-1',
                  label_key: 'front_desk:hearing_req_problem',
                  label_source: 'tenant',
                  label_text: 'Secret tenant decision label',
                },
              ],
            },
          },
        }
      );
      expect(inline.status).toBe(503);
      expect(inline.body).toEqual({
        ok: false,
        error: 'hearing_ledger_unavailable',
        error_code: 'hearing_ledger_unavailable',
      });
      expect(storedHearing(HEARING_TENANT, fresh)).toBeNull();
      expect(generateHearingCanvas).not.toHaveBeenCalled();
      // None of these writes did anything, so none was audited as admitted.
      expect(audit.calls.filter((call) => call.allowed)).toEqual([]);
      // A normal hearing still reaches the model follow-up (the spy is live).
      await answer(sessionId(), 'goal: an ordinary hearing');
      expect(generateHearingCanvas).toHaveBeenCalledTimes(1);
      // An ordinary write is audited as admitted before its effect.
      expect(audit.calls.filter((call) => call.allowed)).toEqual([
        { allowed: true, operation: 'hearing.answer' },
      ]);
    });
  });

  describe('authority (Concierge rules)', () => {
    it('refuses an anonymous remote request with 401 before anything else', async () => {
      const id = sessionId();
      for (const [route, method, suffix] of [
        ['record', 'GET', ''],
        ['canvas', 'GET', '/canvas'],
        ['answer', 'POST', '/answer'],
        ['agenda', 'GET', ''],
      ] as const) {
        const target = route === 'agenda' ? '/api/hearing/decisions/agenda' : scoped(id, suffix);
        const res = await call(
          route,
          method,
          target,
          { session: id },
          {
            peer: false,
            token: null,
            body: { text: 'goal: never' },
          }
        );
        expect(res.status, route).toBe(401);
      }
      expect(storedHearing(HEARING_TENANT, id)).toBeNull();
    });

    it('lets a signed-in member who is not the owner read a tenant hearing, never write it', async () => {
      const id = sessionId();
      await answer(id, 'goal: the owner wrote this');
      const read = await call(
        'record',
        'GET',
        scoped(id),
        { session: id },
        {
          token: hr.memberToken,
        }
      );
      expect(read.status).toBe(200);
      expect(read.body.persisted).toBe(true);
      const before = JSON.stringify(storedHearing(HEARING_TENANT, id));
      for (const [route, suffix] of [
        ['answer', '/answer'],
        ['decide', '/decide'],
        ['inventory', '/inventory'],
        ['handoff', '/handoff'],
      ] as const) {
        const res = await call(
          route,
          'POST',
          scoped(id, suffix),
          { session: id },
          {
            token: hr.memberToken,
            body: { text: 'goal: overwritten' },
          }
        );
        expect(res.status, route).toBe(403);
        expect(res.body, route).toMatchObject({ ok: false, error_code: expect.any(String) });
      }
      // Decision receipts are the owner's (Studio: local admin only).
      const receipt = await call(
        'receipt',
        'GET',
        scoped(id, '/decision-receipts/op-1', '&requirements_revision=1&version=1'),
        { session: id, operation: 'op-1' },
        { token: hr.memberToken }
      );
      expect(receipt.status).toBe(403);
      expect(JSON.stringify(storedHearing(HEARING_TENANT, id))).toBe(before);
    });

    it('refuses a cross-origin or origin-less write before any effect', async () => {
      const id = sessionId();
      for (const origin of ['https://evil.example', null]) {
        const res = await call(
          'answer',
          'POST',
          scoped(id, '/answer'),
          { session: id },
          {
            origin,
            body: { text: 'goal: forged' },
          }
        );
        expect(res.status, String(origin)).toBe(403);
      }
      const forged = await call(
        'answer',
        'POST',
        scoped(id, '/answer'),
        { session: id },
        {
          origin: 'https://evil.example',
          body: { text: 'goal: forged' },
        }
      );
      expect(forged.body).toMatchObject({ error_code: 'hearing_origin_denied' });
      expect(storedHearing(HEARING_TENANT, id)).toBeNull();
    });

    it('lets a client tenant only narrow: outside the viewer, reserved or repeated values are refused', async () => {
      const id = sessionId();
      for (const query of [
        `?tenant=${OTHER_TENANT}`,
        '?tenant=all',
        '?tenant=unscoped',
        `?tenant=${HEARING_TENANT}&tenant=${OTHER_TENANT}`,
      ]) {
        const read = await call('record', 'GET', `/api/hearing/${id}${query}`, { session: id });
        expect(read.status, query).toBe(403);
        expect(read.body).not.toHaveProperty('record');
        const write = await call(
          'answer',
          'POST',
          `/api/hearing/${id}/answer${query}`,
          {
            session: id,
          },
          { body: { text: 'goal: never' } }
        );
        expect(write.status, query).toBe(403);
      }
      expect(storedHearing(HEARING_TENANT, id)).toBeNull();
      expect(storedHearing(OTHER_TENANT, id)).toBeNull();
    });

    it('keeps a rate-limit refusal with its Retry-After, and the write guard runs last', async () => {
      const id = sessionId();
      fault.viewer = () =>
        new Response(JSON.stringify({ ok: false, error: 'limited' }), {
          status: 429,
          headers: { 'Retry-After': '7' },
        });
      const limited = await call(
        'answer',
        'POST',
        scoped(id, '/answer'),
        { session: id },
        {
          body: { text: 'goal: never' },
        }
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('7');
      fault.viewer = null;
      let guarded = 0;
      fault.guard = () => {
        guarded += 1;
        return new Response(JSON.stringify({ ok: false }), {
          status: 429,
          headers: { 'Retry-After': '9' },
        });
      };
      // A non-owner is refused by the owner check; the guard never runs.
      const member = await call(
        'answer',
        'POST',
        scoped(id, '/answer'),
        { session: id },
        {
          token: hr.memberToken,
          body: { text: 'goal: never' },
        }
      );
      expect(member.status).toBe(403);
      expect(guarded).toBe(0);
      const owner = await call(
        'answer',
        'POST',
        scoped(id, '/answer'),
        { session: id },
        {
          body: { text: 'goal: never' },
        }
      );
      expect(owner.status).toBe(429);
      expect(owner.headers.get('retry-after')).toBe('9');
      expect(guarded).toBe(1);
      expect(storedHearing(HEARING_TENANT, id)).toBeNull();
    });

    it('treats a credential-free loopback request as the owner only with the escape hatch, and still requires same origin', async () => {
      const id = sessionId();
      const closed = await call(
        'answer',
        'POST',
        scoped(id, '/answer'),
        { session: id },
        {
          token: null,
          body: { text: 'goal: anonymous' },
        }
      );
      // Bootstrap is closed (an owner is bound): a credential-free request must sign in.
      expect(closed.status).toBe(401);
      vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '1');
      hr.owner.resetInstallationBootstrapCache();
      try {
        const forged = await call(
          'answer',
          'POST',
          scoped(id, '/answer'),
          { session: id },
          {
            token: null,
            origin: 'https://evil.example',
            body: { text: 'goal: forged' },
          }
        );
        expect(forged.status).toBe(403);
        expect(forged.body).toMatchObject({ error_code: 'hearing_origin_denied' });
        expect(storedHearing(HEARING_TENANT, id)).toBeNull();
        const local = await call(
          'answer',
          'POST',
          scoped(id, '/answer'),
          { session: id },
          {
            token: null,
            body: { text: 'goal: the local operator' },
          }
        );
        expect(local.status).toBe(200);
        // Off the attested peer, the same request is a remote anonymous one.
        const remote = await call(
          'record',
          'GET',
          scoped(id),
          { session: id },
          {
            token: null,
            peer: false,
          }
        );
        expect(remote.status).toBe(401);
      } finally {
        vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '');
        hr.owner.resetInstallationBootstrapCache();
      }
    });

    it('refuses an unparsable body after the gate, before any effect', async () => {
      const id = sessionId();
      const res = await call(
        'decide',
        'POST',
        scoped(id, '/decide'),
        { session: id },
        {
          rawBody: '{not json',
        }
      );
      expect(res.status).toBe(400);
    });
  });
});
