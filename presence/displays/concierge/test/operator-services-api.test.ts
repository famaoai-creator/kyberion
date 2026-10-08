import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyOperatorService,
  checkOperatorApproval,
  createOperatorRequestGuard,
  fetchOperatorServices,
  parseOperatorServices,
  probeOperatorService,
  proposeOperatorService,
} from '../src/app/settings/operator-services-api';
const service = {
  serviceId: 'github',
  label: 'GitHub',
  secretKey: 'ACCESS_TOKEN',
  authOperation: 'github.auth.test',
  setupUrl: 'https://github.com/settings/personal-access-tokens',
  scopeNotice: 'Choose only the repositories and permissions needed.',
  credential_present: true,
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('operator services client boundary', () => {
  it('parses only descriptors, dropping unrecognized fields and refusing invalid identities or links', () => {
    expect(parseOperatorServices([{ ...service, value: 'must-never-return' }])).toEqual([service]);
    for (const invalid of [
      null,
      {},
      [service, service],
      [{ ...service, credential_present: 'true' }],
      [{ ...service, secretKey: 'API_KEY' }],
      [{ ...service, serviceId: '../slack' }],
      [{ ...service, setupUrl: 'javascript:alert(1)' }],
      [{ ...service, setupUrl: 'https://user:password@example.com' }],
    ])
      expect(parseOperatorServices(invalid)).toBeNull();
    expect(parseOperatorServices([])).toEqual([]);
  });

  it('uses one same-origin no-store endpoint; only apply carries a token', async () => {
    const mock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (!body) return reply({ ok: true, services: [service] });
      if (body.action === 'propose')
        return reply({ ok: true, approvalId: 'APR-1', status: 'approved', value: 'ignored' });
      if (body.action === 'apply')
        return reply({ ok: true, serviceId: 'github', status: 'registered', value: body.value });
      return reply({
        ok: true,
        serviceId: 'github',
        status: 'authenticated',
        checkedAt: '2026-10-08T12:00:00Z',
        account: 'ignored',
      });
    });
    vi.stubGlobal('fetch', mock);
    expect(await fetchOperatorServices()).toEqual({ ok: true, services: [service] });
    expect(await proposeOperatorService('github')).toEqual({
      ok: true,
      approvalId: 'APR-1',
      status: 'approved',
    });
    expect(await applyOperatorService('github', 'APR-1', 'example-token')).toEqual({
      ok: true,
      serviceId: 'github',
      status: 'registered',
    });
    expect(await probeOperatorService('github')).toEqual({
      ok: true,
      serviceId: 'github',
      status: 'authenticated',
      checkedAt: '2026-10-08T12:00:00.000Z',
    });
    for (const [url, init] of mock.mock.calls) {
      expect(url).toBe('/api/services/operator');
      expect(init).toMatchObject({
        cache: 'no-store',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
      });
    }
    expect(
      mock.mock.calls.map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null))
    ).toEqual([
      null,
      { action: 'propose', serviceId: 'github' },
      { action: 'apply', serviceId: 'github', approvalId: 'APR-1', value: 'example-token' },
      { action: 'probe', serviceId: 'github' },
    ]);
  });

  it('accepts pending approvals but rejects malformed successes or mismatched service outcomes', async () => {
    const results = [
      { ok: true, status: 'pending', approvalId: 'APR-2' },
      { ok: true, status: 'approved', approvalId: '' },
      { ok: true, serviceId: 'slack', status: 'registered' },
      { ok: true, serviceId: 'slack', status: 'authenticated', checkedAt: '2026-10-08T12:00:00Z' },
      { ok: true, serviceId: 'github', status: 'authenticated', checkedAt: 'example-token' },
      { ok: true, serviceId: 'github', status: 'connected', checkedAt: '2026-10-08T12:00:00Z' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply(results.shift()))
    );
    expect(await proposeOperatorService('github')).toEqual({
      ok: true,
      status: 'pending',
      approvalId: 'APR-2',
    });
    expect(await proposeOperatorService('github')).toEqual({ ok: false, error: 'unavailable' });
    expect(await applyOperatorService('github', 'APR-2', 'example-token')).toEqual({
      ok: false,
      error: 'unavailable',
    });
    for (let index = 0; index < 3; index++)
      expect(await probeOperatorService('github')).toEqual({ ok: false, error: 'unavailable' });
  });

  it.each([
    'local_operator_required',
    'invalid_request',
    'approval_required',
    'recovery_required',
    'unavailable',
  ])('returns the fixed %s code without raw detail', async (error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ ok: false, error, details: 'token-material' }, 403))
    );
    expect(await proposeOperatorService('github')).toEqual({ ok: false, error });
  });

  it('checks only the same pending approval and rejects a substituted approval id', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(reply({ ok: true, approvalId: 'APR-reviewed', status: 'approved' }))
      .mockResolvedValueOnce(reply({ ok: true, approvalId: 'APR-other', status: 'approved' }));
    vi.stubGlobal('fetch', mock);
    expect(await checkOperatorApproval('github', 'APR-reviewed')).toEqual({
      ok: true,
      approvalId: 'APR-reviewed',
      status: 'approved',
    });
    expect(JSON.parse(String(mock.mock.calls[0][1].body))).toEqual({
      action: 'status',
      serviceId: 'github',
      approvalId: 'APR-reviewed',
    });
    expect(await checkOperatorApproval('github', 'APR-reviewed')).toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('suppresses unexpected server and transport errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply({ ok: false, error: 'token-material' }, 500))
        .mockResolvedValueOnce(new Response('token-material', { status: 500 }))
        .mockRejectedValueOnce(new Error('token-material'))
    );
    for (let index = 0; index < 3; index++)
      expect(await fetchOperatorServices()).toEqual({ ok: false, error: 'unavailable' });
  });

  it('request generations reject duplicates, stale completions, and cancelled requests', () => {
    const guard = createOperatorRequestGuard();
    const first = guard.begin()!;
    expect(guard.begin()).toBeNull();
    expect(first.current()).toBe(true);
    guard.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    const second = guard.begin()!;
    first.finish();
    expect(second.current()).toBe(true);
    expect(guard.begin()).toBeNull();
    second.finish();
    expect(second.current()).toBe(false);
    expect(guard.begin()).not.toBeNull();
  });
});
