import { describe, expect, it } from 'vitest';
import {
  parseConciergeHygieneResponse,
  parseConciergeMemoryQueueResponse,
  parseConciergeResponseStatusResponse,
} from './concierge-advisory-response';

const responseStatus = {
  ok: true,
  response_status: {
    state: 'waiting',
    label: 'Waiting',
    next_action: 'Review the result',
    active_count: 1,
    queued_count: 0,
    stale_child_count: 0,
    active_tasks: [{ delegation_id: 'delegation-1', elapsed_seconds: 3 }],
  },
};

describe('concierge advisory response boundaries', () => {
  it('accepts response status and optional task identity fields', () => {
    expect(parseConciergeResponseStatusResponse(responseStatus)).toEqual(
      responseStatus.response_status
    );
  });

  it('accepts hygiene and memory queue records', () => {
    expect(
      parseConciergeHygieneResponse({
        ok: true,
        inquiries: [
          {
            mission_id: 'mission-1',
            title: 'Needs review',
            reason: 'awaiting_gate',
            age_days: null,
          },
        ],
      })
    ).toHaveLength(1);
    expect(
      parseConciergeMemoryQueueResponse({
        ok: true,
        candidates: [
          {
            id: 'candidate-1',
            kind: 'heuristic',
            summary: 'A useful pattern',
            source: 'mission-1',
            source_type: 'mission',
            sensitivity_tier: 'confidential',
            occurrences: 1,
            queued_at: '2026-09-04T00:00:00Z',
          },
        ],
      })
    ).toHaveLength(1);
  });

  it('rejects invalid envelopes, records, and dangerous keys', () => {
    expect(parseConciergeResponseStatusResponse({ ok: true, response_status: {} })).toBeUndefined();
    expect(
      parseConciergeHygieneResponse({
        ok: true,
        inquiries: [{ mission_id: 'mission-1', reason: 'unknown' }],
      })
    ).toBeUndefined();
    const unsafe = JSON.parse(
      '{"ok":true,"candidates":[{"id":"candidate-1","kind":"heuristic","summary":"x","source":"m","source_type":"mission","sensitivity_tier":"confidential","occurrences":1,"queued_at":"2026-09-04T00:00:00Z","constructor":{}}]}'
    );
    expect(parseConciergeMemoryQueueResponse(unsafe)).toBeUndefined();
  });
});
