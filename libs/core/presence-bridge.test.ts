import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchPresenceFrame, reflectPresenceAgentReply } from './presence-bridge.js';

describe('presence bridge', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('dispatches a presence frame via A2UI bridge endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await dispatchPresenceFrame({
      agentId: 'presence-surface-agent',
      subtitle: 'hello',
      expression: 'joy',
      transcript: [],
    }, 'http://127.0.0.1:3031');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3031/a2ui/dispatch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('dispatches an assistant reply timeline', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await reflectPresenceAgentReply({
      agentId: 'chronos-agent',
      text: 'response text',
      speaker: 'Chronos',
    }, 'http://127.0.0.1:3031');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3031/api/timeline/dispatch',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
