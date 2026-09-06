import { describe, expect, it } from 'vitest';
import { normalizeTranscriptText } from './transcript-normalize.js';

const VTT = `WEBVTT

00:00.000 --> 00:05.000
<v Alice>Decided to ship on Friday</v>

00:05.000 --> 00:09.000
<v Alice>Bob will handle the release notes</v>

00:09.000 --> 00:12.000
Bob: Got it, due Thursday
`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Ichimura: Let's start the review

2
00:00:05,000 --> 00:00:08,000
Famao：予算は来週確定します
`;

describe('normalizeTranscriptText', () => {
  it('parses WebVTT cues with speaker merge', () => {
    const result = normalizeTranscriptText(VTT, {}, 'meeting.vtt');
    expect(result.format).toBe('vtt');
    expect(result.cueCount).toBe(2);
    expect(result.speakers).toEqual(['Alice', 'Bob']);
    expect(result.transcript).toContain(
      '[00:00] Alice: Decided to ship on Friday Bob will handle the release notes'
    );
    expect(result.transcript).toContain('[00:09] Bob: Got it, due Thursday');
  });

  it('parses SRT cues including full-width colon speakers', () => {
    const result = normalizeTranscriptText(SRT, {}, 'meeting.srt');
    expect(result.format).toBe('srt');
    expect(result.cueCount).toBe(2);
    expect(result.transcript).toContain("Ichimura: Let's start the review");
    expect(result.transcript).toContain('Famao: 予算は来週確定します');
  });

  it('sniffs VTT content without an extension', () => {
    const result = normalizeTranscriptText(VTT, {}, 'download.txt');
    expect(result.format).toBe('vtt');
    expect(result.cueCount).toBe(2);
  });

  it('passes plain text through untouched', () => {
    const result = normalizeTranscriptText('line one\nline two\n', {}, 'notes.md');
    expect(result.format).toBe('text');
    expect(result.cueCount).toBe(0);
    expect(result.transcript).toBe('line one\nline two');
  });

  it('resolves speaker aliases and attendee names', () => {
    const result = normalizeTranscriptText(VTT, {
      attendees: [{ name: 'Alice Smith' }, 'Bob'],
      speakerAliases: { alice: 'Alice Smith' },
    });
    expect(result.speakers).toContain('Alice Smith');
    expect(result.transcript).toContain('[00:00] Alice Smith:');
  });

  it('labels speaker-less cues as Unknown', () => {
    const raw = `WEBVTT\n\n00:00.000 --> 00:02.000\nJust a caption line\n`;
    const result = normalizeTranscriptText(raw, {}, 'cap.vtt');
    expect(result.transcript).toContain('Unknown: Just a caption line');
  });
});
