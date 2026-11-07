import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Error classification only: the owner contract with actual stores is
// onboarding-authority-route.test.ts. The core facade is stubbed to throw.
const core = vi.hoisted(() => ({ failure: new Error('unset') }));
vi.mock('@agent/core/organization/onboarding-authority', () => ({
  onboardingAuthorityScope: () => ({ kind: 'person' }),
  readOnboardingAuthority: () => {
    throw core.failure;
  },
  previewOnboardingAuthority: vi.fn(),
  requestOnboardingAuthority: vi.fn(),
  onboardingAuthorityRequestStatus: vi.fn(),
  applyOnboardingAuthority: vi.fn(),
}));
vi.mock('../src/lib/onboarding-authority-server', () => ({
  asOnboardingOwner: (body: () => unknown) => body(),
  onboardingAuthorityPrincipal: () => ({
    requesterId: 'user:owner',
    accountableId: 'user:owner',
    personalOwner: true,
    tenantSlugs: 'all',
  }),
}));
vi.mock('../src/lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/viewer-context')>()),
  resolveConciergeViewer: () => ({ context: { principalId: 'owner', role: 'localadmin' } }),
}));

const get = async () => {
  const route = await import('../src/app/api/onboarding-authority/route');
  const response = route.GET(
    new NextRequest('http://localhost:3050/api/onboarding-authority?scope_kind=person')
  );
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    text: await response.text(),
  };
};

describe('onboarding authority route error classification', () => {
  it.each([
    "[ROLE_VIOLATION] Role is NOT authorized to read directory '/srv/kyberion/active/shared/runtime/tenant-approvals/personal/shared/owners/abc/onboarding-authority/requests'. [POLICY_VIOLATION] tenant.scope_invalid_prefix",
    'Not a regular file: /srv/kyberion/active/shared/runtime/x.json',
    "ENOENT: no such file or directory, open '/srv/kyberion/knowledge/x.json'",
    "[POLICY_VIOLATION] tenant.scope_missing — access to protected tenant path 'active/shared/runtime/x'",
    'Unexpected token } in JSON at position 4',
  ])('answers an internal failure generically: %s', async (message) => {
    core.failure = new Error(message);
    const { status, cache, text } = await get();
    expect(status).toBe(500);
    expect(cache).toBe('no-store');
    expect(text).not.toContain('/srv/kyberion');
    expect(text).not.toContain('active/shared');
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: false });
    expect(body.error).not.toBe(message);
    expect(typeof body.correlation_id).toBe('string');
  });

  it('keeps a refusal the person can cause readable (repeated apply)', async () => {
    core.failure = new Error(
      '[POLICY_VIOLATION] Approval apply already started; recovery required'
    );
    const { status, text } = await get();
    expect(status).toBe(400);
    expect(JSON.parse(text).error).toBe(
      '[POLICY_VIOLATION] Approval apply already started; recovery required'
    );
  });

  it('never echoes an internal core failure (role / policy detail, absolute paths)', async () => {
    core.failure = new Error(
      "[ROLE_VIOLATION] Role is NOT authorized to read directory '/srv/kyberion/active/shared/runtime/tenant-approvals/personal/shared/owners/abc/onboarding-authority/requests'. [POLICY_VIOLATION] tenant.scope_invalid_prefix"
    );
    const { status, text } = await get();
    expect(status).toBe(500);
    expect(text).not.toContain('/srv/kyberion');
    expect(text).not.toContain('ROLE_VIOLATION');
    expect(JSON.parse(text)).toMatchObject({ ok: false });
  });

  it("keeps this domain's own refusals readable", async () => {
    core.failure = new Error('[ONBOARDING_AUTHORITY] installed personal owner identity required');
    const { status, text } = await get();
    expect(status).toBe(403);
    expect(JSON.parse(text).error).toBe(
      '[ONBOARDING_AUTHORITY] installed personal owner identity required'
    );
  });
});
