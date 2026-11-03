import { describe, expect, it } from 'vitest';
import { parseAgentLogsResponse } from './agent-logs-response';

describe('agent logs response boundary', () => {
  it('accepts the log fields consumed by AgentPanel', () => {
    expect(
      parseAgentLogsResponse({
        status: 'ok',
        agentId: 'agent-1',
        logs: [{ ts: 1_700_000_000_000, type: 'out', content: 'ready' }],
      })
    ).toEqual({
      status: 'ok',
      agentId: 'agent-1',
      logs: [{ ts: 1_700_000_000_000, type: 'out', content: 'ready' }],
    });
  });

  it('accepts an empty log list and empty content', () => {
    expect(parseAgentLogsResponse({ status: 'ok', agentId: 'agent-1', logs: [] })).toMatchObject({
      agentId: 'agent-1',
      logs: [],
    });
    expect(
      parseAgentLogsResponse({
        status: 'ok',
        agentId: 'agent-1',
        logs: [{ ts: 0, type: 'text', content: '' }],
      })
    ).toBeDefined();
  });

  it('rejects invalid timestamps, types, and unsafe nested keys', () => {
    expect(
      parseAgentLogsResponse({
        status: 'ok',
        agentId: 'agent-1',
        logs: [{ ts: -1, type: 'out', content: 'bad' }],
      })
    ).toBeUndefined();
    expect(
      parseAgentLogsResponse({
        status: 'ok',
        agentId: 'agent-1',
        logs: [{ ts: 1, type: '', content: 'bad' }],
      })
    ).toBeUndefined();
    const unsafe = JSON.parse('{"status":"ok","agentId":"agent-1","logs":[{"__proto__":"bad"}]}');
    expect(parseAgentLogsResponse(unsafe)).toBeUndefined();
  });
});
