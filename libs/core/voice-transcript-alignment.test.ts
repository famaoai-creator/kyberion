import { describe, expect, it } from 'vitest';
import { splitVoicePrompt, verifyVoiceTranscript } from './voice-transcript-alignment.js';

describe('voice-transcript-alignment', () => {
  it('splits a prompt into repairable sentence segments', () => {
    expect(splitVoicePrompt('最初です。次の文章です。')).toEqual([
      { segment_id: 'segment-01', text: '最初です。' },
      { segment_id: 'segment-02', text: '次の文章です。' },
    ]);
  });

  it('accepts punctuation and Japanese numeral differences from STT', () => {
    const result = verifyVoiceTranscript(
      '本日の天気は晴れです。気温は二十五度です。',
      '本日の天気は晴れです 気温は25度です',
    );

    expect(result.status).toBe('passed');
    expect(result.mismatches).toEqual([]);
  });

  it('returns only the missing sentence as a repair target', () => {
    const result = verifyVoiceTranscript(
      'こんにちは。これは音声サンプルです。よろしくお願いします。',
      'こんにちは。音声サンプルです。',
    );

    expect(result.status).toBe('needs_repair');
    expect(result.mismatches).toEqual([
      { segment_id: 'segment-02', text: 'これは音声サンプルです。', reason: 'not_found_in_transcript' },
      { segment_id: 'segment-03', text: 'よろしくお願いします。', reason: 'not_found_in_transcript' },
    ]);
  });

  it('keeps a timestamped replacement window even when one sentence has a small ASR difference', () => {
    const result = verifyVoiceTranscript(
      '最初の文章です。二番目の文章です。',
      '最初の文章です。二番目の文です。',
      [
        { start_sec: 0, end_sec: 1.2, text: '最初の文章です。' },
        { start_sec: 1.2, end_sec: 2.4, text: '二番目の文です。' },
      ],
    );

    expect(result.segment_matches).toHaveLength(2);
    expect(result.segment_matches[1]).toEqual(
      expect.objectContaining({ start_sec: 1.2, end_sec: 2.4, match_kind: 'fuzzy' }),
    );
    expect(result.status).toBe('passed');
  });
});
