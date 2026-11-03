import { describe, expect, it } from 'vitest';
import { parseAgentProvidersResponse } from './agent-providers-response';

const provider = {
  provider: 'claude',
  installed: true,
  version: '1.2.3',
  protocol: 'print-json',
  models: ['sonnet'],
};

describe('agent providers response boundary', () => {
  it('accepts provider discovery fields consumed by AgentPanel', () => {
    expect(
      parseAgentProvidersResponse({
        status: 'ok',
        accessRole: 'localadmin',
        providers: [provider],
      })
    ).toEqual({ status: 'ok', accessRole: 'localadmin', providers: [provider] });
  });

  it('accepts unavailable providers with nullable versions', () => {
    expect(
      parseAgentProvidersResponse({
        status: 'ok',
        accessRole: 'readonly',
        providers: [{ ...provider, installed: false, version: null, models: [] }],
      })
    ).toMatchObject({ providers: [{ installed: false, version: null, models: [] }] });
  });

  it('rejects malformed protocols, model lists, and unsafe nested keys', () => {
    expect(
      parseAgentProvidersResponse({
        status: 'ok',
        accessRole: 'readonly',
        providers: [{ ...provider, protocol: 'http' }],
      })
    ).toBeUndefined();
    expect(
      parseAgentProvidersResponse({
        status: 'ok',
        accessRole: 'readonly',
        providers: [{ ...provider, models: [1] }],
      })
    ).toBeUndefined();
    const unsafe = JSON.parse('{"__proto__":"bad"}');
    expect(
      parseAgentProvidersResponse({
        status: 'ok',
        accessRole: 'readonly',
        providers: [{ ...provider, models: unsafe }],
      })
    ).toBeUndefined();
  });
});
