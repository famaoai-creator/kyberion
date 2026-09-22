import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type GuardResponse = { status: number };
const selfServiceGuard = vi.hoisted(() => vi.fn<() => GuardResponse | null>(() => null));
const defaultViewer = () => ({
  context: {
    role: 'localadmin' as const,
    tenantSlugs: 'all' as const,
    organizationIds: 'all' as const,
    projectIds: 'all' as const,
    tierAccess: ['confidential', 'public'] as Array<'confidential' | 'public'>,
    source: 'loopback' as const,
  },
});
const viewerResolution = vi.hoisted(() => ({ value: undefined as unknown }));
const mocks = vi.hoisted(() => ({
  resolveMember: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  list: vi.fn(),
}));

vi.mock('../../../../lib/work-inventory-member', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/work-inventory-member')>(
    '../../../../lib/work-inventory-member'
  );
  return {
    ...actual,
    requireConciergeSelfServiceAccess: selfServiceGuard,
  };
});
vi.mock('../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/viewer-context')>(
    '../../../../lib/viewer-context'
  );
  return {
    ...actual,
    resolveConciergeViewer: vi.fn(() => viewerResolution.value),
  };
});
vi.mock('../../../../lib/i18n', () => ({
  frontDeskText: vi.fn((key: string) => key),
  resolveConciergeLocale: vi.fn(() => 'en'),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/member-registry', () => ({
  resolveMemberByPrincipal: mocks.resolveMember,
}));
vi.mock('@agent/core/work-inventory-consent', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/work-inventory-consent')>(
    '@agent/core/work-inventory-consent'
  );
  return {
    ...actual,
    grantWorkInventoryConsent: mocks.grant,
    revokeWorkInventoryConsent: mocks.revoke,
    listWorkInventoryConsents: mocks.list,
  };
});

import { GET, POST } from './route.js';
import { WorkInventoryConsentError } from '@agent/core/work-inventory-consent';

function request(body?: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}

