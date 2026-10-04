import { describe, expect, it } from 'vitest';
import {
  ReplySegmentLabeler,
  isNextStepLike,
  isReactionLike,
  segmentReplyStructure,
  splitReplySentences,
} from './reply-structure.js';
import { languagePackFromSource } from './language-pack.js';

const ja = languagePackFromSource('ja', {
  uses_word_spaces: false,
  agent_backchannels: ['うん', 'なるほど', 'そうそう'],
  barge_in_backchannels: ['うん', 'うんうん'],
  eot_fillers: ['えーと', 'あの'],
  next_step_markers: ['次は', 'では', '最後に'],
});

const en = languagePackFromSource('en', {
  uses_word_spaces: true,
  agent_backchannels: ['okay', 'right', 'got it'],
  barge_in_backchannels: ['yeah', 'uh-huh'],
  eot_fillers: ['um', 'uh'],
  next_step_markers: ['next', 'then', 'finally'],
});

describe('splitReplySentences', () => {
  it('splits on CJK and Latin terminators, keeping them attached', () => {
    expect(splitReplySentences('うん。そこだと思う！説明します。')).toEqual([
      'うん。',
      'そこだと思う！',
      '説明します。',
    ]);
    expect(splitReplySentences('Yes. That works! Great.')).toEqual([
      'Yes.',
      'That works!',
      'Great.',
    ]);
  });

  it('keeps unterminated tails and skips empty input', () => {
    expect(splitReplySentences('まだ途中')).toEqual(['まだ途中']);
    expect(splitReplySentences('   ')).toEqual([]);
  });
});

describe('segmentReplyStructure', () => {
  it('labels reaction → claim → explanation → next for Japanese', () => {
    const segments = segmentReplyStructure(
      'うん。問題は待機時間だよ。LLMが遅いんじゃなくて、待ってるのが原因なんだ。次はエンジン側を直す。',
      ja
    );
    expect(segments.map((s) => s.kind)).toEqual(['reaction', 'claim', 'explanation', 'next']);
  });

  it('labels English replies the same way', () => {
    const segments = segmentReplyStructure(
      'Got it. The issue is waiting, not speed. We block on the LLM. Next we fix the engine.',
      en
    );
    expect(segments.map((s) => s.kind)).toEqual(['reaction', 'claim', 'explanation', 'next']);
  });

  it('falls back to claim-first when there is no acknowledgement', () => {
    const segments = segmentReplyStructure('答えは42です。詳しく説明します。', ja);
    expect(segments.map((s) => s.kind)).toEqual(['claim', 'explanation']);
  });

  it('returns an empty list for empty replies', () => {
    expect(segmentReplyStructure('', ja)).toEqual([]);
    expect(segmentReplyStructure('  ', ja)).toEqual([]);
  });
});

describe('ReplySegmentLabeler', () => {
  it('labels streamed segments positionally', () => {
    const labeler = new ReplySegmentLabeler(ja);
    expect(labeler.label('うん')).toBe('reaction');
    expect(labeler.label('そこだと思う')).toBe('claim');
    expect(labeler.label('理由はLLM待ちだから')).toBe('explanation');
    expect(labeler.label('では最後にまとめる')).toBe('next');
  });

  it('treats the first non-reaction segment as the claim', () => {
    const labeler = new ReplySegmentLabeler(en);
    expect(labeler.label('The answer is 42')).toBe('claim');
    expect(labeler.label('because reasons')).toBe('explanation');
  });
});

describe('segment classification', () => {
  it('normalizes case, punctuation and width for marker checks', () => {
    expect(isReactionLike('うん。', ja)).toBe(true);
    expect(isReactionLike('Got it!', en)).toBe(true);
    expect(isReactionLike('説明します。', ja)).toBe(false);
    expect(isNextStepLike('Next we ship it.', en)).toBe(true);
    expect(isNextStepLike('次は修正します。', ja)).toBe(true);
    expect(isNextStepLike('普通の文。', ja)).toBe(false);
  });
});
