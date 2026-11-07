import { describe, expect, it } from 'vitest';
import {
  AdvisoryPolicyViolation,
  BoundedLineConsumer,
  BoundedRingBuffer,
  CE_PRESSURE_THRESHOLDS,
  TtlLruMap,
  areCeValuesEquivalent,
  assertAdvisoryEvent,
  buildAgentTrackRecords,
  classifyOrphanRun,
  composeOfficeSnapshot,
  deriveAccentPalette,
  deriveProviderPressure,
} from './ce-adoption.js';

describe('CE adoption contracts', () => {
  it('preserves state identity for equivalent snapshots', () => {
    const previous = { missions: [{ id: 'm1', status: 'working' }] };
    expect(areCeValuesEquivalent(previous, { missions: [{ id: 'm1', status: 'working' }] })).toBe(
      true
    );
    expect(areCeValuesEquivalent(previous, { missions: [{ id: 'm1', status: 'blocked' }] })).toBe(
      false
    );
  });

  it('coalesces bounded buffers and sheds the oldest value', () => {
    const buffer = new BoundedRingBuffer<number>(2);
    buffer.pushMany([1, 2, 3]);
    expect(buffer.toArray()).toEqual([2, 3]);
    const consumer = new BoundedLineConsumer<{ id: number }>(
      (line) => {
        try {
          return JSON.parse(line) as { id: number };
        } catch {
          return null;
        }
      },
      'event',
      2
    );
    expect(consumer.consume('{"id":1,"kind":"event"}\n{"id":2,"kind":"event"}\n')).toHaveLength(2);
    expect(consumer.consume('{"id":3,"kind":"event"')).toEqual([]);
    expect(consumer.consume('}\n')).toEqual([{ id: 3, kind: 'event' }]);
    expect(consumer.items.toArray()).toHaveLength(2);
  });

  it('expires TTL entries and exposes the CE pressure ladder', () => {
    let now = 0;
    const map = new TtlLruMap<string, string>(100, 2, () => now);
    map.set('a', 'one');
    now = 101;
    expect(map.get('a')).toBeUndefined();
    expect(deriveProviderPressure({ quotaUsed: 6, quotaLimit: 10 }).severity).toBe('watch');
    expect(deriveProviderPressure({ quotaUsed: 8, quotaLimit: 10 }).severity).toBe('elevated');
    expect(deriveProviderPressure({ demoted: true }).value).toBe(CE_PRESSURE_THRESHOLDS.saturated);
  });

  it('shares office, history, theme, advisory, and orphan projections', () => {
    const office = composeOfficeSnapshot({
      agents: [
        { agent_id: 'claude', status: 'working', mission_id: 'm1' },
        { agent_id: 'codex', status: 'blocked', mission_id: 'm1' },
      ],
      now: '2026-08-02T00:00:00.000Z',
    });
    expect(office.rooms[0].agents).toHaveLength(2);
    expect(office.attention.map((entry) => entry.agent_id)).toEqual(['codex']);

    expect(
      buildAgentTrackRecords([
        { assignee_peer_id: 'claude', status: 'done', attempts: [{ status: 'completed' }] },
      ])[0]
    ).toMatchObject({ agent_id: 'claude', completed_tasks: 1, rank: 'bronze' });

    const palette = deriveAccentPalette('#3366cc', 0.5);
    expect(palette.text).toMatch(/^#/);
    expect(() => assertAdvisoryEvent({ type: 'tool_use' }, true)).toThrow(AdvisoryPolicyViolation);
    expect(() => assertAdvisoryEvent({ type: 'text' }, true)).not.toThrow();
    expect(classifyOrphanRun({ completedEvidence: true })).toBe('replay_complete');
    expect(classifyOrphanRun({ pidAlive: false, recentLog: false })).toBe('park');
  });
});
