import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordMock = vi.fn();
vi.mock('./metrics.js', () => ({ metrics: { record: (...a: any[]) => recordMock(...a) } }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn(() => ({ id: 'x' })) } }));
vi.mock('./tier-guard.js', () => ({
  detectTier: () => 'public',
  validateWritePermission: () => ({ allowed: true }),
}));

import { recordCliUsage, summarizeTranscriptUsage } from './claude-code-hook.js';

const transcript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10 } },
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
    });
  });

  it('returns null for empty or usage-less transcripts', () => {
    expect(summarizeTranscriptUsage('')).toBeNull();
    expect(summarizeTranscriptUsage(JSON.stringify({ type: 'user', message: { content: 'x' } }))).toBeNull();
  });
});

describe('recordCliUsage', () => {
  beforeEach(() => recordMock.mockClear());

  it('returns false for null and records nothing', () => {
    expect(recordCliUsage(null)).toBe(false);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('records claude-code-cli usage with model + token counts', () => {
    expect(recordCliUsage({ model: 'claude-opus-4-8', inputTokens: 310, outputTokens: 130, turns: 2 })).toBe(true);
    expect(recordMock).toHaveBeenCalledWith(
      'claude-code-cli',
      0,
      'success',
      expect.objectContaining({
        model: 'claude-opus-4-8',
        usage: { prompt_tokens: 310, completion_tokens: 130 },
      }),
    );
  });
});
