// FD-02: `buildHomePayload` (presence-studio home page read model).
// Pure, no I/O — see `home.ts` for the documented data-source gaps this
// surface has (no `exception`/`stalled` decide source, no numeric task
// session progress).
import { describe, expect, it } from 'vitest';
import {
  buildHomePayload,
  estimateTaskSessionPercent,
  type HomeArtifactInput,
  type HomeDecideCandidateInput,
  type HomeTaskSessionInput,
} from './home.js';

const NOW = new Date('2026-09-13T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('buildHomePayload', () => {
  it('returns zero counts and empty arrays for empty inputs', () => {
    const payload = buildHomePayload({
      now: NOW,
      approvals: [],
      heldActions: [],
      taskSessions: [],
      artifacts: [],
    });

    expect(payload).toEqual({
      ok: true,
      date: '2026-09-13',
      counts: { decide: 0, progress: 0, delivered: 0 },
      decide: [],
      progress: [],
    });
  });

  it('merges approvals and held actions into approval decide items, oldest first', () => {
    const approvals: HomeDecideCandidateInput[] = [
      { id: 'appr-new', title: 'Newer approval', when: hoursAgo(1) },
    ];
    const heldActions: HomeDecideCandidateInput[] = [
      { id: 'held-old', title: 'Older held action', when: hoursAgo(48) },
    ];

    const payload = buildHomePayload({
      now: NOW,
      approvals,
      heldActions,
      taskSessions: [],
      artifacts: [],
    });

    expect(payload.counts.decide).toBe(2);
    expect(payload.decide.map((item) => item.id)).toEqual(['held-old', 'appr-new']);
    expect(payload.decide.every((item) => item.kind === 'approval')).toBe(true);
    expect(payload.decide.every((item) => item.href_hint === 'decide')).toBe(true);
  });

  it('caps the decide list at 3 while counting every pending item', () => {
    const approvals: HomeDecideCandidateInput[] = Array.from({ length: 5 }, (_, index) => ({
      id: `appr-${index}`,
      title: `Approval ${index}`,
      when: hoursAgo(index + 1),
    }));

    const payload = buildHomePayload({
      now: NOW,
      approvals,
      heldActions: [],
      taskSessions: [],
      artifacts: [],
    });

    expect(payload.counts.decide).toBe(5);
    expect(payload.decide).toHaveLength(3);
    // Oldest (largest hoursAgo) sorts first.
    expect(payload.decide.map((item) => item.id)).toEqual(['appr-4', 'appr-3', 'appr-2']);
  });

  it('classifies non-terminal task sessions as in_progress and artifacts as delivered', () => {
    const taskSessions: HomeTaskSessionInput[] = [
      { id: 'ts-active', title: 'Draft the deck', status: 'executing', when: hoursAgo(1) },
      { id: 'ts-done', title: 'Finished thing', status: 'completed', when: hoursAgo(2) },
      { id: 'ts-failed', title: 'Failed thing', status: 'failed', when: hoursAgo(3) },
    ];
    const artifacts: HomeArtifactInput[] = [
      { id: 'art-1', title: 'quarterly-report.pdf', when: hoursAgo(1) },
    ];

    const payload = buildHomePayload({
      now: NOW,
      approvals: [],
      heldActions: [],
      taskSessions,
      artifacts,
    });

    expect(payload.counts.progress).toBe(1);
    expect(payload.counts.delivered).toBe(1);
    const kinds = payload.progress.map((item) => ({ id: item.id, kind: item.kind }));
    expect(kinds).toEqual([
      { id: 'ts-active', kind: 'in_progress' },
      { id: 'art-1', kind: 'delivered' },
    ]);
    expect(payload.progress.find((item) => item.id === 'ts-active')?.href_hint).toBe('work');
    expect(payload.progress.find((item) => item.id === 'art-1')?.href_hint).toBe('outcome');
  });

  it('caps the combined progress list at 4 rows, in-progress before delivered', () => {
    const taskSessions: HomeTaskSessionInput[] = Array.from({ length: 3 }, (_, index) => ({
      id: `ts-${index}`,
      title: `Session ${index}`,
      status: 'executing',
      when: hoursAgo(index + 1),
    }));
    const artifacts: HomeArtifactInput[] = Array.from({ length: 3 }, (_, index) => ({
      id: `art-${index}`,
      title: `Artifact ${index}`,
      when: hoursAgo(index + 1),
    }));

    const payload = buildHomePayload({
      now: NOW,
      approvals: [],
      heldActions: [],
      taskSessions,
      artifacts,
    });

    expect(payload.counts.progress).toBe(3);
    expect(payload.counts.delivered).toBe(3);
    expect(payload.progress).toHaveLength(4);
    expect(payload.progress.map((item) => item.kind)).toEqual([
      'in_progress',
      'in_progress',
      'in_progress',
      'delivered',
    ]);
  });

  it('attaches a status-derived percent to known in-progress statuses and omits it otherwise', () => {
    expect(estimateTaskSessionPercent('executing')).toBe(65);
    expect(estimateTaskSessionPercent('blocked')).toBeUndefined();

    const payload = buildHomePayload({
      now: NOW,
      approvals: [],
      heldActions: [],
      taskSessions: [
        { id: 'ts-known', title: 'Known', status: 'executing', when: hoursAgo(1) },
        { id: 'ts-unknown', title: 'Unknown', status: 'blocked', when: hoursAgo(2) },
      ],
      artifacts: [],
    });

    expect(payload.progress.find((item) => item.id === 'ts-known')?.percent).toBe(65);
    expect(payload.progress.find((item) => item.id === 'ts-unknown')?.percent).toBeUndefined();
  });
});
