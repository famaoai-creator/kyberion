import { describe, expect, it } from 'vitest';
import { parseVtt, parseVttTimestamp } from './vtt-parser.js';

describe('parseVttTimestamp', () => {
  it('accepts hour-less and hour forms and comma millis', () => {
    expect(parseVttTimestamp('00:01.500')).toBe(1.5);
    expect(parseVttTimestamp('01:02:03.004')).toBeCloseTo(3723.004, 6);
    expect(parseVttTimestamp('00:00:02,250')).toBe(2.25);
    expect(parseVttTimestamp('nope')).toBeNull();
  });
});

describe('parseVtt', () => {
  it('parses plain cues, skipping header, NOTE blocks and cue settings', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      '',
      'NOTE a comment',
      '',
      '1',
      '00:00:00.000 --> 00:00:02.000 align:start position:0%',
      'Hello &amp; welcome',
      '',
      '00:00:02.000 --> 00:00:04.500',
      '<v Speaker>Second</v> line',
      '',
    ].join('\r\n');
    expect(parseVtt(vtt)).toEqual([
      { start_sec: 0, end_sec: 2, text: 'Hello & welcome' },
      { start_sec: 2, end_sec: 4.5, text: 'Second line' },
    ]);
  });

  it('dedupes rolling auto-caption lines so each spoken line appears once', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'hello<00:00:00.500><c> there</c>',
      '',
      '00:00:02.000 --> 00:00:02.010',
      'hello there',
      '',
      '00:00:02.010 --> 00:00:04.000',
      'hello there',
      'how<00:00:02.600><c> are</c><00:00:03.000><c> you</c>',
      '',
      '00:00:04.000 --> 00:00:04.010',
      'how are you',
      '',
      '00:00:04.010 --> 00:00:06.000',
      'how are you',
      'fine thanks',
      '',
    ].join('\n');
    expect(parseVtt(vtt, { dedupeRolling: true })).toEqual([
      { start_sec: 0, end_sec: 2.01, text: 'hello there' },
      { start_sec: 2.01, end_sec: 4.01, text: 'how are you' },
      { start_sec: 4.01, end_sec: 6, text: 'fine thanks' },
    ]);
  });

  it('keeps a legitimately repeated line when it is not a rolling prefix', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'yes',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'no',
      '',
      '00:00:02.000 --> 00:00:03.000',
      'yes',
      '',
    ].join('\n');
    expect(parseVtt(vtt, { dedupeRolling: true }).map((segment) => segment.text)).toEqual([
      'yes',
      'no',
      'yes',
    ]);
  });

  it('keeps genuine consecutive repeats in manual subtitles (no rolling dedupe)', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'Go!',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Go!',
      '',
      '00:00:02.000 --> 00:00:03.000',
      'Go!',
      'Now run',
      '',
    ].join('\n');
    expect(parseVtt(vtt).map((segment) => segment.text)).toEqual(['Go!', 'Go!', 'Go! Now run']);
    expect(parseVtt(vtt, { dedupeRolling: true }).map((segment) => segment.text)).toEqual([
      'Go!',
      'Now run',
    ]);
  });
});
