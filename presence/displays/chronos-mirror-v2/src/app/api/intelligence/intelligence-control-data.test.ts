import { describe, expect, it } from 'vitest';
import { parseControlEventLine, parseControlEventRecord } from './intelligence-control-data';

describe('intelligence control event parser', () => {
  it('keeps typed control event fields and payload values', () => {
    const event = parseControlEventLine(
      JSON.stringify({
        ts: '2099-01-01T00:00:00.000Z',
        decision: 'mission_orchestration_event_enqueued',
        event_type: 'surface_control_requested',
        event_id: 'event-1',
        requested_by: 'human:operator',
        payload: {
          surfaceId: 'chronos',
          operation: 'restart',
        },
      })
    );

    expect(event).toMatchObject({
      ts: '2099-01-01T00:00:00.000Z',
      decision: 'mission_orchestration_event_enqueued',
      payload: { surfaceId: 'chronos', operation: 'restart' },
    });
  });

  it('rejects malformed timestamp, field, payload, and dangerous-key shapes', () => {
    const base = {
      ts: '2099-01-01T00:00:00.000Z',
      decision: 'mission_control_action_applied',
    };

    expect(parseControlEventLine(JSON.stringify({ ...base, ts: 'not-a-date' }))).toBeNull();
    expect(parseControlEventLine(JSON.stringify({ ...base, operation: ['restart'] }))).toBeNull();
    expect(
      parseControlEventLine(
        JSON.stringify({ ...base, payload: { operation: { value: 'restart' } } })
      )
    ).toBeNull();
    expect(
      parseControlEventLine(
        '{"ts":"2099-01-01T00:00:00.000Z","decision":"event","payload":{"__proto__":{}}}'
      )
    ).toBeNull();
  });

  it('validates already-parsed JSONL records through the same control boundary', () => {
    expect(
      parseControlEventRecord({
        ts: '2099-01-01T00:00:00.000Z',
        decision: 'mission_control_action_applied',
      })
    ).toMatchObject({ decision: 'mission_control_action_applied' });
    expect(parseControlEventRecord(null)).toBeNull();
    expect(parseControlEventRecord(['not-an-event'])).toBeNull();
  });
});
