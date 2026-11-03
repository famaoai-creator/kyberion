import { describe, expect, it } from 'vitest';
import {
  parseAgentRefreshResponse,
  parseAgentRestartResponse,
  parseAgentShutdownResponse,
  parseAgentSpawnResponse,
} from './agent-control-response';

describe('agent control response boundary', () => {
  it('accepts spawn and shutdown acknowledgements with identities', () => {
    expect(parseAgentSpawnResponse({ status: 'spawned', agent: { agentId: 'agent-1' } })).toEqual({
      status: 'spawned',
      agent: { agentId: 'agent-1' },
    });
    expect(parseAgentShutdownResponse({ status: 'shutdown', agentId: 'agent-1' })).toEqual({
      status: 'shutdown',
      agentId: 'agent-1',
    });
  });

  it('accepts daemon and local refresh response variants', () => {
    expect(
      parseAgentRefreshResponse({
        status: 'ok',
        agentId: 'agent-1',
        refreshed: true,
        reason: 'soft refresh',
      })
    ).toMatchObject({ refreshed: true, reason: 'soft refresh' });
    expect(
      parseAgentRefreshResponse({
        status: 'ok',
        agentId: 'agent-1',
        mode: 'soft',
        snapshot: { agentId: 'agent-1' },
      })
    ).toMatchObject({ mode: 'soft', snapshot: { agentId: 'agent-1' } });
  });

  it('accepts restart responses from either supervisor path', () => {
    expect(
      parseAgentRestartResponse({
        status: 'ok',
        agentId: 'agent-1',
        snapshot: { status: 'ready' },
      })
    ).toMatchObject({ agentId: 'agent-1', snapshot: { status: 'ready' } });
    expect(
      parseAgentRestartResponse({
        status: 'ok',
        agentId: 'agent-1',
        agent: { agentId: 'agent-1' },
        snapshot: { status: 'ready' },
      })
    ).toBeDefined();
  });

  it('rejects malformed acknowledgements, mismatched variants, and unsafe records', () => {
    expect(parseAgentSpawnResponse({ status: 'spawned', agent: null })).toBeUndefined();
    expect(
      parseAgentRefreshResponse({ status: 'ok', agentId: 'agent-1', refreshed: true })
    ).toBeUndefined();
    expect(parseAgentRestartResponse({ status: 'ok', agentId: 'agent-1' })).toBeUndefined();
    const unsafe = JSON.parse('{"status":"shutdown","agentId":"agent-1","__proto__":"bad"}');
    expect(parseAgentShutdownResponse(unsafe)).toBeUndefined();
  });
});
