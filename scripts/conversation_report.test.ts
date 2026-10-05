import { describe, expect, it } from 'vitest';
import type { ConversationSignalSummary } from '@agent/core/intent/conversation-signals';
import { formatConversationReport, runConversationReport } from './conversation_report.js';

const empty: ConversationSignalSummary = {
  total: 0,
  by_kind: {},
  by_intent: [],
  clarification: { asked: 0, abandoned: 0, abandon_rate: null },
  miss_clusters: [],
};

describe('conversation_report', () => {
  it('says so when nothing was recorded', () => {
    expect(formatConversationReport(empty, 14)).toContain('No conversation signals recorded');
  });

  it('lists intents needing attention, the unanswered rate and repeated misses', () => {
    const text = formatConversationReport(
      {
        total: 9,
        by_kind: { turn_failed: 3, route_unrecognized: 2, clarification_asked: 4 },
        by_intent: [
          {
            intent_id: 'schedule-read-agenda',
            turns: 5,
            succeeded: 2,
            failed: 3,
            unhandled: 0,
            dissatisfied: 1,
            clarification_asked: 4,
            clarification_abandoned: 2,
          },
          {
            intent_id: 'quiet',
            turns: 4,
            succeeded: 4,
            failed: 0,
            unhandled: 0,
            dissatisfied: 0,
            clarification_asked: 0,
            clarification_abandoned: 0,
          },
        ],
        clarification: { asked: 4, abandoned: 2, abandon_rate: 0.5 },
        miss_clusters: [
          {
            utterance_hash: 'aaaaaaaaaaaaaaaa',
            count: 3,
            kinds: ['route_unrecognized'],
            excerpt: 'いつもの資料を出して',
            first_seen: '2026-10-01T00:00:00Z',
            last_seen: '2026-10-04T00:00:00Z',
          },
          {
            utterance_hash: 'bbbbbbbbbbbbbbbb',
            count: 1,
            kinds: ['turn_failed'],
            excerpt: 'once only',
            first_seen: '2026-10-01T00:00:00Z',
            last_seen: '2026-10-01T00:00:00Z',
          },
        ],
      },
      7
    );
    expect(text).toContain('last 7 day(s), 9 signal(s)');
    expect(text).toContain('Clarification: 4 asked, 2 unanswered after 24 h (50%)');
    expect(text).toContain('schedule-read-agenda: 5 turn(s), failed 3');
    expect(text).not.toContain('quiet:');
    expect(text).toContain('x3 [route_unrecognized] いつもの資料を出して');
    expect(text).not.toContain('once only');
  });

  it('rejects a bad --days before reading the ledger', async () => {
    process.exitCode = undefined;
    try {
      expect(await runConversationReport(['--days', '0'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = undefined;
    }
  });
});
