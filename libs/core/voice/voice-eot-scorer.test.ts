import { describe, expect, it } from 'vitest';
import { EotHoldAggregator, scoreEndOfTurn } from './voice-eot-scorer.js';

interface Case {
  text: string;
  hold: boolean;
}

const JAPANESE_CASES: Case[] = [
  // Continuation particles at the end — mid-clause, hold.
  { text: '今日は天気がいいけど', hold: true },
  { text: '明日行こうかなって', hold: true },
  { text: '資料を読んで', hold: true },
  { text: 'それで', hold: true },
  { text: '時間があるが', hold: true },
  { text: '疲れたし', hold: true },
  { text: '急いでいるから', hold: true },
  { text: '雨が降ったので', hold: true },
  { text: '忙しいのに', hold: true },
  { text: 'できたら', hold: true },
  { text: '会議室と', hold: true },
  { text: '資料を、', hold: true },
  { text: '難しいけれど', hold: true },
  // Fillers / hedges — holding the floor.
  { text: 'えーと', hold: true },
  { text: 'えっと', hold: true },
  { text: 'あの', hold: true },
  { text: 'その', hold: true },
  { text: 'まあ', hold: true },
  { text: 'うーん', hold: true },
  // Sentence-final punctuation / polite endings — commit.
  { text: '会議は明日です。', hold: false },
  { text: '行きます！', hold: false },
  { text: '本当ですか？', hold: false },
  { text: '資料を送ります', hold: false },
  { text: 'こちらです', hold: false },
  { text: '確認してください', hold: false },
  { text: 'それでいいですか', hold: false },
];

const ENGLISH_CASES: Case[] = [
  // Trailing conjunction / article / preposition — mid-clause, hold.
  { text: 'I wanted to go and', hold: true },
  { text: 'let me check but', hold: true },
  { text: 'we could go so', hold: true },
  { text: 'I stayed home because', hold: true },
  { text: 'pick coffee or', hold: true },
  { text: 'please pass the', hold: true },
  { text: 'this belongs to a', hold: true },
  { text: 'send this to', hold: true },
  { text: 'meet me with', hold: true },
  // Sentence-final punctuation — commit.
  { text: 'That sounds great.', hold: false },
  { text: 'Stop right there!', hold: false },
  { text: 'Are you coming?', hold: false },
  { text: 'Let us begin.', hold: false },
  { text: 'I already sent it.', hold: false },
  { text: 'What time is it?', hold: false },
  { text: 'Please close the door.', hold: false },
  { text: 'This is fine.', hold: false },
  { text: 'Can you hear me?', hold: false },
  { text: 'We are done.', hold: false },
  { text: 'Wait for me!', hold: false },
];

describe('scoreEndOfTurn — Japanese table', () => {
  it.each(JAPANESE_CASES)('$text -> hold=$hold', ({ text, hold }) => {
    const score = scoreEndOfTurn(text, 'ja');
    expect(score.lang).toBe('ja');
    if (hold) {
      expect(score.probability).toBeLessThan(0.5);
    } else {
      expect(score.probability).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('auto-detects Japanese by script presence', () => {
    expect(scoreEndOfTurn('今日は天気がいいけど', 'auto').lang).toBe('ja');
  });
});

describe('scoreEndOfTurn — English table', () => {
  it.each(ENGLISH_CASES)('$text -> hold=$hold', ({ text, hold }) => {
    const score = scoreEndOfTurn(text, 'en');
    expect(score.lang).toBe('en');
    if (hold) {
      expect(score.probability).toBeLessThan(0.5);
    } else {
      expect(score.probability).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('auto-detects English when no CJK script is present', () => {
    expect(scoreEndOfTurn('let me check but', 'auto').lang).toBe('en');
  });
});

describe('scoreEndOfTurn — edge cases', () => {
  it('empty text scores 0.5 with rule "empty"', () => {
    const score = scoreEndOfTurn('', 'ja');
    expect(score.probability).toBe(0.5);
    expect(score.rule).toBe('empty');
  });

  it('whitespace-only text scores 0.5 with rule "empty"', () => {
    expect(scoreEndOfTurn('   ', 'en').rule).toBe('empty');
  });
});

describe('EotHoldAggregator', () => {
  it('commits immediately on a complete Japanese final', () => {
    const aggregator = new EotHoldAggregator({ lang: 'ja' });
    const result = aggregator.offer('会議は明日です。');
    expect(result).toEqual({ commit: true, text: '会議は明日です。' });
  });

  it('holds an unfinished Japanese final and concatenates with no space', () => {
    const aggregator = new EotHoldAggregator({ lang: 'ja' });
    const first = aggregator.offer('資料を読んで');
    expect(first.commit).toBe(false);
    expect(first.text).toBe('資料を読んで');

    const second = aggregator.offer('確認します');
    expect(second.commit).toBe(true);
    expect(second.text).toBe('資料を読んで確認します');
  });

  it('holds an unfinished English final and concatenates with a single space', () => {
    const aggregator = new EotHoldAggregator({ lang: 'en' });
    const first = aggregator.offer('let me check but');
    expect(first.commit).toBe(false);
    expect(first.text).toBe('let me check but');

    const second = aggregator.offer('I am not sure yet.');
    expect(second.commit).toBe(true);
    expect(second.text).toBe('let me check but I am not sure yet.');
  });

  it('ignores empty/whitespace-only finals without committing', () => {
    const aggregator = new EotHoldAggregator({ lang: 'ja' });
    const result = aggregator.offer('   ');
    expect(result.commit).toBe(false);
    expect(result.text).toBe('');
  });

  it('tick() returns null before maxHoldMs elapses', () => {
    let now = 0;
    const aggregator = new EotHoldAggregator({ lang: 'ja', maxHoldMs: 1500, now: () => now });
    aggregator.offer('資料を読んで');
    now = 1000;
    expect(aggregator.tick()).toBeNull();
  });

  it('tick() force-commits the held turn once maxHoldMs elapses', () => {
    let now = 0;
    const aggregator = new EotHoldAggregator({ lang: 'ja', maxHoldMs: 1500, now: () => now });
    aggregator.offer('資料を読んで');
    now = 1500;
    const result = aggregator.tick();
    expect(result).toEqual({ commit: true, text: '資料を読んで' });
    // Buffer is cleared after the forced commit.
    expect(aggregator.pending).toBe('');
  });

  it('tick() returns null when nothing is buffered', () => {
    const aggregator = new EotHoldAggregator();
    expect(aggregator.tick()).toBeNull();
  });

  it('reset() discards the buffered turn without committing', () => {
    const aggregator = new EotHoldAggregator({ lang: 'ja' });
    aggregator.offer('資料を読んで');
    aggregator.reset();
    expect(aggregator.pending).toBe('');
    expect(aggregator.tick()).toBeNull();
  });

  it('respects a custom commitThreshold', () => {
    // A no-signal utterance scores 0.5; with commitThreshold 0.9 it should hold.
    const aggregator = new EotHoldAggregator({ lang: 'ja', commitThreshold: 0.9 });
    const result = aggregator.offer('猫');
    expect(result.commit).toBe(false);
  });
});
