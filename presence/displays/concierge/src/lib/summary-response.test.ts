import { describe, expect, it } from 'vitest';
import { parseConciergeSummaryResponse } from './summary-event';

const summary = {
  generated_at: '2026-09-04T00:00:00Z',
  briefing: {
    sentence_ja: '処理中です',
    counts: { active_missions: 0, pending_approvals: 0, unread_outcomes: 0, exceptions: 0 },
  },
  intent_inbox: [],
  approval_queue: [],
  outcome_feed: [],
  exception_feed: [],
};

describe('concierge summary response boundary', () => {
  it('accepts the HTTP summary envelope', () => {
    expect(parseConciergeSummaryResponse({ ok: true, summary })).toEqual(summary);
  });

  it('rejects invalid envelope status and summary shape', () => {
    expect(parseConciergeSummaryResponse({ ok: false, summary })).toBeNull();
    expect(
      parseConciergeSummaryResponse({ ok: true, summary: { ...summary, briefing: [] } })
    ).toBeNull();
  });

  it('rejects dangerous keys in nested summary data', () => {
    const unsafe = JSON.parse(
      '{"ok":true,"summary":{"generated_at":"2026-09-04T00:00:00Z","briefing":{"sentence_ja":"x","counts":{"active_missions":0,"pending_approvals":0,"unread_outcomes":0,"exceptions":0}},"intent_inbox":[],"approval_queue":[],"outcome_feed":[],"exception_feed":[],"constructor":{}}}'
    );
    expect(parseConciergeSummaryResponse(unsafe)).toBeNull();
  });
});
