// FD-05: `buildProgressPayload` / `buildProgressDetail` (presence-studio
// "進み具合" page read models). Pure, no I/O — see `progress.ts` for the
// documented artifact-record vs deliverable-inbox store gap this surface has.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/surface/surface-url', () => ({ resolveSurfaceBrowserUrl: vi.fn() }));
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import {
  resolveComputerSurfaceMirrorHref,
  buildProgressDetail,
  buildProgressPayload,
  estimateTaskSessionPercent,
  type ProgressArtifactInput,
  type ProgressHistoryEntryInput,
  type ProgressTaskSessionInput,
} from './progress.js';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const MIRROR_HREF = 'http://127.0.0.1:3040/';

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('buildProgressPayload', () => {
  it('returns zero counts and empty arrays for empty inputs', () => {
    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [],
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });

    expect(payload).toEqual({
      ok: true,
      counts: { active: 0, delivered: 0, done: 0 },
      active: [],
      delivered: [],
      done: [],
      mirror_href: MIRROR_HREF,
    });
  });

  it('orders active task sessions newest-updated first and marks the first as selected_default', () => {
    const taskSessions: ProgressTaskSessionInput[] = [
      { id: 'ts-old', title: 'Older work', status: 'executing', when: hoursAgo(5) },
      { id: 'ts-new', title: 'Newer work', status: 'planning', when: hoursAgo(1) },
    ];

    const payload = buildProgressPayload({
      now: NOW,
      taskSessions,
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });

    expect(payload.counts.active).toBe(2);
    expect(payload.active.map((item) => item.id)).toEqual(['ts-new', 'ts-old']);
    expect(payload.active[0].selected_default).toBe(true);
    expect(payload.active[1].selected_default).toBeUndefined();
  });

  it('derives "now" from the latest non-empty history entry, falling back to status', () => {
    const taskSessions: ProgressTaskSessionInput[] = [
      {
        id: 'ts-with-history',
        title: 'Has history',
        status: 'executing',
        history: [
          { when: hoursAgo(2), text: 'Started drafting the outline.' },
          { when: hoursAgo(1), text: 'Reviewing the second section.' },
        ],
      },
      { id: 'ts-no-history', title: 'No history', status: 'planning', history: [] },
    ];

    const payload = buildProgressPayload({
      now: NOW,
      taskSessions,
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });

    expect(payload.active.find((item) => item.id === 'ts-with-history')?.now).toBe(
      'Reviewing the second section.'
    );
    expect(payload.active.find((item) => item.id === 'ts-no-history')?.now).toBe('planning');
  });

  it('attaches a status-derived percent to known statuses and omits it otherwise', () => {
    expect(estimateTaskSessionPercent('executing')).toBe(65);
    expect(estimateTaskSessionPercent('blocked')).toBeUndefined();

    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [
        { id: 'ts-known', title: 'Known', status: 'executing' },
        { id: 'ts-unknown', title: 'Unknown', status: 'blocked' },
      ],
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });

    expect(payload.active.find((item) => item.id === 'ts-known')?.percent).toBe(65);
    expect(payload.active.find((item) => item.id === 'ts-unknown')?.percent).toBeUndefined();
  });

  it('classifies terminal task sessions as done, never active', () => {
    const taskSessions: ProgressTaskSessionInput[] = [
      { id: 'ts-executing', title: 'Still going', status: 'executing' },
      { id: 'ts-completed', title: 'Finished', status: 'completed', when: hoursAgo(1) },
      { id: 'ts-failed', title: 'Failed', status: 'failed', when: hoursAgo(2) },
      { id: 'ts-released', title: 'Released', status: 'released', when: hoursAgo(3) },
    ];

    const payload = buildProgressPayload({
      now: NOW,
      taskSessions,
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });

    expect(payload.counts.active).toBe(1);
    expect(payload.active.map((item) => item.id)).toEqual(['ts-executing']);
    expect(payload.counts.done).toBe(3);
    expect(payload.done.map((item) => item.id)).toEqual([
      'ts-completed',
      'ts-failed',
      'ts-released',
    ]);
    expect(payload.done.every((item) => item.kind === 'task_session')).toBe(true);
  });

  it('is verdict-eligible only for artifacts matched to an unread/read deliverable-inbox entry', () => {
    const artifacts: ProgressArtifactInput[] = [
      {
        id: 'art-unread',
        title: 'quarterly-report.pdf',
        kind: 'report_document',
        inbox_status: 'unread',
        entry_id: 'INBOX-1',
      },
      {
        id: 'art-read',
        title: 'deck.pptx',
        kind: 'presentation_deck',
        inbox_status: 'read',
        entry_id: 'INBOX-2',
      },
      {
        id: 'art-no-match',
        title: 'orphan.txt',
        kind: 'text',
      },
    ];

    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [],
      artifacts,
      mirrorHref: MIRROR_HREF,
    });

    expect(payload.counts.delivered).toBe(3);
    const byId = Object.fromEntries(payload.delivered.map((item) => [item.id, item]));
    expect(byId['art-unread'].can_verdict).toBe(true);
    expect(byId['art-unread'].entry_id).toBe('INBOX-1');
    expect(byId['art-read'].can_verdict).toBe(true);
    // Never fake verdict eligibility for an artifact with no matching inbox entry.
    expect(byId['art-no-match'].can_verdict).toBe(false);
    expect(byId['art-no-match'].entry_id).toBeUndefined();
  });

  it('classifies artifacts already verdicted in the deliverable inbox as done, not delivered', () => {
    const artifacts: ProgressArtifactInput[] = [
      {
        id: 'art-accepted',
        title: 'accepted.pdf',
        kind: 'report_document',
        inbox_status: 'accepted',
        entry_id: 'INBOX-3',
        when: hoursAgo(1),
      },
      {
        id: 'art-rejected',
        title: 'rejected.pdf',
        kind: 'report_document',
        inbox_status: 'rejected',
        entry_id: 'INBOX-4',
        when: hoursAgo(2),
      },
      {
        id: 'art-changes',
        title: 'changes.pdf',
        kind: 'report_document',
        inbox_status: 'changes_requested',
        entry_id: 'INBOX-5',
        when: hoursAgo(3),
      },
      {
        id: 'art-pending',
        title: 'pending.pdf',
        kind: 'report_document',
        inbox_status: 'unread',
        entry_id: 'INBOX-6',
        when: hoursAgo(4),
      },
    ];

    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [],
      artifacts,
      mirrorHref: MIRROR_HREF,
    });

    expect(payload.counts.delivered).toBe(1);
    expect(payload.delivered.map((item) => item.id)).toEqual(['art-pending']);
    expect(payload.counts.done).toBe(3);
    expect(payload.done.map((item) => item.id)).toEqual([
      'art-accepted',
      'art-rejected',
      'art-changes',
    ]);
    expect(payload.done.every((item) => item.kind === 'artifact')).toBe(true);
    expect(payload.done.map((item) => item.entry_id)).toEqual(['INBOX-3', 'INBOX-4', 'INBOX-5']);
  });
});

