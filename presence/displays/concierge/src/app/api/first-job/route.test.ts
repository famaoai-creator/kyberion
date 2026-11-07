import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIRST_JOB_TENANT,
  ORIGIN,
  SUSPENDED_SUBJECT,
  bindOwner,
  decide,
  fj,
  mint,
  read,
  readApprovals,
  readArtifact,
  sessionId,
  setUpFirstJob,
  start,
  tearDownFirstJob,
  terminate,
  type Options,
} from '../../../../test/first-job-route-harness';

// The /api/first-job* gate on a real installation (test/first-job-route-harness.ts):
// first-run setup open, then the owner bound. The guide scenarios run in
// their own files (route.delivery / route.recovery / route.uncertain), each
// with a fresh root. Narrow fault seams only, off unless a case turns them
// on: Concierge's own refusals (rate limit, the shared write guard, a throw).
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

// First-run setup closes for good once an owner can sign in, so the
// installation starts unbound and the gate block binds the owner.
beforeAll(() => setUpFirstJob({ bound: false }), 120_000);
afterAll(() => tearDownFirstJob());
beforeEach(() => {
  vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '');
  fj.owner.resetInstallationBootstrapCache();
  Object.assign(fault, { viewer: null, guard: null });
});

describe('concierge /api/first-job (初めての仕事)', { timeout: 120_000 }, () => {
  it('runs inside the temporary root under the Concierge process role', () => {
    expect(fj.io.pathResolver.rootDir()).toBe(fj.root);
    expect(process.env.SYSTEM_ROLE).toBe('concierge');
  });

  describe('before an owner is bound (first-run setup open)', () => {
    it('admits the credential-free local operator on reads and writes, as Studio did', async () => {
      const got = await read('', { token: null });
      expect(got.status).toBe(200);
      expect(got.body.readiness).toEqual({ ready: true, status: 'diagnostic_mapping_ready' });
      const started = await start(
        { action: 'start', request_id: randomUUID(), session_id: got.body.sessionId },
        { token: null }
      );
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ ok: true, mode: 'intake' });
      // Still only on this machine.
      expect((await read('', { token: null, peer: false })).status).toBe(403);
    });
  });

  describe('the local-owner gate', () => {
    beforeAll(() => bindOwner());

    it('admits the signed-in installation owner on this machine', async () => {
      const { status, headers, body } = await read();
      expect(status).toBe(200);
      expect(headers.get('cache-control')).toBe('no-store');
      expect(body.readiness).toEqual({ ready: true, status: 'diagnostic_mapping_ready' });
      expect(body.scope).toEqual({ tenant: FIRST_JOB_TENANT, tier: 'public' });
      expect(body.setup).toMatchObject({
        mapping: { status: 'diagnostic_mapping_ready' },
        browser_user: { status: 'verified' },
        approval_scope: { status: 'ready' },
      });
    });

    it('refuses a request without a loopback peer proof, even with the owner session', async () => {
      for (const options of [
        { peer: false },
        { peer: false, headers: { 'x-forwarded-for': '127.0.0.1' } },
      ]) {
        const { status, body } = await read('', options);
        expect(status).toBe(403);
        expect(body).toMatchObject({
          ok: false,
          error: 'first_job_access_denied',
          retry_safe: true,
        });
        expect(body.next_action).toEqual({ kind: 'inspect_setup', href: '/first-job' });
        expect(body.sessionId).toBeUndefined();
      }
    });

    it('refuses a non-loopback Host on reads too (DNS rebinding)', async () => {
      for (const host of ['kyberion.example.com', 'evil.example:3050', 'user@127.0.0.1:3050']) {
        const { status, body } = await read('', { host });
        expect(status).toBe(403);
        expect(body.error).toBe('first_job_access_denied');
      }
    });

    it('binds the diagnostic to the server tenant, never a request field', async () => {
      vi.stubEnv('KYBERION_TENANT', FIRST_JOB_TENANT);
      expect((await read()).body.readiness).toEqual({
        ready: true,
        status: 'diagnostic_mapping_ready',
      });
      vi.stubEnv('KYBERION_TENANT', 'other-tenant');
      try {
        const { status, body } = await read();
        expect(status).toBe(200);
        expect(body.readiness).toEqual({ ready: false, status: 'mapping_mismatch' });
        expect(body.sessionId).toBeUndefined();
      } finally {
        vi.stubEnv('KYBERION_TENANT', '');
      }
    });

    it('refuses a signed-in member who is not the installation owner', async () => {
      const { status, body } = await read('', { token: fj.otherToken });
      expect(status).toBe(403);
      expect(body.error).toBe('first_job_access_denied');
      expect(body.sessionId).toBeUndefined();
    });

    it('refuses a credential-free loopback request once an owner is bound', async () => {
      const { status, body } = await read('', { token: null });
      expect(status).toBe(401);
      expect(body.error).toBe('first_job_access_denied');
    });

    it('admits credential-free loopback only with the anonymous-loopback escape hatch', async () => {
      vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', 'true');
      const { status, body } = await read('', { token: null });
      expect(status).toBe(200);
      expect(body.readiness.ready).toBe(true);
      // No browser session: approvals ask to sign in instead of listing anything.
      expect(body.setup.browser_user.status).toBe('sign_in_required');
    });

    it('refuses a cross-origin POST before any effect', async () => {
      const session = await sessionId();
      const before = (await read()).body.tasks.length;
      for (const options of [
        { origin: null },
        { origin: 'null' },
        { origin: 'http://evil.example' },
        { origin: 'https://127.0.0.1:3050' },
        { origin: ORIGIN, headers: { 'sec-fetch-site': 'cross-site' } },
        { host: 'evil.example', origin: 'http://evil.example' },
      ] as Options[]) {
        const { status, body } = await start(
          { action: 'start', request_id: randomUUID(), session_id: session },
          options
        );
        expect(status).toBe(403);
        expect(body.retry_safe).toBe(true);
        expect(['first_job_origin_denied', 'first_job_access_denied']).toContain(body.error);
      }
      expect((await start({}, { origin: 'http://evil.example' })).body.error).toBe(
        'first_job_origin_denied'
      );
      expect((await read()).body.tasks).toHaveLength(before);
    });

    it('rejects unknown query and body fields as invalid, never as authority', async () => {
      const session = await sessionId();
      const listed = await readApprovals(session + '&locale=en-US');
      expect(listed.status).toBe(200);
      expect(listed.headers.get('cache-control')).toBe('no-store');
      expect((await readApprovals(session + '&locale=zz')).status).toBe(400);
      expect((await readApprovals(session + '&tenant=other')).status).toBe(400);
      expect((await read('?tenant=other')).status).toBe(400);
      expect((await read('?locale=ja&locale=en')).status).toBe(400);
      expect((await read('?locale=zz')).status).toBe(400);
      for (const field of ['tenant', 'memberId', 'principalId', 'token']) {
        const { status, body } = await start({
          action: 'start',
          request_id: randomUUID(),
          session_id: session,
          [field]: 'spoof',
        });
        expect(status).toBe(400);
        expect(body.error).toBe('first_job_invalid_request');
      }
    });
    it("rewrites the viewer's own refusals to the first-job code, never its message", async () => {
      const forged = await read('', {
        token: null,
        headers: { authorization: 'Bearer kys1.forged.fake' },
      });
      expect(forged.status).toBe(401);
      expect(forged.body).toEqual({
        ok: false,
        error: 'first_job_access_denied',
        retry_safe: true,
        next_action: { kind: 'inspect_setup', href: '/first-job' },
      });
      const suspended = await read('', { token: mint(SUSPENDED_SUBJECT) });
      expect(suspended.status).toBe(403);
      expect(suspended.body.error).toBe('first_job_access_denied');
      // A viewer refusal is an access refusal: each route keeps its own retry_safe.
      const ended = await terminate(
        randomUUID(),
        {
          action: 'terminate_unstarted',
          display_digest: 'a'.repeat(64),
          session_id: 'concierge-' + 'b'.repeat(64),
        },
        { token: null, headers: { authorization: 'Bearer kys1.forged.fake' } }
      );
      expect(ended.status).toBe(401);
      expect(ended.body).toMatchObject({ error: 'first_job_access_denied', retry_safe: false });
      for (const answer of [forged, suspended])
        expect(JSON.stringify(answer.body)).not.toMatch(
          /Concierge|token|session|suspended|member/i
        );
    });

    it('refuses when the viewer and the shared logic would read different credentials', async () => {
      // A lowercase `bearer` header beside the owner's session cookie: the
      // viewer reads the cookie, the shared logic the header.
      for (const authorization of ['bearer not-the-owner', 'Bearer\tnot-the-owner']) {
        const { status, body } = await read('', { headers: { authorization } });
        expect(status, authorization).toBe(403);
        expect(body.error).toBe('first_job_access_denied');
        expect(body.sessionId).toBeUndefined();
      }
      // The exact form both parsers read alike is just an unknown credential.
      expect((await read('', { headers: { authorization: 'Bearer not-the-owner' } })).status).toBe(
        401
      );
    });

    it("keeps Studio's own origin check even without the shared write guard", async () => {
      // The shared Concierge guard refuses these too; with it out of the way,
      // the route's own Studio check must still refuse every one.
      fault.guard = () => null;
      const session = await sessionId();
      const before = (await read('?session_id=' + session)).body.tasks.length;
      for (const options of [
        { origin: null },
        { origin: 'null' },
        { origin: 'http://evil.example' },
        { origin: 'https://127.0.0.1:3050' },
        { origin: 'http://localhost:3050' },
        { origin: ORIGIN, headers: { 'sec-fetch-site': 'cross-site' } },
      ] as Options[]) {
        const answer = await start(
          { action: 'start', request_id: randomUUID(), session_id: session },
          options
        );
        expect(answer.status, JSON.stringify(options)).toBe(403);
        expect(answer.body).toMatchObject({ error: 'first_job_origin_denied', retry_safe: true });
      }
      expect((await read('?session_id=' + session)).body.tasks).toHaveLength(before);
    });

    it('checks the owner before the origin on a POST', async () => {
      const { status, body } = await start(
        { action: 'start', request_id: randomUUID() },
        { token: fj.otherToken, origin: 'http://evil.example' }
      );
      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'first_job_access_denied', retry_safe: true });
    });

    it("answers each route's access refusal with its own retry_safe", async () => {
      const digest = 'a'.repeat(64);
      const session = 'concierge-' + 'b'.repeat(64);
      const refused = await decide(
        randomUUID(),
        { decision: 'approved', display_digest: digest, session_id: session },
        { token: fj.otherToken }
      );
      expect(refused.body).toMatchObject({ error: 'first_job_access_denied', retry_safe: true });
      const ended = await terminate(
        randomUUID(),
        { action: 'terminate_unstarted', display_digest: digest, session_id: session },
        { token: fj.otherToken }
      );
      expect(ended.body).toMatchObject({ error: 'first_job_access_denied', retry_safe: false });
    });

    it('refuses a query string on every POST, whatever the body', async () => {
      const session = await sessionId();
      const before = (await read('?session_id=' + session)).body.tasks.length;
      const digest = 'a'.repeat(64);
      const started = await start(
        { action: 'start', request_id: randomUUID(), session_id: session },
        { query: '?x=1' }
      );
      expect(started).toMatchObject({ status: 400, body: { error: 'first_job_invalid_request' } });
      const decided = await decide(
        randomUUID(),
        { decision: 'approved', display_digest: digest, session_id: session },
        { query: '?x=1' }
      );
      expect(decided).toMatchObject({ status: 400, body: { error: 'first_job_invalid_request' } });
      const ended = await terminate(
        randomUUID(),
        { action: 'terminate_unstarted', display_digest: digest, session_id: session },
        { query: '?x=1' }
      );
      expect(ended).toMatchObject({ status: 400, body: { error: 'first_job_invalid_request' } });
      expect((await read('?session_id=' + session)).body.tasks).toHaveLength(before);
    });

    it('refuses an unsupported POST locale, a changed session, malformed JSON and a body over 1 MB', async () => {
      const session = await sessionId();
      const before = (await read('?session_id=' + session)).body.tasks.length;
      expect(
        (
          await start({
            action: 'start',
            request_id: randomUUID(),
            session_id: session,
            locale: 'zz',
          })
        ).status
      ).toBe(400);
      expect(
        await start({
          action: 'start',
          request_id: randomUUID(),
          session_id: 'concierge-' + 'f'.repeat(64),
        })
      ).toMatchObject({
        status: 409,
        body: { error: 'first_job_scope_changed', retry_safe: true },
      });
      expect((await start({}, { rawBody: '{"action":"start",' })).body).toMatchObject({
        error: 'first_job_invalid_request',
        retry_safe: true,
      });
      const huge = JSON.stringify({
        action: 'start',
        request_id: randomUUID(),
        session_id: session,
        locale: 'en'.padEnd(1024 * 1024 + 8, ' '),
      });
      expect((await start({}, { rawBody: huge })).status).toBe(400);
      expect((await read('?session_id=' + session)).body.tasks).toHaveLength(before);
    });

    it('marks every artifact answer nosniff, refusals included (as Studio did)', async () => {
      const selector = `session_id=concierge-${'a'.repeat(64)}&request_id=${randomUUID()}&revision=1&sha256=${'b'.repeat(64)}`;
      for (const [query, options, status] of [
        [selector, { peer: false }, 403],
        [selector + '&path=/etc/passwd', {}, 400],
        [selector, {}, 404],
      ] as Array<[string, Options, number]>) {
        const answer = await readArtifact(query, options);
        expect(answer.status).toBe(status);
        expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
        expect(answer.headers.get('cache-control')).toBe('no-store');
      }
    });

    it("turns Concierge's own refusals into coded, retry-safe first-job answers", async () => {
      const refusal =
        (status: number, headers: Record<string, string> = {}) =>
        () =>
          new Response(
            JSON.stringify({ ok: false, error: 'Concierge rate limit exceeded. Try again later.' }),
            {
              status,
              headers,
            }
          );
      fault.viewer = refusal(429, { 'Retry-After': '7' });
      const limited = await read();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('7');
      expect(limited.body).toMatchObject({ error: 'first_job_rate_limited', retry_safe: true });
      expect(JSON.stringify(limited.body)).not.toContain('Concierge');
      fault.viewer = null;
      const session = await sessionId();
      const before = (await read('?session_id=' + session)).body.tasks.length;
      const body = { action: 'start', request_id: randomUUID(), session_id: session };
      for (const [status, error] of [
        [403, 'first_job_origin_denied'],
        [401, 'first_job_access_denied'],
        [429, 'first_job_rate_limited'],
      ] as const) {
        fault.guard = refusal(status);
        const answer = await start(body);
        expect(answer.status).toBe(status);
        expect(answer.body).toMatchObject({ error, retry_safe: true });
        // Recovery's own access refusals are not retry-safe; Concierge's are.
        const ended = await terminate(randomUUID(), {
          action: 'terminate_unstarted',
          display_digest: 'a'.repeat(64),
          session_id: session,
        });
        expect(ended.body).toMatchObject({ error, retry_safe: true });
      }
      fault.guard = null;
      expect((await read('?session_id=' + session)).body.tasks).toHaveLength(before);
    });

    it('answers a throw inside the gate with the coded 503, not a bare 500', async () => {
      fault.viewer = () => {
        throw new Error('PRIVATE /private/viewer-crash');
      };
      const answer = await read();
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({
        ok: false,
        error: 'first_job_history_unavailable',
        retry_safe: true,
      });
      expect(answer.body.correlation_id).toEqual(expect.any(String));
      expect(JSON.stringify(answer.body)).not.toContain('PRIVATE');
    });
  });
});
