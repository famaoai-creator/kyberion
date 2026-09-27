import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFailoverIntentExtractor,
  getIntentExtractor,
  registerIntentExtractor,
  resetIntentExtractor,
  stubIntentExtractor,
  type IntentExtractor,
} from './intent-extractor.js';

describe('intent-extractor', () => {
  afterEach(() => {
    resetIntentExtractor();
  });

  it('defaults to the stub extractor', () => {
    expect(getIntentExtractor().name).toBe('stub');
  });

  it('resolves a registered extractor', () => {
    const fake: IntentExtractor = { name: 'fake', extract: stubIntentExtractor.extract };
    registerIntentExtractor(fake);
    expect(getIntentExtractor().name).toBe('fake');
  });

  it('rejects a second sole provider instead of silently replacing the first', () => {
    registerIntentExtractor({ name: 'first', extract: stubIntentExtractor.extract });
    expect(() =>
      registerIntentExtractor({ name: 'second', extract: stubIntentExtractor.extract })
    ).toThrow(/already has provider first/);
  });

  it('fails over to the next extractor when the first one throws', async () => {
    const calls: string[] = [];
    const extractor = buildFailoverIntentExtractor([
      {
        label: 'primary',
        provider: 'codex',
        extractor: {
          name: 'primary',
          extract: async () => {
            calls.push('primary');
            throw new Error('primary failed');
          },
        },
      },
      {
        label: 'fallback',
        provider: 'gemini',
        extractor: {
          name: 'fallback',
          extract: async () => {
            calls.push('fallback');
            return { goal: 'ok' };
          },
        },
      },
    ]);

    await expect(extractor.extract({ text: 'hello' })).resolves.toEqual({ goal: 'ok' });
    expect(calls).toEqual(['primary', 'fallback']);
  });

  describe('stubIntentExtractor', () => {
    it('returns a placeholder goal for empty text', async () => {
      const body = await stubIntentExtractor.extract({ text: '   ' });
      expect(body.goal).toBe('(no utterance)');
    });

    it('uses the first non-empty line as goal', async () => {
      const body = await stubIntentExtractor.extract({
        text: '\n\n今月の経営レポートを作って\nあと締切は来週',
      });
      expect(body.goal).toBe('今月の経営レポートを作って');
    });

    it('truncates long goals to 200 chars with ellipsis', async () => {
      const long = 'a'.repeat(500);
      const body = await stubIntentExtractor.extract({ text: long });
      expect(body.goal.length).toBe(200);
      expect(body.goal.endsWith('...')).toBe(true);
    });

    it('harvests @-mentions into stakeholders', async () => {
      const body = await stubIntentExtractor.extract({
        text: '@alice と @bob に確認してから @alice にフィードバックください',
      });
      expect(body.stakeholders).toEqual(['alice', 'bob']);
    });

    it('omits stakeholders when no mentions present', async () => {
      const body = await stubIntentExtractor.extract({ text: '午後の会議をリスケ' });
      expect(body.stakeholders).toBeUndefined();
    });
  });
});
