import { describe, expect, it } from 'vitest';
import {
  MEET_IN_MEETING_SELECTORS,
  TEAMS_IN_MEETING_SELECTORS,
  ZOOM_IN_MEETING_SELECTORS,
  inMeetingSelectorsForPlatform,
} from './selectors.js';
import { diffCaptionLines, formatTranscriptCues, parseCaptionLine } from './caption-capture.js';

describe('caption-capture', () => {
  it('splits speaker lines on half- and full-width colons', () => {
    expect(parseCaptionLine('Alice: ship it')).toEqual({ speaker: 'Alice', text: 'ship it' });
    expect(parseCaptionLine('田中：予算確定')).toEqual({ speaker: '田中', text: '予算確定' });
    expect(parseCaptionLine('no speaker here')).toEqual({ speaker: '', text: 'no speaker here' });
  });

  it('keeps only unseen lines in poll order', () => {
    expect(diffCaptionLines(['a', 'b'], ['b', 'c', 'a', 'd'])).toEqual(['c', 'd']);
    expect(diffCaptionLines([], ['', '  '])).toEqual([]);
  });

  it('renders cues in normalize_transcript-compatible shape', () => {
    const text = formatTranscriptCues([
      { tSec: 5, speaker: 'Alice', text: 'hi' },
      { tSec: 65, speaker: '', text: 'caption' },
    ]);
    expect(text).toBe('[00:05] Alice: hi\n[01:05] Unknown: caption');
  });
});

describe('in-meeting selectors', () => {
  it('provides caption toggle and container selectors per platform', () => {
    for (const table of [
      MEET_IN_MEETING_SELECTORS,
      ZOOM_IN_MEETING_SELECTORS,
      TEAMS_IN_MEETING_SELECTORS,
    ]) {
      expect(table.captions_toggle.length).toBeGreaterThan(0);
      expect(table.captions_container.length).toBeGreaterThan(0);
    }
  });

  it('resolves tables per platform with a Meet default', () => {
    expect(inMeetingSelectorsForPlatform('zoom')).toBe(ZOOM_IN_MEETING_SELECTORS);
    expect(inMeetingSelectorsForPlatform('teams')).toBe(TEAMS_IN_MEETING_SELECTORS);
    expect(inMeetingSelectorsForPlatform('meet')).toBe(MEET_IN_MEETING_SELECTORS);
    expect(inMeetingSelectorsForPlatform('auto')).toBe(MEET_IN_MEETING_SELECTORS);
  });
});