describe('concierge work-inventory consent route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selfServiceGuard.mockReturnValue(null);
    viewerResolution.value = defaultViewer();
  });

  it('anonymous viewers are rejected before any member lookup', () => {
    viewerResolution.value = {
      response: new Response(JSON.stringify({ ok: false, error: 'no viewer' }), { status: 401 }),
    };
    const response = GET(request());
    expect((response as Response).status).toBe(401);
    expect(mocks.resolveMember).not.toHaveBeenCalled();
  });

  it("only reads the resolved viewer's own consents — a client id in the body is ignored", async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.list.mockReturnValue([]);

    const response = GET(request());
    const payload = await (response as Response).json();

    expect(payload.ok).toBe(true);
    expect(mocks.resolveMember).toHaveBeenCalledWith({
      principalId: undefined,
      source: 'loopback',
      registrationLabel: undefined,
    });
    expect(mocks.list).toHaveBeenCalledWith('member-a');
  });

  it('404s when the viewer has no member record yet', () => {
    mocks.resolveMember.mockReturnValue(null);
    const response = GET(request());
    expect((response as Response).status).toBe(404);
  });

  it('POST grant rejects an unknown client-supplied key (e.g. member_id) before touching the domain layer', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    const response = await POST(
      request({
        action: 'grant',
        sources: ['desktop_recording'],
        observation_kinds: ['active_window'],
        purpose: 'find automation candidates',
        days: 7,
        member_id: 'member-b',
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('POST grant surfaces a malformed sources field as 400 before calling the domain layer', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    const response = await POST(
      request({
        action: 'grant',
        sources: 'not-an-array',
        observation_kinds: [],
        purpose: '',
        days: 1,
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('POST grant rejects days outside integer 1..max as 400 before calling the domain layer', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    for (const days of [1e308, 91, 0, -1, 1.5, '7', null]) {
      const response = await POST(
        request({
          action: 'grant',
          sources: ['desktop_recording'],
          observation_kinds: ['active_window'],
          purpose: 'find automation candidates',
          days,
        })
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('POST grant maps a domain validation error to 400 without leaking internals', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.grant.mockImplementation(() => {
      throw new WorkInventoryConsentError('invalid_input', 'purpose must be 1..500 characters');
    });
    const response = await POST(
      request({
        action: 'grant',
        sources: ['desktop_recording'],
        observation_kinds: ['active_window'],
        purpose: '',
        days: 7,
      })
    );
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.error_code).toBe('invalid_input');
    expect(payload.error).not.toMatch(/\/.*\.(ts|json)/);
  });

  it('POST grant always acts as the resolved viewer, never a client-supplied member', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.grant.mockReturnValue({ consent_id: 'WIC-20260101-abc123456789' });
    const response = await POST(
      request({
        action: 'grant',
        sources: ['desktop_recording'],
        observation_kinds: ['active_window'],
        purpose: 'find automation candidates',
        days: 7,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        member_id: 'member-a',
        granted_by: { kind: 'human', id: 'member-a' },
      }),
      expect.anything()
    );
  });

  it('POST revoke always acts as the resolved viewer, ignoring any other id', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.revoke.mockReturnValue({ consent_id: 'WIC-20260101-abc123456789' });
    const response = await POST(
      request({ action: 'revoke', consent_id: 'WIC-20260101-abc123456789' })
    );
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(
      'member-a',
      'WIC-20260101-abc123456789',
      expect.objectContaining({ by: { kind: 'human', id: 'member-a' } })
    );
  });

  it('POST revoke maps a not_found domain error to 404', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.revoke.mockImplementation(() => {
      throw new WorkInventoryConsentError('not_found', 'consent WIC-x not found');
    });
    const response = await POST(request({ action: 'revoke', consent_id: 'WIC-x' }));
    expect(response.status).toBe(404);
  });

  // WI-18 (user decision 2026-09-22): a readonly-role token member may
  // grant/revoke their own consent — this route only calls
  // `requireConciergeSelfServiceAccess`, never `requireConciergeMutationAccess`.
  it('POST grant succeeds for a readonly-role token viewer resolved to an active member', async () => {
    viewerResolution.value = {
      context: {
        role: 'readonly' as const,
        tenantSlugs: ['acme'] as string[],
        organizationIds: 'all' as const,
        projectIds: 'all' as const,
        tierAccess: ['confidential', 'public'] as Array<'confidential' | 'public'>,
        source: 'token' as const,
        principalId: 'reader-token',
        registrationLabel: 'reader-token',
      },
    };
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.grant.mockReturnValue({ consent_id: 'WIC-20260101-abc123456789' });
    const response = await POST(
      request({
        action: 'grant',
        sources: ['desktop_recording'],
        observation_kinds: ['active_window'],
        purpose: 'find automation candidates',
        days: 7,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ member_id: 'member-a' }),
      expect.anything()
    );
  });

  it('POST revoke succeeds for a readonly-role token viewer resolved to an active member', async () => {
    viewerResolution.value = {
      context: {
        role: 'readonly' as const,
        tenantSlugs: ['acme'] as string[],
        organizationIds: 'all' as const,
        projectIds: 'all' as const,
        tierAccess: ['confidential', 'public'] as Array<'confidential' | 'public'>,
        source: 'token' as const,
        principalId: 'reader-token',
        registrationLabel: 'reader-token',
      },
    };
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.revoke.mockReturnValue({ consent_id: 'WIC-20260101-abc123456789' });
    const response = await POST(
      request({ action: 'revoke', consent_id: 'WIC-20260101-abc123456789' })
    );
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(
      'member-a',
      'WIC-20260101-abc123456789',
      expect.anything()
    );
  });

  it('honors a self-service guard denial (e.g. CSRF/rate-limit) before touching the domain layer', async () => {
    selfServiceGuard.mockReturnValue(
      new Response(JSON.stringify({ ok: false, error: 'Forbidden.' }), { status: 403 })
    );
    const response = await POST(request({ action: 'grant' }));
    expect((response as Response).status).toBe(403);
    expect(mocks.resolveMember).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});
