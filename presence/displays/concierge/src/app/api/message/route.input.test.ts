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

  it('projects a voice-hub approval-required contract as an execution preview', async () => {
    const intentResolution = {
      request_id: 'request-approval-1',
      normalized_intent: 'send the approved report',
      missing_inputs: [],
      resolution_shape: 'mission' as const,
      outcome_kind: 'approval_ready_plan' as const,
      authority_level: 'approval_required' as const,
      next_action: {
        kind: 'request_approval' as const,
        label: 'Approve and start',
        consequence: 'The mission will start after approval.',
      },
      rationale: 'The requested operation changes external state.',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ reply: 'Ready for approval.', intentResolution }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const response = await POST(request({ text: 'send the approved report' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      mode: 'voice-hub',
      shape: 'execution_preview',
      nextActions: [{ id: 'approve', label: 'Approve and start' }],
      intentResolution,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
