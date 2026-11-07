// FD-05: `buildProgressPayload` / `buildProgressDetail` — the shared
// "依頼" / "進み具合" read models (Concierge 仕事 › 依頼, presence-studio 頼む).
// Pure, no I/O — see the module doc for the documented artifact-record vs
// deliverable-inbox store gap. Moved from presence-studio `progress.test.ts`.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./surface-url.js', () => ({ resolveSurfaceBrowserUrl: vi.fn() }));
import { resolveSurfaceBrowserUrl } from './surface-url.js';
import {
  resolveComputerSurfaceMirrorHref,
  buildProgressDetail,
  buildProgressPayload,
  estimateTaskSessionPercent,
  buildTaskSessionProgressDetail,
  deriveProgressArtifactTitle,
  findMatchingInboxEntry,
  progressRecordInScope,
  progressRecordTenant,
  progressTaskSessionInput,
  type ProgressArtifactInput,
  type ProgressHistoryEntryInput,
  type ProgressTaskSessionInput,
} from './front-desk-progress.js';

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

describe('recorded task-state provenance', () => {
  it.each([
    ['awaiting_instruction', 'awaiting_input'],
    ['collecting_requirements', 'collecting_requirements'],
    ['planning', 'planning'],
    ['awaiting_confirmation', 'awaiting_confirmation'],
    ['executing', 'executing'],
    ['verifying', 'verifying'],
    ['paused', 'paused'],
    ['blocked', 'blocked'],
    ['new_runtime_state', 'unknown'],
  ])('projects %s without claiming every nonterminal task is running', (status, expected) => {
    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [{ id: 'task', title: 'Task', status }],
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });
    expect(payload.active[0].task_state).toBe(expected);
    expect(payload.active[0].latest_update).toBeUndefined();
  });
  it('honors explicit input wait but never overrides a terminal record', () => {
    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [
        { id: 'waiting', title: 'Waiting', status: 'executing', awaiting_user_input: true },
        ...['completed', 'failed', 'released'].map((status) => ({
          id: status,
          title: status,
          status,
          awaiting_user_input: true,
        })),
      ],
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });
    expect(payload.active[0].task_state).toBe('awaiting_input');
    expect(payload.done.map((item) => item.task_state)).toEqual([
      'completed',
      'failed',
      'released',
    ]);
  });
  it('keeps a historical update separate from the task state and from artifact detail', () => {
    const history = [{ when: hoursAgo(8), text: 'Drafting earlier.' }];
    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [{ id: 'blocked', title: 'Blocked', status: 'blocked', history }],
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });
    expect(payload.active[0].task_state).toBe('blocked');
    expect(payload.active[0].latest_update).toEqual(history[0]);
    const detail = buildProgressDetail(
      { kind: 'task_session', goal_summary: 'Task', status: 'paused', awaiting_user_input: false },
      history
    );
    expect(detail.task_state).toBe('paused');
    expect(detail.latest_update).toEqual(history[0]);
    expect(
      buildProgressDetail(
        { kind: 'artifact', goal_summary: 'Artifact', status: 'completed' },
        history
      ).task_state
    ).toBeUndefined();
  });
});

it.each([false, undefined])(
  'does not infer input wait from requirements collection with flag %s',
  (awaiting_user_input) => {
    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [
        { id: 'task', title: 'Task', status: 'collecting_requirements', awaiting_user_input },
      ],
      artifacts: [],
      mirrorHref: MIRROR_HREF,
    });
    expect(payload.active[0].task_state).toBe('collecting_requirements');
  }
);

describe('delivery-wide artifact membership', () => {
  it('preserves separate artifact IDs sharing one authoritative inbox verdict target', () => {
    const payload = buildProgressPayload({
      now: NOW,
      taskSessions: [],
      mirrorHref: MIRROR_HREF,
      artifacts: ['pdf', 'slides'].map((id) => ({
        id,
        title: id,
        kind: id,
        entry_id: 'delivery',
        inbox_status: 'read' as const,
      })),
    });
    expect(payload.delivered.map((item) => [item.id, item.entry_id, item.can_verdict])).toEqual([
      ['pdf', 'delivery', true],
      ['slides', 'delivery', true],
    ]);
  });
});

