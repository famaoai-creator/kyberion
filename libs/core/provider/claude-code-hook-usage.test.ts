import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordMock = vi.fn();
vi.mock('../analysis/metrics.js', () => ({
  metrics: { record: (...a: any[]) => recordMock(...a) },
}));
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn(() => ({ id: 'x' })) },
}));
vi.mock('../tier-guard.js', () => ({
  detectTier: () => 'public',
  validateWritePermission: () => ({ allowed: true }),
}));

import { recordCliUsage, summarizeTranscriptUsage } from './claude-code-hook.js';
import { ALL_TEST_RUN_MARKER_ENV_KEYS } from '../foundation/env.js';
import { isSessionHookMetricsRow } from './session-hook-provenance.js';

const transcript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10 },
    },
  }),
  '',
  'not json — should be skipped',
  JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 80 } },
  }),
].join('\n');

describe('summarizeTranscriptUsage', () => {
  it('sums input (incl. cache-creation) + output tokens across assistant turns and picks the model', () => {
    expect(summarizeTranscriptUsage(transcript)).toEqual({
      model: 'claude-opus-4-8',
      inputTokens: 310, // 100 + 10 cache-creation + 200
      outputTokens: 130, // 50 + 80
      turns: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 10,
    });
  });

  it('counts per-content-block lines sharing a message.id once (last record wins)', () => {
    const block = (id: string, usage: Record<string, number>) =>
      JSON.stringify({
        type: 'assistant',
        message: { id, model: 'claude-opus-5-5', usage },
      });
    const text = [
      // Claude Code writes one line per content block, repeating id + usage.
      block('msg_A', { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1000 }),
      block('msg_A', { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 1000 }),
      block('msg_A', {
        input_tokens: 5,
        output_tokens: 40,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      }),
      block('msg_B', { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 2000 }),
      block('msg_B', { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 2000 }),
      // No id: counted individually.
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 4 } },
      }),
    ].join('\n');
    expect(summarizeTranscriptUsage(text)).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 5 + 200 + 3 + 1 + 4,
      outputTokens: 40 + 7 + 1,
      turns: 3,
      cacheReadTokens: 1000 + 2000,
      cacheCreationTokens: 200 + 4,
    });
  });

  it('returns null for empty or usage-less transcripts', () => {
    expect(summarizeTranscriptUsage('')).toBeNull();
    expect(
      summarizeTranscriptUsage(JSON.stringify({ type: 'user', message: { content: 'x' } }))
    ).toBeNull();
  });

  it('skips transcript entries containing dangerous JSON keys', () => {
    expect(
      summarizeTranscriptUsage(
        '{"type":"assistant","message":{"usage":{"input_tokens":10},"meta":{"__proto__":{}}}}'
      )
    ).toBeNull();
  });
});

describe('recordCliUsage', () => {
  beforeEach(() => recordMock.mockClear());

  it('returns false for null and records nothing', () => {
    expect(recordCliUsage(null)).toBe(false);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('records claude-code-cli usage with model + token counts', () => {
    expect(
      recordCliUsage({ model: 'claude-opus-4-8', inputTokens: 310, outputTokens: 130, turns: 2 })
    ).toBe(true);
    expect(recordMock).toHaveBeenCalledWith(
      'claude-code-cli',
      0,
      'success',
      expect.objectContaining({
        model: 'claude-opus-4-8',
        usage: { prompt_tokens: 310, completion_tokens: 130 },
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      })
    );
  });

  it('carries cache read / creation tokens on the claude-code-cli row (outside usage)', () => {
    recordCliUsage({
      model: 'claude-opus-5-5',
      inputTokens: 213,
      outputTokens: 48,
      turns: 3,
      cacheReadTokens: 3000,
      cacheCreationTokens: 204,
    });
    const extra = recordMock.mock.calls[0]![3];
    expect(extra.usage).toEqual({ prompt_tokens: 213, completion_tokens: 48 });
    expect(extra.cache_read_tokens).toBe(3000);
    expect(extra.cache_creation_tokens).toBe(204);
  });

  describe('session-hook provenance stamp', () => {
    afterEach(() => vi.unstubAllEnvs());
    const summary = { model: 'claude-opus-4-8', inputTokens: 1, outputTokens: 1, turns: 1 };
    // The row metrics.record persists: { component, duration_ms, status, ...extra }.
    const persisted = () => {
      const [component, duration_ms, status, extra] = recordMock.mock.calls[0]!;
      return { component, duration_ms, status, ...extra };
    };

    it('stamps the Stop hook usage row of a host session outside Vitest', () => {
      for (const key of ALL_TEST_RUN_MARKER_ENV_KEYS) vi.stubEnv(key, ''); // metrics is mocked: nothing reaches a live ledger
      for (const key of ['DEVIN_PROJECT_DIR', 'CHISEL_SESSION_DB', 'AI_AGENT']) vi.stubEnv(key, '');
      expect(recordCliUsage(summary, 'sess-9')).toBe(true);
      vi.unstubAllEnvs();
      expect(persisted().session_hook).toEqual({
        host: 'claude',
        event: 'Stop',
        session_id: 'sess-9',
      });
      expect(isSessionHookMetricsRow(persisted())).toBe(true);
    });

    it('never stamps under Vitest or without a session id', () => {
      recordCliUsage(summary, 'sess-9');
      expect(persisted()).not.toHaveProperty('session_hook');
      recordMock.mockClear();
      for (const key of ALL_TEST_RUN_MARKER_ENV_KEYS) vi.stubEnv(key, '');
      recordCliUsage(summary);
      vi.unstubAllEnvs();
      expect(persisted()).not.toHaveProperty('session_hook');
      expect(isSessionHookMetricsRow(persisted())).toBe(false);
    });
  });
});
