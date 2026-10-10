import { beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => vi.fn(() => null));
const run = vi.hoisted(() => vi.fn());
const viewer = vi.hoisted(() => ({
  role: 'readonly' as const,
  tenantSlugs: ['tenant-a'],
  organizationIds: 'all' as const,
  projectIds: 'all' as const,
  tierAccess: ['public'] as Array<'public'>,
  source: 'token' as const,
  principalId: 'human:test-reader',
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
vi.mock('@agent/core/surface/front-desk-conversation-store', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/core/surface/front-desk-conversation-store')
  >('@agent/core/surface/front-desk-conversation-store');
  return {
    ...actual,
    conversationRef: () => ({ sessionId: 'server-input-thread', key: 'b'.repeat(64) }),
    reserveConversationTurn: () => ({ id: '22222222-2222-4222-8222-222222222222', created: true }),
    completeConversationTurn: vi.fn(),
    markConversationTurnUncertain: vi.fn(),
    markConversationTurnNotStarted: vi.fn(),
    completedConversationContext: () => ({ messages: [], truncated: false }),
  };
});
vi.mock('@agent/core/surface/channel-surface', () => ({ runSurfaceMessageConversation: run }));
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

beforeEach(() => vi.clearAllMocks());

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

  it('projects a scoped orchestrator approval-required contract without contacting voice-hub', async () => {
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
    run.mockResolvedValue({ text: 'Ready for approval.', intentResolution });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await POST(request({ text: 'send the approved report' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      mode: 'orchestrator',
      shape: 'execution_preview',
      nextActions: [{ id: 'approve', label: 'Approve and start' }],
      intentResolution,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: 'b'.repeat(64),
        conversationHistory: [],
        scope: expect.objectContaining({
          viewer_principal: 'human:test-reader',
          tenant_slug: 'tenant-a',
          tier: 'public',
        }),
      })
    );
    fetchSpy.mockRestore();
  });
});
