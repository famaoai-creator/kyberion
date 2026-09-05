import { describe, expect, it } from 'vitest';
import {
  parseDashboardJsonRecord,
  parseDashboardOrchestrationEvent,
  parseDashboardOwnerSummary,
} from './dashboard-event-parser.js';

describe('dashboard event parser', () => {
  it('accepts orchestration events and normalizes fallback values', () => {
    expect(
      parseDashboardOrchestrationEvent({ event_type: 'handoff', mission_id: 'MSN-1' })
    ).toEqual(expect.objectContaining({ decision: 'handoff', mission: 'MSN-1' }));
  });

  it('accepts owner summaries with non-negative integer counts', () => {
    expect(
      parseDashboardOwnerSummary({
        decision: 'mission_owner_notified',
        ts: '2026-09-01T00:00:00.000Z',
        mission_id: 'MSN-1',
        accepted_count: 1,
      })
    ).toMatchObject({ mission_id: 'MSN-1', accepted_count: 1, reviewed_count: 0 });
  });

  it.each([
    ['malformed line', '{'],
    ['array root', '[]'],
    ['primitive root', '"event"'],
  ])('rejects %s', (_, line) => {
    expect(parseDashboardJsonRecord(line)).toBeUndefined();
  });

  it('rejects invalid event and owner summary fields', () => {
    expect(parseDashboardOrchestrationEvent({ ts: 'not-a-date', decision: 42 })).toBeUndefined();
    expect(
      parseDashboardOwnerSummary({
        decision: 'mission_owner_notified',
        ts: '2026-09-01T00:00:00.000Z',
        mission_id: 'MSN-1',
        completed_count: -1,
      })
    ).toBeUndefined();
  });
});
