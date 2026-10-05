import { describe, expect, it } from 'vitest';
import {
  buildWorkHomePayload,
  type BuildWorkHomePayloadInput,
  type WorkHomeConversationInput,
  type WorkHomeStatus,
} from './work-home.js';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const BEFORE = '2026-10-05T10:00:00.000Z';
function input(overrides: Partial<BuildWorkHomePayloadInput> = {}): BuildWorkHomePayloadInput {
  return {
    now: NOW,
    conversationWork: { sessionId: 'scope-session', tasks: [] },
    approvals: [],
    heldActions: [],
    taskSessions: [],
    artifacts: [],
    sources: {
      conversation: { state: 'available' },
      approvals: { state: 'available' },
      held_actions: { state: 'available' },
      task_sessions: { state: 'available' },
      artifacts: { state: 'available' },
    },
    ...overrides,
  };
}
function conversation(
  overrides: Partial<WorkHomeConversationInput> = {}
): WorkHomeConversationInput {
  return {
    id: 'request-1',
    title: 'Prepare a report',
    sourceStatus: 'recorded',
    createdAt: Date.parse(BEFORE),
    lastRecordedAt: Date.parse(BEFORE),
    turnState: 'settled',
    ...overrides,
  };
}
function verified(overrides: Partial<WorkHomeConversationInput> = {}): WorkHomeConversationInput {
  return conversation({
    executionStatus: 'work_completed',
    verifiedAt: NOW.getTime(),
    artifact: {
      requestId: 'request-1',
      revision: 1,
      format: 'readable',
      verification: 'verified',
      currentness: 'latest_verified',
      sha256: 'a'.repeat(64),
      verifiedAt: NOW.getTime(),
    },
    ...overrides,
  });
}
function rows(tasks: WorkHomeConversationInput[]) {
  return buildWorkHomePayload(input({ conversationWork: { sessionId: 'scope-session', tasks } }));
}

