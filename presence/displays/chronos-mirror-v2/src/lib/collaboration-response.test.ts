import { describe, expect, it } from 'vitest';
import { parseCollaborationResponse } from './collaboration-response';

const projection = {
  revision: 42,
  generated_at: '2026-09-04T00:00:00.000Z',
  partial: false,
  status_flags: ['stale_runtime'],
  sequence_gaps: [{ source: 'runtime', previous_seq: 1, expected_seq: 2, actual_seq: 3 }],
  overview: {
    events: 1,
    missions: 1,
    tasks: 1,
    agents: 1,
    active: 1,
    blocked: 0,
    waiting_human: 0,
    review_pending: 0,
    failures: 0,
    native_subagents: 1,
    unavailable_subagents: 0,
  },
  events: [
    {
      event_id: 'event-1',
      ts: '2026-09-04T00:00:00.000Z',
      kind: 'handoff',
      summary: 'handoff recorded',
      source: 'runtime',
      evidence_refs: ['trace-1'],
      native: true,
      effort: 'medium',
    },
  ],
  edges: [{ from: 'agent-a', to: 'agent-b', kind: 'handoff', event_id: 'event-1' }],
  attention: [
    {
      event_id: 'event-1',
      kind: 'handoff',
      title: 'Review handoff',
      reason: 'review is pending',
      next_action: 'open trace',
      mission_id: 'MSN-1',
    },
  ],
};

describe('collaboration response boundary', () => {
  it('accepts the projection fields consumed by the collaboration board', () => {
    expect(parseCollaborationResponse({ ok: true, projection })).toEqual(projection);
  });

  it('rejects an unsuccessful or incomplete response before state update', () => {
    expect(parseCollaborationResponse({ ok: false, projection })).toBeUndefined();
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, overview: { ...projection.overview, failures: '0' } },
      })
    ).toBeUndefined();
  });

  it('rejects unsafe nested keys and invalid enum values', () => {
    const unsafe = JSON.parse(
      '{"event_id":"event-1","ts":"2026-09-04T00:00:00.000Z","kind":"handoff","summary":"handoff recorded","source":"runtime","__proto__":"bad"}'
    );
    expect(
      parseCollaborationResponse({ ok: true, projection: { ...projection, events: [unsafe] } })
    ).toBeUndefined();
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, status_flags: ['unexpected'] },
      })
    ).toBeUndefined();
    expect(
      parseCollaborationResponse({
        ok: true,
        projection: { ...projection, events: [{ ...projection.events[0], effort: 'extreme' }] },
      })
    ).toBeUndefined();
  });
});