describe('buildProgressDetail', () => {
  it('maps a minimal session (no success_condition, no next steps, no events)', () => {
    const detail = buildProgressDetail({ goal_summary: 'Draft the deck', status: 'planning' }, []);

    expect(detail).toEqual({
      status: 'planning',
      requested: 'Draft the deck',
      now: 'planning',
      log: [],
    });
    expect(detail.next).toBeUndefined();
  });

  it('combines goal summary and success condition when both are present', () => {
    const detail = buildProgressDetail(
      {
        goal_summary: 'Draft the deck',
        success_condition: 'Ten slides, reviewed by finance.',
        status: 'executing',
      },
      []
    );

    expect(detail.requested).toBe('Draft the deck — Ten slides, reviewed by finance.');
  });

  it('derives "now" from the latest event when present, else the raw status', () => {
    const events: ProgressHistoryEntryInput[] = [
      { when: hoursAgo(2), text: 'Collected the source figures.' },
      { when: hoursAgo(1), text: 'Drafted the first three slides.' },
    ];
    const detail = buildProgressDetail(
      { goal_summary: 'Draft the deck', status: 'executing' },
      events
    );

    expect(detail.now).toBe('Drafted the first three slides.');
  });

  it('exposes next steps only when completion_next_action data is present', () => {
    const detail = buildProgressDetail(
      {
        goal_summary: 'Draft the deck',
        status: 'completed',
        next_step: 'Send the deck to finance for sign-off.',
        gaps: ['Missing the Q3 revenue chart.'],
      },
      []
    );

    expect(detail.next).toEqual([
      'Send the deck to finance for sign-off.',
      'Missing the Q3 revenue chart.',
    ]);
  });

  it('caps the log at 8 entries, keeping the most recent, oldest first (newest last)', () => {
    const events: ProgressHistoryEntryInput[] = Array.from({ length: 10 }, (_, index) => ({
      when: hoursAgo(10 - index),
      text: `Step ${index}`,
    }));

    const detail = buildProgressDetail(
      { goal_summary: 'Long-running work', status: 'executing' },
      events
    );

    expect(detail.log).toHaveLength(8);
    expect(detail.log[0].text).toBe('Step 2');
    expect(detail.log[7].text).toBe('Step 9');
  });
});

