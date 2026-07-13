import { afterEach, describe, expect, it, vi } from 'vitest';

function createRequest(headers: Record<string, string> = {}, ip?: string) {
  const normalized = new Headers(headers);
  return {
    ip,
    headers: {
      get(name: string) {
        return normalized.get(name);
      },
    },
    cookies: {
      get() {
        return undefined;
      },
    },
  } as any;
}

async function loadGuardModule() {
  vi.resetModules();
  return import('../presence/displays/chronos-mirror-v2/src/lib/api-guard');
}

describe('Chronos API guard', () => {
  afterEach(() => {
    delete process.env.KYBERION_API_TOKEN;
    delete process.env.KYBERION_LOCALADMIN_TOKEN;
    delete process.env.KYBERION_ALLOW_UNAUTH_REMOTE;
    delete process.env.KYBERION_LOCALHOST_AUTOADMIN;
    vi.resetModules();
  });

  it('grants localhost localadmin by default and readonly when autoadmin is opted out', async () => {
    // Contract updated with the operator-surface redesign: the local operator
    // can intervene from the 管制塔 without a token; remote stays token-gated.
    // "Local" must come from the runtime's own NextRequest.ip, never from a
    // client-supplied header (see the next test) - that would let any
    // remote caller spoof localadmin by sending x-forwarded-for: 127.0.0.1.
    const guard = await loadGuardModule();
    const req = createRequest({}, '127.0.0.1');
    expect(guard.resolveChronosAccessRole(req)).toBe('localadmin');

    process.env.KYBERION_LOCALHOST_AUTOADMIN = 'false';
    const hardened = await loadGuardModule();
    expect(hardened.resolveChronosAccessRole(req)).toBe('readonly');
  });

  it('does not trust a spoofed x-forwarded-for header as a local signal', async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = 'true';
    const guard = await loadGuardModule();
    // No genuine req.ip - only a client-supplied header, which is never
    // trusted for local-admin promotion.
    const req = createRequest({ 'x-forwarded-for': '127.0.0.1' });

    expect(guard.resolveChronosAccessRole(req)).toBeNull();
  });

  it('promotes localhost to localadmin only when opt-in flag is enabled', async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = 'true';
    const guard = await loadGuardModule();
    const req = createRequest({}, '127.0.0.1');

    expect(guard.resolveChronosAccessRole(req)).toBe('localadmin');
  });

  it('still honors explicit readonly token over localhost auto-admin', async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = 'true';
    process.env.KYBERION_API_TOKEN = 'readonly-token';
    const guard = await loadGuardModule();
    const req = createRequest({ authorization: 'Bearer readonly-token' }, '127.0.0.1');

    expect(guard.resolveChronosAccessRole(req)).toBe('readonly');
  });

  it('still honors explicit localadmin token over localhost auto-admin', async () => {
    process.env.KYBERION_LOCALHOST_AUTOADMIN = 'true';
    process.env.KYBERION_LOCALADMIN_TOKEN = 'localadmin-token';
    const guard = await loadGuardModule();
    const req = createRequest({ authorization: 'Bearer localadmin-token' }, '127.0.0.1');

    expect(guard.resolveChronosAccessRole(req)).toBe('localadmin');
  });
});