describe('buildWorkHomePayload', () => {
  it('distinguishes supported empty sources from unavailable sources', () => {
    const empty = buildWorkHomePayload(input());
    expect(empty.coverage).toBe('supported_sources_ready');
    expect(empty.items).toEqual([]);
    expect(
      empty.sources.every(
        (source) => source.total === 0 && source.shown === 0 && source.state === 'available'
      )
    ).toBe(true);
    const missing = buildWorkHomePayload(input({ sources: undefined }));
    expect(missing.coverage).toBe('unavailable');
    expect(
      missing.sources.every((source) => source.total === null && source.state === 'unavailable')
    ).toBe(true);
    const mixed = buildWorkHomePayload(
      input({
        sources: { conversation: { state: 'available' }, approvals: { state: 'unavailable' } },
      })
    );
    expect(mixed.coverage).toBe('partial');
    expect(mixed.sources.find((source) => source.id === 'conversation')?.total).toBe(0);
    expect(mixed.sources.find((source) => source.id === 'approvals')?.total).toBeNull();
  });
  it('keeps every supplied row, exposes upstream totals, and never caps decisions at three', () => {
    const approvals = Array.from({ length: 15 }, (_, index) => ({
      id: 'approval-' + index,
      title: 'Approval ' + index,
      when: BEFORE,
    }));
    const artifacts = Array.from({ length: 10 }, (_, index) => ({
      id: 'artifact-' + index,
      title: 'Artifact ' + index,
    }));
    const result = buildWorkHomePayload(
      input({
        approvals,
        artifacts,
        sources: { ...input().sources, artifacts: { state: 'available', total: 12 } },
      })
    );
    expect(result.items).toHaveLength(25);
    expect(result.attention).toHaveLength(15);
    expect(result.counts.all).toBe(25);
    expect(result.sources.find((source) => source.id === 'artifacts')).toEqual({
      id: 'artifacts',
      state: 'partial',
      total: 12,
      shown: 10,
    });
    expect(result.coverage).toBe('partial');
    expect(
      result.items
        .filter((item) => item.source === 'artifact')
        .every((item) => item.unknowns.includes('source_partial'))
    ).toBe(true);
  });
  it('namespaces duplicate identifiers across all five sources and across explicit scopes', () => {
    const result = buildWorkHomePayload(
      input({
        conversationWork: { sessionId: 's', tasks: [conversation({ id: 'same' })] },
        approvals: [
          { id: 'same', title: 'Same', scope_id: 'one' },
          { id: 'same', title: 'Same', scope_id: 'two' },
        ],
        heldActions: [{ id: 'same', title: 'Same' }],
        taskSessions: [{ id: 'same', title: 'Same', status: 'executing' }],
        artifacts: [{ id: 'same', title: 'Same' }],
      })
    );
    expect(result.items).toHaveLength(6);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(6);
    expect(result.items.map((item) => item.source_id)).toEqual(Array(6).fill('same'));
  });
  it.each([
    ['completed', 'answered'],
    ['answered', 'answered'],
    ['needs_execution', 'intake'],
    ['awaiting_input', 'awaiting_input'],
    ['recorded', 'recorded'],
  ] as const)(
    'maps conversation %s to %s without claiming execution completion',
    (sourceStatus, status) => {
      const result = rows([conversation({ sourceStatus })]);
      expect(result.items[0].status).toBe(status);
      expect(result.items[0].verification).toBe('unknown');
      expect(result.counts.verified).toBe(0);
    }
  );
  it.each(['queued', 'awaiting_approval', 'running', 'blocked', 'cancel_requested'] as const)(
    'preserves exact projected execution state %s',
    (executionStatus) => {
      const result = rows([conversation({ executionStatus })]);
      expect(result.items[0].status).toBe(executionStatus);
    }
  );
  it('does not turn uncertain, stale completed, or pending conversation state into running or success', () => {
    const result = rows([
      conversation({ id: 'uncertain', sourceStatus: 'answered', turnState: 'uncertain' }),
      conversation({ id: 'missing-proof', executionStatus: 'work_completed' }),
      conversation({ id: 'pending', turnState: 'pending' }),
      conversation({ id: 'unreadable', executionStatus: 'unknown' }),
    ]);
    expect(result.items.find((item) => item.source_id === 'uncertain')?.status).toBe('unknown');
    expect(result.items.find((item) => item.source_id === 'missing-proof')?.status).toBe('unknown');
    expect(result.items.find((item) => item.source_id === 'pending')?.status).toBe('recorded');
    expect(result.items.find((item) => item.source_id === 'unreadable')?.unknowns).toContain(
      'execution_state_unknown'
    );
    expect(result.counts.verified).toBe(0);
  });
  it.each(['pending', 'not_started', 'uncertain', 'unknown'] as const)(
    'does not present a retained answer as current while the amendment is %s',
    (turnState) => {
      const result = rows([
        conversation({ sourceStatus: 'answered', turnState, resultExcerpt: 'The prior answer' }),
      ]);
      expect(result.items[0].status).toBe(
        turnState === 'pending' || turnState === 'not_started' ? 'recorded' : 'unknown'
      );
      expect(result.counts.answered).toBe(0);
      expect(
        result.updates.flatMap((group) => group.entries).some((entry) => entry.kind === 'result')
      ).toBe(false);
      expect(JSON.stringify(result)).not.toContain('The prior answer');
    }
  );
  it('uses neutral conversation navigation for ordinary answers, never verified-result wording', () => {
    for (const sourceStatus of ['answered', 'completed'] as const) {
      const item = rows([
        conversation({ sourceStatus, turnState: 'settled', resultExcerpt: 'An ordinary answer' }),
      ]).items[0];
      expect(item.next_step_key).toBe('front_desk:work_home_next_resume_conversation');
      expect(item.resume.next_step_key).toBe(item.next_step_key);
      expect(item.verification).toBe('unknown');
    }
    expect(rows([verified()]).items[0].next_step_key).toBe(
      'front_desk:work_home_next_review_result'
    );
  });
  it('shows the answer excerpt again only when the conversation turn settles', () => {
    const result = rows([
      conversation({
        sourceStatus: 'answered',
        turnState: 'settled',
        resultExcerpt: 'The current answer',
      }),
    ]);
    expect(result.items[0].status).toBe('answered');
    expect(result.updates[0].entries).toContainEqual(
      expect.objectContaining({ kind: 'result', text: 'The current answer' })
    );
  });
  it.each(['pending', 'not_started'] as const)(
    'preserves current execution readback over retained conversation state %s',
    (turnState) => {
      for (const executionStatus of [
        'queued',
        'awaiting_approval',
        'running',
        'blocked',
        'cancel_requested',
      ] as const) {
        const result = rows([
          conversation({
            sourceStatus: 'answered',
            turnState,
            executionStatus,
            resultExcerpt: 'The prior answer',
          }),
        ]);
        expect(result.items[0].status).toBe(executionStatus);
        expect(result.counts.answered).toBe(0);
        expect(JSON.stringify(result)).not.toContain('The prior answer');
      }
      expect(rows([verified({ sourceStatus: 'answered', turnState })]).items[0].status).toBe(
        'work_completed'
      );
    }
  );
  it('requires positive current readback proof with matching request and a hash before work_completed', () => {
    const good = verified();
    expect(rows([good]).items[0]).toMatchObject({
      status: 'work_completed',
      verification: 'verified',
      last_verified_at: NOW.toISOString(),
    });
    for (const bad of [
      { ...good, artifact: undefined },
      { ...good, artifact: { ...good.artifact!, requestId: 'different' } },
      { ...good, artifact: { ...good.artifact!, sha256: undefined } },
      { ...good, artifact: { ...good.artifact!, sha256: 'invalid' } },
      { ...good, artifact: { ...good.artifact!, verification: 'unknown' as const } },
      { ...good, verifiedAt: undefined, artifact: { ...good.artifact!, verifiedAt: undefined } },
    ]) {
      expect(rows([bad]).items[0].status).toBe('unknown');
      expect(rows([bad]).items[0].links.some((link) => link.kind === 'artifact')).toBe(false);
    }
  });
  it.each([
    ['awaiting_instruction', 'awaiting_input'],
    ['collecting_requirements', 'awaiting_input'],
    ['planning', 'intake'],
    ['awaiting_confirmation', 'awaiting_approval'],
    ['executing', 'running'],
    ['verifying', 'verifying'],
    ['completed', 'completion_unverified'],
    ['failed', 'failed'],
    ['released', 'released'],
    ['queued', 'queued'],
    ['blocked', 'blocked'],
    ['new_status', 'unknown'],
  ] as Array<[string, WorkHomeStatus]>)(
    'maps legacy %s to %s without inferred success',
    (status, expected) => {
      const result = buildWorkHomePayload(
        input({ taskSessions: [{ id: 'session', title: 'Session', status, when: BEFORE }] })
      );
      expect(result.items[0].status).toBe(expected);
      expect(result.items[0].source_status).toBe(status);
      expect(result.items[0].verification).not.toBe('verified');
      expect(result.items[0]).not.toHaveProperty('percent');
    }
  );
  it('uses an explicit awaiting-user-input flag for nonterminal sessions while preserving recorded status', () => {
    const result = buildWorkHomePayload(
      input({
        taskSessions: [
          { id: 'session', title: 'Task', status: 'executing', awaiting_user_input: true },
        ],
      })
    );
    expect(result.items[0]).toMatchObject({
      status: 'awaiting_input',
      source_status: 'executing',
      next_step_key: 'front_desk:work_home_next_provide_input',
    });
    expect(result.attention.map((item) => item.id)).toEqual([result.items[0].id]);
  });
  it('keeps normal nonterminal status when awaiting-user-input is false or absent', () => {
    const result = buildWorkHomePayload(
      input({
        taskSessions: [
          { id: 'false', title: 'Task', status: 'executing', awaiting_user_input: false },
          { id: 'absent', title: 'Task', status: 'executing' },
        ],
      })
    );
    expect(result.items.every((item) => item.status === 'running')).toBe(true);
    expect(result.attention).toEqual([]);
  });
  it('does not reinterpret failed, released, or completed sessions as awaiting input', () => {
    const result = buildWorkHomePayload(
      input({
        taskSessions: ['failed', 'released', 'completed', 'work_completed'].map((status) => ({
          id: status,
          title: 'Task',
          status,
          awaiting_user_input: true,
        })),
      })
    );
    for (const item of result.items) {
      expect(item.status).toBe(
        item.source_status === 'completed' || item.source_status === 'work_completed'
          ? 'completion_unverified'
          : item.source_status
      );
      expect(item.next_step_key).not.toBe('front_desk:work_home_next_provide_input');
    }
  });
  it('keeps truthful recorded and verified times separate and rejects invalid timestamps', () => {
    const result = rows([verified()]);
    expect(result.items[0].resume).toMatchObject({
      last_recorded_at: BEFORE,
      last_verified_at: NOW.toISOString(),
      next_step_key: 'front_desk:work_home_next_review_result',
    });
    const invalid = buildWorkHomePayload(
      input({
        taskSessions: [
          { id: 'session', title: 'Session', status: 'completed', when: 'not-a-date' },
        ],
      })
    ).items[0];
    expect(invalid.last_recorded_at).toBeUndefined();
    expect(invalid.last_verified_at).toBeUndefined();
    expect(invalid.unknowns).toEqual(
      expect.arrayContaining([
        'recorded_time_unknown',
        'completion_not_verified',
        'verification_unknown',
      ])
    );
    expect(invalid.resume.unknowns).toEqual(invalid.unknowns);
  });
  it('never invents generic artifact versions, creation times, verification, or latest status', () => {
    const item = buildWorkHomePayload(
      input({ artifacts: [{ id: 'artifact', title: 'report.pdf', downloadable: true }] })
    ).items[0];
    expect(item.status).toBe('artifact_recorded');
    expect(item.artifact).toEqual({
      kind: 'generic',
      verification: 'unknown',
      currentness: 'unknown',
    });
    expect(item.last_recorded_at).toBeUndefined();
    expect(item.last_verified_at).toBeUndefined();
    expect(item.unknowns).toEqual(
      expect.arrayContaining(['version_unknown', 'artifact_time_unknown', 'verification_unknown'])
    );
    expect(item.links.map((link) => link.kind)).toEqual(['progress', 'artifact']);
  });
  it('keeps an older verified artifact when the latest requested revision is pending', () => {
    const first = verified({
      artifact: { ...verified().artifact!, currentness: 'older_verified' },
    });
    const second = conversation({
      id: 'request-2',
      title: 'Compact report',
      executionStatus: 'queued',
      artifact: {
        requestId: 'request-2',
        revision: 2,
        format: 'compact',
        parentRequestId: 'request-1',
        parentRevision: 1,
        changeReason: 'format_change',
        verification: 'pending',
        currentness: 'requested_pending',
      },
    });
    const result = rows([first, second]);
    const old = result.items.find((item) => item.source_id === 'request-1')!;
    const pending = result.items.find((item) => item.source_id === 'request-2')!;
    expect(old.artifact?.currentness).toBe('older_verified');
    expect(old.artifact?.verification).toBe('verified');
    expect(pending.artifact).toMatchObject({
      currentness: 'requested_pending',
      verification: 'pending',
      revision: 2,
      parent_revision: 1,
      change_reason: 'format_change',
    });
    expect(pending.status).toBe('queued');
    expect(pending.links.map((link) => link.kind)).toEqual(['conversation']);
    expect(result.counts.verified).toBe(1);
  });
  it('keeps safe navigation ordered and decisions on their existing canonical panels', () => {
    const result = buildWorkHomePayload(
      input({
        conversationWork: { sessionId: 's', tasks: [verified()] },
        approvals: [{ id: 'approve', title: 'Approve' }],
        heldActions: [{ id: 'held', title: 'Held' }],
        taskSessions: [
          { id: 'session', title: 'Session', status: 'executing', correlation_id: 'request-1' },
        ],
        artifacts: [{ id: 'report/one?x=1#part', title: 'Report', downloadable: true }],
      })
    );
    expect(result.items.find((item) => item.source === 'approval')?.links[0].href).toBe(
      '/work#approval-panel'
    );
    expect(result.items.find((item) => item.source === 'held_action')?.links[0].href).toBe(
      '/work#os-control-plane-panel'
    );
    expect(
      result.items.find((item) => item.source === 'task_session')?.links.map((link) => link.kind)
    ).toEqual(['conversation', 'progress']);
    expect(
      result.items.find((item) => item.source === 'conversation')?.links.map((link) => link.kind)
    ).toEqual(['conversation', 'artifact']);
    expect(result.items.find((item) => item.source === 'artifact')?.links[1].href).toBe(
      '/api/artifacts/report%2Fone%3Fx%3D1%23part'
    );
    expect(
      result.items.flatMap((item) => item.links).every((link) => link.href.startsWith('/'))
    ).toBe(true);
  });
  it('does not trust input hrefs or expose unavailable artifact routes', () => {
    const malicious = {
      id: 'javascript:alert(1)',
      title: 'Report',
      downloadable: false,
      href: 'https://evil.example',
    };
    const result = buildWorkHomePayload(input({ artifacts: [malicious] }));
    expect(result.items[0].links).toEqual([
      {
        kind: 'progress',
        href: '/progress#javascript%3Aalert(1)',
        target_id: 'javascript:alert(1)',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(rows([conversation({ id: 'request\ud800' })]).items[0].links[0].href).toBe(
      '/ask?request=request%EF%BF%BD'
    );
  });
  it('groups updates only by an explicit real matching identifier in the same scope', () => {
    const result = buildWorkHomePayload(
      input({
        scopeId: 'scope-a',
        conversationWork: { sessionId: 's', tasks: [conversation()] },
        approvals: [
          {
            id: 'matching',
            title: 'Approve report',
            relatedTo: { source: 'conversation', id: 'request-1' },
          },
          { id: 'same-title', title: 'Prepare a report' },
          {
            id: 'cross-scope',
            title: 'Prepare a report',
            scope_id: 'scope-b',
            relatedTo: { source: 'conversation', id: 'request-1' },
          },
          {
            id: 'missing',
            title: 'Prepare a report',
            relatedTo: { source: 'conversation', id: 'absent' },
          },
        ],
      })
    );
    const conversationItem = result.items.find((item) => item.source === 'conversation')!;
    expect(result.items.find((item) => item.source_id === 'matching')?.related_to).toBe(
      conversationItem.id
    );
    for (const id of ['same-title', 'cross-scope', 'missing'])
      expect(result.items.find((item) => item.source_id === id)?.related_to).toBeUndefined();
    expect(
      result.updates.find((group) => group.item_id === conversationItem.id)?.entries
    ).toHaveLength(2);
    expect(result.items).toHaveLength(5);
    expect(result.updates).toHaveLength(4);
    expect(result.attention).toHaveLength(4);
  });
  it('groups recorded updates per task without conflating history text with verification', () => {
    const result = buildWorkHomePayload(
      input({
        taskSessions: [
          {
            id: 'session',
            title: 'Task',
            status: 'executing',
            when: BEFORE,
            history: [{ when: BEFORE, text: 'Looks done' }, { text: '  ' }],
          },
        ],
      })
    );
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].entries).toHaveLength(2);
    expect(result.updates[0].entries[1]).toMatchObject({
      kind: 'recorded_update',
      text: 'Looks done',
    });
    expect(result.items[0].status).toBe('running');
    expect(result.items[0].verification).toBe('unknown');
  });
  it('marks contradictory source counts partial and never treats unavailable counts as known', () => {
    const result = buildWorkHomePayload(
      input({
        approvals: [{ id: 'one', title: 'Approval' }],
        sources: {
          ...input().sources,
          approvals: { state: 'available', total: 0 },
          artifacts: { state: 'unavailable', total: 0 },
        },
      })
    );
    expect(result.sources.find((source) => source.id === 'approvals')).toEqual({
      id: 'approvals',
      state: 'partial',
      shown: 1,
      total: null,
    });
    expect(result.sources.find((source) => source.id === 'artifacts')?.total).toBeNull();
  });
  it('does not promote conflicting artifact currentness to latest verified', () => {
    const row = verified({
      artifact: { ...verified().artifact!, currentness: 'requested_pending' },
    });
    expect(rows([row]).items[0]).toMatchObject({ status: 'unknown', verification: 'unknown' });
    expect(rows([row]).items[0].artifact?.currentness).toBe('requested_pending');
  });
  it('keeps generic artifact time unknown even when the record has an update timestamp', () => {
    const item = buildWorkHomePayload(
      input({ artifacts: [{ id: 'artifact', title: 'Report', when: BEFORE }] })
    ).items[0];
    expect(item.last_recorded_at).toBe(BEFORE);
    expect(item.unknowns).toContain('artifact_time_unknown');
  });
  it('omits dot-segment artifact paths instead of linking outside the serving route', () => {
    for (const id of ['', '.', '..']) {
      const item = buildWorkHomePayload(
        input({ artifacts: [{ id, title: 'Report', downloadable: true }] })
      ).items[0];
      expect(item.links.some((link) => link.kind === 'artifact')).toBe(false);
    }
  });
  it('groups recorded child updates by their real time without substituting verification time', () => {
    const newer = '2026-10-05T11:00:00.000Z';
    const result = buildWorkHomePayload(
      input({
        conversationWork: { sessionId: 's', tasks: [verified()] },
        approvals: [
          {
            id: 'approve',
            title: 'Approve',
            when: newer,
            relatedTo: { source: 'conversation', id: 'request-1' },
          },
        ],
      })
    );
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].last_recorded_at).toBe(newer);
    expect(result.updates[0].entries.map((entry) => entry.when)).toEqual([
      BEFORE,
      newer,
      NOW.toISOString(),
    ]);
  });
  it('prioritizes blockers and waiting decisions, keeps deterministic order, and does not mutate input', () => {
    const original = input({
      approvals: [
        { id: 'new', title: 'New', when: '2026-10-05T11:00:00.000Z' },
        { id: 'old', title: 'Old', when: BEFORE },
      ],
      taskSessions: [
        { id: 'blocked', title: 'Blocked', status: 'blocked' },
        { id: 'running', title: 'Running', status: 'executing' },
      ],
    });
    const before = JSON.stringify(original);
    const result = buildWorkHomePayload(original);
    expect(result.items.map((item) => item.source_id)).toEqual([
      'old',
      'new',
      'blocked',
      'running',
    ]);
    expect(result.attention.map((item) => item.source_id)).toEqual(['old', 'new', 'blocked']);
    expect(JSON.stringify(original)).toBe(before);
    expect(buildWorkHomePayload(original)).toEqual(result);
  });
});
