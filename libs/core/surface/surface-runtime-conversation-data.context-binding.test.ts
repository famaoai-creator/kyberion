import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  completed: vi.fn(),
  reopen: vi.fn(),
  classify: vi.fn(),
  create: vi.fn(),
  query: vi.fn(),
  agenda: vi.fn(),
}));
vi.mock('../task/task-session.js', async () => ({
  ...(await vi.importActual<typeof import('../task/task-session.js')>('../task/task-session.js')),
  getActiveTaskSession: mocks.active,
  getLatestCompletedTaskSession: mocks.completed,
  reopenTaskSession: mocks.reopen,
  classifyTaskSessionIntent: mocks.classify,
  createTaskSession: mocks.create,
}));
vi.mock('./surface-runtime-helpers.js', async () => ({
  ...(await vi.importActual<typeof import('./surface-runtime-helpers.js')>(
    './surface-runtime-helpers.js'
  )),
  readScheduleAgenda: mocks.agenda,
}));
vi.mock('./surface-query.js', async () => ({
  ...(await vi.importActual<typeof import('./surface-query.js')>('./surface-query.js')),
  getSurfaceQueryProviderConfig: mocks.query,
}));
import {
  getActiveTaskSessionForConversation,
  surfaceRuntimeContextStore,
  handleSurfaceQueryRoute,
  handleTaskSessionRoute,
} from './surface-runtime-conversation-data.js';
import { deriveSurfaceConversationPartitionKey } from './surface-conversation-runtime-context.js';
import type { SurfaceConversationInput } from './channel-surface-types.js';

const input = (
  scope: SurfaceConversationInput['scope'] = {
    tier: 'confidential',
    tenant_slug: 'acme',
    viewer_principal: 'viewer-a',
  }
): SurfaceConversationInput => ({
  agentId: 'presence-surface-agent',
  senderAgentId: 'surface-test',
  query: 'current request',
  surface: 'presence',
  correlationId: 'same-public-correlation',
  conversationKey: 'a'.repeat(64),
  scope,
});
const context = () => ({
  input: input(),
  structuredQuery: 'No, use the earlier plan instead.',
  compiledFlow: null,
  parsedSlackPrompt: null,
});
beforeEach(() => vi.clearAllMocks());

describe('scoped inherited task-state boundaries', () => {
  it('requires both server partition binding and public correlation on active state', () => {
    const current = input();
    const session = {
      correlation_id: current.correlationId,
      payload: { surface_conversation_partition: deriveSurfaceConversationPartitionKey(current) },
    };
    mocks.active.mockReturnValue(session);
    expect(
      surfaceRuntimeContextStore.run(current, () =>
        getActiveTaskSessionForConversation('presence', current.correlationId)
      )
    ).toBe(session);
    for (const scope of [
      { ...current.scope, viewer_principal: 'viewer-b' },
      { ...current.scope, tenant_slug: 'globex' },
      { ...current.scope, tier: 'public' as const },
    ]) {
      expect(
        surfaceRuntimeContextStore.run(input(scope), () =>
          getActiveTaskSessionForConversation('presence', current.correlationId)
        )
      ).toBeNull();
    }
    mocks.active.mockReturnValue({ correlation_id: current.correlationId, payload: {} });
    expect(
      surfaceRuntimeContextStore.run(current, () =>
        getActiveTaskSessionForConversation('presence', current.correlationId)
      )
    ).toBeNull();
    mocks.active.mockReturnValue({ payload: session.payload });
    expect(
      surfaceRuntimeContextStore.run(current, () =>
        getActiveTaskSessionForConversation('presence', current.correlationId)
      )
    ).toBeNull();
  });

  it('does not reopen completed or execute legacy tasks on a scoped request', async () => {
    await expect(handleTaskSessionRoute(context())).rejects.toMatchObject({
      capability: 'legacy_task_session_execution',
    });
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(mocks.reopen).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects ambient query adapters before reading owner calendar or provider scope', async () => {
    await expect(
      handleSurfaceQueryRoute(context(), { intentId: 'schedule-read-agenda' } as never)
    ).rejects.toMatchObject({ capability: 'legacy_surface_query' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.agenda).not.toHaveBeenCalled();
  });

  it('keeps legacy active-state fallback unchanged', () => {
    const session = { payload: {} };
    mocks.active.mockReturnValue(session);
    const { conversationKey: _key, ...legacy } = input();
    expect(
      surfaceRuntimeContextStore.run(legacy, () =>
        getActiveTaskSessionForConversation('presence', 'unrelated')
      )
    ).toBe(session);
  });
});