describe('concrete progress outcomes', () => {
  it('retains failed, released, completed and all verdict states without presenting them as success', () => {
    const payload = buildProgressPayload({
      now: NOW,
      mirrorHref: MIRROR_HREF,
      taskSessions: ['completed', 'failed', 'released'].map((status) => ({
        id: status,
        title: status,
        status,
        correlation_id: 'request-' + status,
      })),
      artifacts: ['accepted', 'rejected', 'changes_requested'].map((status) => ({
        id: status,
        title: status,
        kind: 'text',
        inbox_status: status as ProgressArtifactInput['inbox_status'],
      })),
    });
    expect(payload.done.map((item) => item.status)).toEqual([
      'completed',
      'failed',
      'released',
      'accepted',
      'rejected',
      'changes_requested',
    ]);
    expect(payload.done[1].correlation_id).toBe('request-failed');
  });
  it('marks numeric progress as an estimate and preserves only real request correlation', () => {
    const payload = buildProgressPayload({
      now: NOW,
      mirrorHref: MIRROR_HREF,
      artifacts: [],
      taskSessions: [
        { id: 'tracked', title: 'Tracked', status: 'planning', correlation_id: 'real-request' },
        { id: 'untracked', title: 'Untracked', status: 'blocked' },
      ],
    });
    expect(payload.active[0]).toMatchObject({
      status: 'planning',
      progress_basis: 'phase_estimate',
      correlation_id: 'real-request',
    });
    expect(payload.active[1].progress_basis).toBeUndefined();
    expect(payload.active[1].correlation_id).toBeUndefined();
  });
  it('does not offer a verdict when a status exists without its inbox entry id', () => {
    const payload = buildProgressPayload({
      now: NOW,
      mirrorHref: MIRROR_HREF,
      taskSessions: [],
      artifacts: [{ id: 'orphan', title: 'Orphan', kind: 'text', inbox_status: 'read' }],
    });
    expect(payload.delivered[0]).toMatchObject({ status: 'read', can_verdict: false });
  });
});

describe('resolveComputerSurfaceMirrorHref', () => {
  it('uses the registered surface URL including configured HTTPS hosts and base paths', () => {
    vi.mocked(resolveSurfaceBrowserUrl).mockReturnValue('https://screen.example.test/computer');
    expect(resolveComputerSurfaceMirrorHref()).toBe('https://screen.example.test/computer/');
    expect(resolveSurfaceBrowserUrl).toHaveBeenCalledWith('computer-surface');
  });
  it('keeps the documented fallback when the manifest cannot be resolved', () => {
    vi.mocked(resolveSurfaceBrowserUrl).mockImplementation(() => {
      throw new Error('missing manifest');
    });
    expect(resolveComputerSurfaceMirrorHref()).toBe(MIRROR_HREF);
  });
});
