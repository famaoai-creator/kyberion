import { describe, expect, it } from 'vitest';
import { parseConciergeSummaryEvent, parseConciergeSummaryValue } from '../src/lib/summary-event';

const VALID_SUMMARY = {
  generated_at: '2026-09-04T00:00:00.000Z',
  briefing: {
    sentence_ja: '状況を確認しました',
    counts: { active_missions: 1, pending_approvals: 0, unread_outcomes: 0, exceptions: 0 },
  },
  intent_inbox: [],
  approval_queue: [],
  outcome_feed: [],
  exception_feed: [],
};

describe('concierge summary event boundary', () => {
  it('parses a shape-valid SSE summary', () => {
    expect(parseConciergeSummaryEvent(JSON.stringify(VALID_SUMMARY))).toEqual(VALID_SUMMARY);
  });

  it('parses a shape-valid initial HTTP summary payload', () => {
    expect(parseConciergeSummaryValue(VALID_SUMMARY)).toEqual(VALID_SUMMARY);
  });

  it.each([
    null,
    [],
    { ...VALID_SUMMARY, briefing: [] },
    { ...VALID_SUMMARY, briefing: { ...VALID_SUMMARY.briefing, counts: [] } },
    {
      ...VALID_SUMMARY,
      intent_inbox: [
        { mission_id: 'mission-1', title: '作業', status_ja: '実行中', attention_needed: 'yes' },
      ],
    },
    {
      ...VALID_SUMMARY,
      briefing: {
        ...VALID_SUMMARY.briefing,
        counts: { ...VALID_SUMMARY.briefing.counts, exceptions: -1 },
      },
    },
    { ...VALID_SUMMARY, intent_inbox: [{ mission_id: 42 }] },
    {
      ...VALID_SUMMARY,
      outcome_feed: [{ entry_id: 'outcome-1', artifact_paths: ['ok', 42] }],
    },
  ])('rejects malformed SSE summary: %p', (value) => {
    expect(parseConciergeSummaryEvent(JSON.stringify(value))).toBeNull();
  });

  it('keeps the last snapshot for malformed JSON text', () => {
    expect(parseConciergeSummaryEvent('{malformed')).toBeNull();
  });
});
