import { afterEach, describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../capability-broker.js', () => ({ resolveProviderDecision: broker.resolve }));
import { consultCapabilityBrokerForMode, resetReasoningBootstrap } from './reasoning-bootstrap.js';

describe('fixed reasoning capability broker constraints', () => {
  afterEach(() => {
    broker.resolve.mockReset();
    resetReasoningBootstrap();
  });
  it('rejects a conflicting pinned runtime instead of replacing fixed selection', () => {
    broker.resolve.mockReturnValue({ pinned: true, provider: 'codex-cli', modelId: 'gpt-6-sol' });
    expect(() => consultCapabilityBrokerForMode('anthropic', true, 'claude-opus-4-8')).toThrow(
      /broker pin conflicts/
    );
  });
  it('rejects a conflicting pinned exact model on the same runtime', () => {
    broker.resolve.mockReturnValue({
      pinned: true,
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
    });
    expect(() => consultCapabilityBrokerForMode('anthropic', true, 'claude-opus-4-8')).toThrow(
      /broker model pin conflicts/
    );
  });
  it('accepts the descriptor provider identity for a matching fixed CLI mode', () => {
    broker.resolve.mockReturnValue({
      pinned: true,
      provider: 'codex',
      modelId: 'openai:gpt-6-sol',
    });
    expect(consultCapabilityBrokerForMode('codex-cli', true, 'gpt-6-sol')).toBe('codex-cli');
  });
  it('retains legacy broker override behavior when no fixed selection exists', () => {
    broker.resolve.mockReturnValue({ pinned: true, provider: 'codex-cli', modelId: 'gpt-6-sol' });
    expect(consultCapabilityBrokerForMode('anthropic')).toBe('codex-cli');
  });
});
