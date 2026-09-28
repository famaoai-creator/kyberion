import { describe, expect, it } from 'vitest';
import { isOwnTtsEcho, isPureDisfluency, shouldRespondToVoiceTurn } from './voice-respond-gate.js';

describe('isPureDisfluency', () => {
  it.each([
    ['um', true],
    ['uh', true],
    ['um uh', true],
    ['Um, Uh', true],
    ['hmm', true],
    ['えーと', true],
    ['あの', true],
    ['まあ', true],
    ['うーん', true],
    ['えーとあの', true],
    ['えーと、あの', true],
    ['えーと まあ', true],
  ])('%s -> %s', (text, expected) => {
    expect(isPureDisfluency(text)).toBe(expected);
  });

  it.each([
    ['um, hello there', false],
    ['えーと、明日会議です', false],
    ['こんにちは', false],
    ['resume tomorrow', false],
    ['', false],
    ['   ', false],
    ['、。！？', false],
  ])('%s -> %s (mixed or real content is not pure disfluency)', (text, expected) => {
    expect(isPureDisfluency(text)).toBe(expected);
  });
});

describe('isOwnTtsEcho', () => {
  it('returns false when there is no recent assistant text', () => {
    expect(isOwnTtsEcho('今日の天気は晴れです', {})).toBe(false);
  });

  it('returns false when ageMs is unknown and the agent is not speaking (fails open)', () => {
    expect(
      isOwnTtsEcho('今日の天気は晴れです', { recentAssistantText: '今日の天気は晴れです' })
    ).toBe(false);
  });

  it('detects a near-verbatim Japanese echo within the age window', () => {
    expect(
      isOwnTtsEcho('今日の天気は晴れです', {
        recentAssistantText: '今日の天気は晴れです',
        ageMs: 1000,
      })
    ).toBe(true);
  });

  it('does not treat unrelated Japanese content as echo even with a shared trailing phrase', () => {
    expect(
      isOwnTtsEcho('猫が好きです', {
        recentAssistantText: '今日の天気は晴れです',
        ageMs: 1000,
      })
    ).toBe(false);
  });

  it('is inactive once ageMs exceeds the default 9000ms window', () => {
    expect(
      isOwnTtsEcho('今日の天気は晴れです', {
        recentAssistantText: '今日の天気は晴れです',
        ageMs: 9001,
      })
    ).toBe(false);
  });

  it('speaking=true forces the guard active regardless of ageMs', () => {
    expect(
      isOwnTtsEcho('今日の天気は晴れです', {
        recentAssistantText: '今日の天気は晴れです',
        ageMs: 999999,
        speaking: true,
      })
    ).toBe(true);
  });

  it('ignores case, whitespace, and punctuation when comparing', () => {
    expect(
      isOwnTtsEcho('That Sounds Great!', {
        recentAssistantText: 'that sounds great.',
        ageMs: 500,
      })
    ).toBe(true);
  });

  it('honours a custom windowMs', () => {
    const ctx = { recentAssistantText: '今日の天気は晴れです', ageMs: 5000 };
    expect(isOwnTtsEcho('今日の天気は晴れです', ctx, { windowMs: 9000 })).toBe(true);
    expect(isOwnTtsEcho('今日の天気は晴れです', ctx, { windowMs: 3000 })).toBe(false);
  });

  it('honours a custom overlap threshold', () => {
    const ctx = { recentAssistantText: 'abcdxy', ageMs: 500 };
    // bigram overlap of 'abcdef' vs 'abcdxy' is 3/5 = 0.6.
    expect(isOwnTtsEcho('abcdef', ctx, { overlap: 0.7 })).toBe(false);
    expect(isOwnTtsEcho('abcdef', ctx, { overlap: 0.5 })).toBe(true);
  });

  it('returns false when text normalizes to empty (punctuation-only)', () => {
    expect(
      isOwnTtsEcho('、。！？', { recentAssistantText: '今日の天気は晴れです', ageMs: 500 })
    ).toBe(false);
  });
});

describe('shouldRespondToVoiceTurn', () => {
  it('returns respond:false reason:empty for blank text', () => {
    expect(shouldRespondToVoiceTurn('   ')).toEqual({ respond: false, reason: 'empty' });
  });

  it('returns respond:false reason:disfluency for filler-only text', () => {
    expect(shouldRespondToVoiceTurn('えーと')).toEqual({ respond: false, reason: 'disfluency' });
    expect(shouldRespondToVoiceTurn('um')).toEqual({ respond: false, reason: 'disfluency' });
  });

  it('returns respond:false reason:echo for a self-echo within the window', () => {
    expect(
      shouldRespondToVoiceTurn('今日の天気は晴れです', {
        recentAssistantText: '今日の天気は晴れです',
        ageMs: 1000,
      })
    ).toEqual({ respond: false, reason: 'echo' });
  });

  it('returns respond:true for substantive content', () => {
    expect(shouldRespondToVoiceTurn('明日の会議は何時ですか')).toEqual({ respond: true });
  });

  it('returns respond:true when echo context is present but stale', () => {
    expect(
      shouldRespondToVoiceTurn('今日の天気は晴れです', {
        recentAssistantText: '今日の天気は晴れです',
        ageMs: 20000,
      })
    ).toEqual({ respond: true });
  });
});