describe('record mappers shared by Concierge and presence-studio', () => {
  const session = {
    session_id: 'TS-1',
    correlation_id: 'req-1',
    status: 'executing',
    updated_at: '2026-09-13T11:00:00.000Z',
    goal: { summary: 'Draft the plan', success_condition: 'Two options' },
    control: { awaiting_user_input: true },
    completion_next_action: { next_step: 'Review', gaps: ['Budget'] },
    history: [{ ts: '2026-09-13T10:00:00.000Z', text: 'Started' }, { ts: 'x' }],
  };

  it('maps a task session to a list row and a detail', () => {
    expect(progressTaskSessionInput(session)).toEqual({
      id: 'TS-1',
      correlation_id: 'req-1',
      title: 'Draft the plan',
      status: 'executing',
      awaiting_user_input: true,
      when: '2026-09-13T11:00:00.000Z',
      history: [{ when: '2026-09-13T10:00:00.000Z', text: 'Started' }],
    });
    expect(buildTaskSessionProgressDetail(session, 'task_session')).toMatchObject({
      kind: 'task_session',
      task_state: 'awaiting_input',
      requested: 'Draft the plan — Two options',
      next: ['Review', 'Budget'],
      log: [{ when: '2026-09-13T10:00:00.000Z', text: 'Started' }],
    });
    expect(buildTaskSessionProgressDetail(session, 'artifact')).not.toHaveProperty('task_state');
    expect(progressTaskSessionInput({ session_id: 'TS-2', status: 'planning' }).title).toBe('TS-2');
  });

  it('never uses raw markdown as a title', () => {
    expect(deriveProgressArtifactTitle({ path: 'a/b/report.md', kind: 'doc' })).toBe('report.md');
    expect(
      deriveProgressArtifactTitle({ preview_text: '# Weekly summary\nbody', kind: 'doc' })
    ).toBe('Weekly summary');
    expect(deriveProgressArtifactTitle({ preview_text: '# x', kind: 'doc' })).toBe('doc');
  });

  it('links an artifact to an inbox entry only by an exact shared path', () => {
    const entries = [{ entry_id: 'E-1', artifact_paths: ['out/report.md'] }];
    expect(findMatchingInboxEntry(entries, 'out/report.md')?.entry_id).toBe('E-1');
    expect(findMatchingInboxEntry(entries, 'report.md')).toBeUndefined();
    expect(findMatchingInboxEntry(entries, undefined)).toBeUndefined();
  });
});

describe('progressRecordInScope', () => {
  const all = { tenantSlugs: 'all', organizationIds: 'all', projectIds: 'all' } as const;
  const alpha = { ...all, tenantSlugs: ['alpha'] };
  it('admits own person across finite tenant scope while refusing malformed or contradictory aliases', () => {
    const owner = { ...alpha, principalId: 'alice' };
    expect(progressRecordInScope(owner, { nhi_id: 'alice' })).toBe(true);
    expect(progressRecordInScope(owner, { scope: { owner_nhi: 'alice' } })).toBe(true);
    expect(progressRecordInScope(owner, { nhi_id: 'bob' })).toBe(false);
    for (const row of [
      { owner_nhi: '', nhi_id: 'alice' },
      { nhi_id: 12 },
      { scope: { owner_nhi: 'alice' }, context: { owner_nhi: 'bob' } },
      { owner_nhi: 'alice', nhi_id: 'bob' },
    ])
      expect(progressRecordInScope({ ...all, principalId: 'alice' }, row)).toBe(false);
  });

  it('reads the tenant directly or from a nested scope envelope', () => {
    expect(progressRecordTenant({ tenant_slug: ' alpha ' })).toBe('alpha');
    expect(progressRecordTenant({ project_context: { tenant_slug: 'beta' } })).toBe('beta');
    expect(progressRecordTenant({ scope: { scope: { tenant_slug: 'gamma' } } })).toBe('gamma');
    expect(progressRecordTenant({})).toBeUndefined();
  });

  it('denies another tenant and an unknown tenant for a scoped viewer', () => {
    expect(progressRecordInScope(alpha, { tenant_slug: 'alpha' })).toBe(true);
    expect(progressRecordInScope(alpha, { tenant_slug: 'beta' })).toBe(false);
    expect(progressRecordInScope(alpha, {})).toBe(false);
    expect(progressRecordInScope(all, {})).toBe(true);
    // The system selection admits only company-less records.
    const system = { ...all, tenantSlugs: [] as string[], includeUntenanted: true };
    expect(progressRecordInScope(system, {})).toBe(true);
    expect(progressRecordInScope(system, { tenant_slug: 'alpha' })).toBe(false);
  });

  it('requires canonical scope metadata for an explicit organization / project narrowing', () => {
    const project = { ...alpha, organizationIds: ['org-a'], projectIds: ['project-a'] };
    const scoped = (projectId: string) => ({
      scope: {
        scope_kind: 'project',
        tier: 'confidential',
        tenant_slug: 'alpha',
        organization_id: 'org-a',
        project_id: projectId,
      },
    });
    expect(progressRecordInScope(project, scoped('project-a'))).toBe(true);
    expect(progressRecordInScope(project, scoped('project-b'))).toBe(false);
    expect(progressRecordInScope(project, { tenant_slug: 'alpha' })).toBe(false);
  });
});
