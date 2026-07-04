import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBridgeErrorReplyText,
  buildBridgeEmptyReplyText,
  shouldPostBridgeError,
  resetBridgeErrorRateLimiter,
  postBridgeError,
  chunkBridgeMessage,
} from './bridge-error-reply.js';

describe('bridge-error-reply', () => {
  beforeEach(() => {
    resetBridgeErrorRateLimiter();
  });

  describe('buildBridgeErrorReplyText', () => {
    it('never leaks the raw error message', () => {
      const secret = 'ECONNREFUSED tcp://10.0.0.5:5432 password=hunter2';
      const text = buildBridgeErrorReplyText(new Error(secret), { locale: 'ja', surface: 'slack' });
      expect(text).not.toContain(secret);
      expect(text).not.toContain('hunter2');
      expect(text.length).toBeGreaterThan(0);
    });

    it('renders Japanese vocabulary for ja locale', () => {
      const text = buildBridgeErrorReplyText(new Error('boom'), { locale: 'ja' });
      expect(text).toContain('問題が発生しました');
    });
  });

  describe('buildBridgeEmptyReplyText', () => {
    it('returns a non-empty deterministic message', () => {
      const ja = buildBridgeEmptyReplyText({ locale: 'ja' });
      expect(ja).toContain('生成できませんでした');
      const en = buildBridgeEmptyReplyText({ locale: 'en' });
      expect(en).toContain('could not produce');
    });
  });

  describe('shouldPostBridgeError', () => {
    it('allows the first post and blocks repeats within the interval', () => {
      const now = 1_000_000;
      expect(shouldPostBridgeError('conv-a', now)).toBe(true);
      expect(shouldPostBridgeError('conv-a', now + 1_000)).toBe(false);
      expect(shouldPostBridgeError('conv-a', now + 61_000)).toBe(true);
    });

    it('tracks conversations independently', () => {
      const now = 2_000_000;
      expect(shouldPostBridgeError('conv-a', now)).toBe(true);
      expect(shouldPostBridgeError('conv-b', now)).toBe(true);
    });
  });

  describe('postBridgeError', () => {
    it('posts once and suppresses the second call', async () => {
      const post = vi.fn().mockResolvedValue(undefined);
      const first = await postBridgeError({ conversationKey: 'k1', err: new Error('x'), post });
      const second = await postBridgeError({ conversationKey: 'k1', err: new Error('x'), post });
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('swallows posting failures', async () => {
      const post = vi.fn().mockRejectedValue(new Error('network down'));
      const result = await postBridgeError({ conversationKey: 'k2', err: new Error('x'), post });
      expect(result).toBe(false);
    });
  });

  describe('chunkBridgeMessage', () => {
    it('returns single chunk for short text', () => {
      expect(chunkBridgeMessage('hello', 1900)).toEqual(['hello']);
    });

    it('splits long text into chunks within the limit', () => {
      const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
      const chunks = chunkBridgeMessage(text, 500);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(505); // + closing fence allowance
      }
      expect(chunks.join('\n').replace(/```\n?/g, '')).toContain('line 299');
    });

    it('keeps code fences balanced in every chunk', () => {
      const text = '```ts\n' + Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n```';
      const chunks = chunkBridgeMessage(text, 400);
      for (const chunk of chunks) {
        const fences = (chunk.match(/```/g) || []).length;
        expect(fences % 2).toBe(0);
      }
    });
  });
});
