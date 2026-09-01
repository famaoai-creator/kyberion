import { describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => vi.fn(() => null));
const viewer = vi.hoisted(() => ({
  role: 'readonly' as const,
  tenantSlugs: ['tenant-a'],
  organizationIds: [],
  projectIds: [],
  tierAccess: ['public'] as Array<'public'>,
  source: 'token' as const,
}));

vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: guard }));
vi.mock('../../../lib/viewer-context', () => ({
  conciergeConversationScope: vi.fn(() => ({
    scope_kind: 'tenant',
    tier: 'public',
    tenant_slug: 'tenant-a',
  })),
  resolveConciergeViewer: vi.fn(() => ({ context: viewer })),
}));
vi.mock('../../../lib/i18n', () => ({
  conciergeText: vi.fn((key: string) => key),
  resolveConciergeLocale: vi.fn(() => 'en'),
}));

import { POST } from './route.js';

function request(body: unknown) {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as any;
}

describe('concierge message input contract', () => {
  it.each([
    ['null', null],
    ['object text', { text: { value: 'ignored' } }],
    ['array text', { text: ['ignored'] }],
  ])('rejects %s without contacting voice-hub', async (_label, body) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('api.text_required');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
