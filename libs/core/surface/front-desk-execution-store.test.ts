import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrontDeskExecutionMapping,
  FrontDeskExecutionProjection,
} from './front-desk-execution-contract.js';
import type { FrontDeskConversationViewer } from './front-desk-conversation-store.js';
const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  mappings: [] as FrontDeskExecutionMapping[],
  digest: 'a'.repeat(64),
  projection: undefined as FrontDeskExecutionProjection | undefined,
  projections: new Map<string, FrontDeskExecutionProjection>(),
  writes: 0,
}));
vi.mock('../authority.js', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../lock-utils.js', () => ({ withLockSync: (_key: string, fn: () => unknown) => fn() }));
vi.mock('../workforce/artifact-store.js', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(state.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) => {
    state.writes++;
    state.files.set(path, structuredClone(value));
  },
}));
vi.mock('./front-desk-execution-status.js', () => ({
  projectFrontDeskExecution: (_viewer: unknown, binding: { request_id: string }) =>
    state.projections.get(binding.request_id) ?? state.projection,
}));
vi.mock('./front-desk-execution-contract.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./front-desk-execution-contract.js')>();
  return {
    ...original,
    loadFrontDeskExecutionPolicy: () => ({ version: 1, mappings: structuredClone(state.mappings) }),
    frontDeskMappingDigest: () => state.digest,
    getFrontDeskExecutionMapping: (
      binding: import('./front-desk-execution-contract.js').FrontDeskExecutionBinding
    ) =>
      binding.config_digest === state.digest
        ? structuredClone(state.mappings.find((mapping) => mapping.id === binding.mapping_id))
        : undefined,
  };
});
import {
  frontDeskArtifactRevisionCommand,
  frontDeskArtifactRevisionDigest,
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
} from './front-desk-execution-contract.js';
import {
  reserveConversationTurn,
  completeConversationTurn,
  conversationRef,
  readConversationHistory,
  readConversationExecutionReports,
  listConfiguredFrontDeskExecutions,
  inspectFrontDeskExecution,
  markConversationTurnNotStarted,
  markConversationTurnUncertain,
} from './front-desk-conversation-store.js';
const viewer: FrontDeskConversationViewer = {
  principalId: 'human:alice',
  memberId: 'alice',
  role: 'localadmin',
  source: 'token',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public'],
};
const charter = {
  dot_id: 'receipt-dot',
  status: 'active',
  scope: {
    tier: 'public' as const,
    tenant_slug: 'tenant-a',
    organization_id: 'org-a',
    project_id: 'project-a',
  },
};
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const reserve = (n = 1) => reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, id(n));
const current = () => listConfiguredFrontDeskExecutions()[0];
const transcript = () => state.files.get(conversationRef(viewer).path) as any;
beforeEach(() => {
  state.files.clear();
  state.writes = 0;
  state.digest = 'a'.repeat(64);
  state.projection = undefined;
  state.projections.clear();
  state.mappings = [
    {
      id: 'receipt',
      viewer: structuredClone(viewer),
      dotId: charter.dot_id,
      exactCommand: FRONT_DESK_RECEIPT_COMMAND,
      pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
    },
  ];
});
describe('bounded opt-in atomic request admission', () => {
  it('reserves the request, full viewer, deterministic work reference and local acknowledgement in one write', () => {
    const result = reserve();
    expect(state.writes).toBe(1);
    expect(result.routing).toMatchObject({
      kind: 'new_request',
      authority: 'none',
      reply: expect.stringContaining('queued'),
    });
    expect(transcript().executionRequests[0]).toMatchObject({
      viewer,
      sessionId: conversationRef(viewer).sessionId,
      revision: 1,
      status: 'pending',
    });
    expect(transcript().taskState.tasks[0]).toMatchObject({
      workItemId: current().binding.work_item_id,
      state: 'needs_execution',
    });
    expect(current().binding.work_item_id).toMatch(/^WI-FD-[a-f0-9]{48}$/);
    expect(current().request).not.toHaveProperty('requestText');
    expect(readConversationHistory(viewer).pending).toBe(0);
    const checked = inspectFrontDeskExecution(current().binding, charter);
    expect(checked).toMatchObject({ ok: true, requestText: FRONT_DESK_RECEIPT_COMMAND });
    if (checked.ok) {
      expect(checked.artifactPath).toContain('/public/tenant-a/report/');
      expect(JSON.parse(checked.expectedContent)).toMatchObject({
        request_id: id(1),
        revision: 1,
        request_text: FRONT_DESK_RECEIPT_COMMAND,
      });
    }
  });
  it('replays duplicate reservations after a JSON restart without issuing another work reference', () => {
    reserve();
    const binding = current().binding;
    const serialized = JSON.stringify(transcript());
    state.files.set(conversationRef(viewer).path, JSON.parse(serialized));
    expect(reserve()).toMatchObject({ created: false, reply: expect.stringContaining('queued') });
    expect(state.writes).toBe(1);
    expect(listConfiguredFrontDeskExecutions()).toHaveLength(1);
    expect(current().binding).toEqual(binding);
    expect(inspectFrontDeskExecution(binding, charter).ok).toBe(true);
  });
  it('does not admit unmapped, approximate, generic or mixed commands', () => {
    for (const [n, text] of [
      'Create a report',
      'Create a local diagnostic request receipt artifact',
      'Please create a local diagnostic request receipt artifact.',
      FRONT_DESK_RECEIPT_COMMAND + ' Then deploy it.',
    ].entries()) {
      expect(reserveConversationTurn(viewer, text, id(n + 1)).routing?.reply).toBeUndefined();
    }
    expect(listConfiguredFrontDeskExecutions()).toEqual([]);
    state.mappings = [];
    expect(
      reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, id(5)).routing?.reply
    ).toBeUndefined();
  });
  it.each([
    { principalId: 'human:bob' },
    { memberId: 'bob' },
    { source: 'loopback' },
    { role: 'readonly' },
    { tenantSlugs: ['tenant-b'] },
    { organizationIds: ['org-b'] },
    { projectIds: ['project-b'] },
    { tierAccess: ['confidential'] },
  ])('does not admit spoofed server viewer field %j', (change) => {
    const other = { ...viewer, ...change } as FrontDeskConversationViewer;
    expect(
      reserveConversationTurn(other, FRONT_DESK_RECEIPT_COMMAND, id(1)).routing?.reply
    ).toBeUndefined();
    expect(listConfiguredFrontDeskExecutions()).toEqual([]);
  });
  it('accepts canonical ordering only with unchanged permissions', () => {
    reserveConversationTurn(
      { ...viewer, tierAccess: ['public'] },
      FRONT_DESK_RECEIPT_COMMAND,
      id(1)
    );
    expect(current().binding).toBeDefined();
  });
  it.each([
    { tier: 'confidential' },
    { tenant_slug: 'tenant-b' },
    { organization_id: 'org-b' },
    { project_id: 'project-b' },
  ])('rechecks charter scope %j', (change) => {
    reserve();
    expect(
      inspectFrontDeskExecution(current().binding, {
        ...charter,
        scope: { ...charter.scope, ...change },
      } as typeof charter)
    ).toMatchObject({ ok: false, reason: 'scope_mismatch' });
  });
  it('revokes changed config and never recreates an old request by replay', () => {
    reserve();
    const binding = current().binding;
    state.digest = 'b'.repeat(64);
    expect(inspectFrontDeskExecution(binding, charter)).toEqual({
      ok: false,
      reason: 'configuration_changed',
    });
    expect(reserve().created).toBe(false);
    expect(current().binding).toEqual(binding);
  });
  it('rejects mismatched request and conversation binding fields', () => {
    reserve();
    const binding = current().binding;
    expect(
      inspectFrontDeskExecution({ ...binding, conversation_key: 'b'.repeat(64) }, charter).ok
    ).toBe(false);
    expect(inspectFrontDeskExecution({ ...binding, request_id: id(9) }, charter).ok).toBe(false);
    expect(inspectFrontDeskExecution({ ...binding, revision: 2 }, charter).ok).toBe(false);
  });
  it('invalidates pending authority on explicit follow-up without approving a new revision', () => {
    reserve();
    const binding = current().binding;
    const turn = reserveConversationTurn(viewer, 'Add a chart to ' + id(1), id(2));
    expect(turn.routing).toMatchObject({ kind: 'followup', authority: 'none' });
    expect(current().request).toMatchObject({ revision: 2, status: 'invalidated' });
    expect(inspectFrontDeskExecution(binding, charter)).toEqual({
      ok: false,
      reason: 'invalidated',
    });
    expect(current().binding).toEqual(binding);
  });
  it('records cancel_requested separately from completed cancellation', () => {
    reserve();
    const binding = current().binding;
    const turn = reserveConversationTurn(viewer, 'Cancel ' + id(1), id(2));
    expect(turn.routing).toMatchObject({
      kind: 'cancellation',
      authority: 'none',
      reply: expect.stringContaining('already running effect'),
    });
    expect(current().request).toMatchObject({ revision: 2, status: 'cancel_requested' });
    expect(inspectFrontDeskExecution(binding, charter)).toEqual({
      ok: false,
      reason: 'cancel_requested',
    });
  });
  it('chat approvals remain inert and do not mutate pending execution authority', () => {
    reserve();
    const before = current();
    const turn = reserveConversationTurn(viewer, 'Approve ' + id(1), id(2));
    expect(turn.routing).toMatchObject({ kind: 'approval', authority: 'none' });
    expect(current()).toEqual(before);
  });
});
describe('front-desk report ownership and restart dedupe', () => {
  it('persists verified reports once and keeps conversational answer separate from work completion', () => {
    reserve();
    state.projection = {
      status: 'work_completed',
      text: 'Verified work completed; artifact receipt checked.',
      reportId: 'report-fixed',
    };
    expect(readConversationExecutionReports(viewer)).toHaveLength(1);
    const writes = state.writes;
    state.files.set(conversationRef(viewer).path, JSON.parse(JSON.stringify(transcript())));
    const history = readConversationHistory(viewer);
    expect(history.messages.filter((message) => message.id === 'report-fixed')).toHaveLength(1);
    expect(state.writes).toBe(writes);
    expect(transcript().taskState.tasks[0].state).toBe('needs_execution');
    const status = reserveConversationTurn(viewer, 'status of ' + id(1), id(2));
    expect(status.routing?.reply).toContain('Verified work completed');
  });
  it('does not project another viewer history and does not queue retries when reporting is unavailable', () => {
    reserve();
    const binding = current().binding;
    state.projection = undefined;
    expect(readConversationExecutionReports(viewer)).toEqual([]);
    expect(readConversationHistory({ ...viewer, principalId: 'human:bob' }).messages).toEqual([]);
    expect(listConfiguredFrontDeskExecutions()).toHaveLength(1);
    expect(current().binding).toEqual(binding);
  });
  it('keeps legacy v2 receipts inert even when the text exactly matches the new command', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, id(1));
    completeConversationTurn(viewer, id(1), 'Recorded in earlier v2');
    const row = transcript();
    row.turns[0].routing.reply = 'Recorded in earlier v2';
    row.taskState.clarification = {
      kind: 'followup',
      sourceTurnId: id(2),
      sourceText: 'add a chart',
      candidateIds: [id(1)],
    };
    state.files.set(conversationRef(viewer).path, row);
    state.mappings = [
      {
        id: 'receipt',
        viewer,
        dotId: charter.dot_id,
        exactCommand: FRONT_DESK_RECEIPT_COMMAND,
        pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
      },
    ];
    expect(readConversationHistory(viewer).messages.at(-1)?.text).toBe('Recorded in earlier v2');
    expect(reserve().created).toBe(false);
    expect(listConfiguredFrontDeskExecutions()).toEqual([]);
    expect(reserveConversationTurn(viewer, '1', id(3)).routing?.kind).toBe('chat');
    expect(transcript().taskState.tasks[0].updates).toEqual([]);
  });
});

describe('durable admission identity regression checks', () => {
  it('rejects a permissive legacy-shaped ID before any configured admission or write', () => {
    expect(() =>
      reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, 'a'.repeat(36))
    ).toThrow('invalid_text');
    expect(state.writes).toBe(0);
    expect(state.files.size).toBe(0);
    expect(readConversationHistory(viewer).messages).toEqual([]);
    reserve();
    expect(inspectFrontDeskExecution(current().binding, charter).ok).toBe(true);
  });
  it('continues reading inert stored legacy IDs without admitting them as executable requests', () => {
    const ref = conversationRef(viewer);
    state.files.set(ref.path, {
      version: 2,
      sessionId: ref.sessionId,
      taskState: { tasks: [] },
      turns: [
        {
          id: 'a'.repeat(36),
          text: 'Legacy greeting',
          reply: 'Legacy response',
          createdAt: 1,
        },
      ],
    });
    expect(readConversationHistory(viewer).messages.map((message) => message.text)).toEqual([
      'Legacy greeting',
      'Legacy response',
    ]);
    expect(listConfiguredFrontDeskExecutions()).toEqual([]);
    expect(state.writes).toBe(0);
  });
  it.each(['pending', 'invalidated', 'cancel_requested'] as const)(
    'cannot recreate an evicted %s request after retry tombstones expire',
    (status) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
      try {
        reserve();
        if (status === 'invalidated')
          reserveConversationTurn(viewer, 'Add a chart to ' + id(1), id(2));
        if (status === 'cancel_requested')
          reserveConversationTurn(viewer, 'Cancel ' + id(1), id(2));
        const initialRequest = structuredClone(current());
        for (let n = 10; n < 62; n++) {
          reserveConversationTurn(viewer, 'hello ' + n, id(n));
          completeConversationTurn(viewer, id(n), 'hello back');
        }
        expect(transcript().turns.some((turn: { id: string }) => turn.id === id(1))).toBe(false);
        expect(
          transcript().droppedRequests.some((entry: { id: string }) => entry.id === id(1))
        ).toBe(true);
        clock.mockReturnValue(1000 + 24 * 60 * 60 * 1000 + 1);
        const before = JSON.stringify(transcript());
        const writes = state.writes;
        expect(() => reserve()).toThrow('request_conflict');
        expect(state.writes).toBe(writes);
        expect(JSON.stringify(transcript())).toBe(before);
        expect(listConfiguredFrontDeskExecutions()).toHaveLength(1);
        expect(current()).toEqual(initialRequest);
        expect(() => readConversationHistory(viewer)).not.toThrow();
        expect(inspectFrontDeskExecution(initialRequest.binding, charter).ok).toBe(
          status === 'pending'
        );
      } finally {
        clock.mockRestore();
      }
    }
  );
});

describe('bounded latest receipt per durable request', () => {
  it('keeps a slot for all 64 requests when earlier completion receives a correction', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      for (let n = 1; n <= 64; n++) reserve(n);
      for (let n = 1; n < 64; n++)
        state.projections.set(id(n), {
          status: 'work_completed',
          text: 'Verified receipt ' + n,
          reportId: 'done-' + n,
        });
      expect(readConversationExecutionReports(viewer)).toHaveLength(63);
      clock.mockReturnValue(2000);
      state.projections.set(id(1), {
        status: 'uncertain',
        text: 'Receipt 1 cannot be verified now',
        reportId: 'unverified-1',
      });
      let reports = readConversationExecutionReports(viewer);
      expect(reports).toHaveLength(63);
      expect(reports.find((report) => report.requestId === id(1))).toMatchObject({
        id: 'unverified-1',
        status: 'uncertain',
        createdAt: 2000,
      });
      state.projections.set(id(64), {
        status: 'work_completed',
        text: 'Verified receipt 64',
        reportId: 'done-64',
      });
      reports = readConversationExecutionReports(viewer);
      expect(reports).toHaveLength(64);
      expect(new Set(reports.map((report) => report.requestId)).size).toBe(64);
      expect(reports.find((report) => report.requestId === id(64))?.id).toBe('done-64');
      clock.mockReturnValue(3000);
      state.projections.set(id(1), {
        status: 'work_completed',
        text: 'Receipt 1 verified again',
        reportId: 'done-1',
      });
      reports = readConversationExecutionReports(viewer);
      expect(reports).toHaveLength(64);
      expect(reports.find((report) => report.requestId === id(1))).toMatchObject({
        id: 'done-1',
        status: 'work_completed',
        createdAt: 3000,
      });
      const writes = state.writes;
      state.files.set(conversationRef(viewer).path, JSON.parse(JSON.stringify(transcript())));
      expect(readConversationExecutionReports(viewer)).toEqual(reports);
      expect(state.writes).toBe(writes);
    } finally {
      clock.mockRestore();
    }
  });
  it('migrates earlier duplicate receipts to each request latest projection without losing another completion', () => {
    reserve(1);
    reserve(2);
    const row = transcript();
    row.executionReports = [
      {
        id: 'done-1',
        requestId: id(1),
        status: 'work_completed',
        text: 'Original completed report',
        createdAt: 1,
      },
      {
        id: 'unverified-1',
        requestId: id(1),
        status: 'uncertain',
        text: 'Correction',
        createdAt: 2,
      },
    ];
    state.files.set(conversationRef(viewer).path, row);
    state.projections.set(id(1), {
      status: 'uncertain',
      text: 'Correction',
      reportId: 'unverified-1',
    });
    state.projections.set(id(2), {
      status: 'work_completed',
      text: 'Second completed report',
      reportId: 'done-2',
    });
    const reports = readConversationExecutionReports(viewer);
    expect(reports.map((report) => report.id)).toEqual(['unverified-1', 'done-2']);
    expect(transcript().executionReports).toHaveLength(2);
    expect(
      readConversationHistory(viewer).messages.some((message) => message.id === 'done-1')
    ).toBe(false);
  });
});

describe('public-only diagnostic admission', () => {
  it.each([
    { tiers: ['confidential'] },
    { tiers: ['personal'] },
    { tiers: ['public', 'confidential'] },
    { tiers: ['public', 'personal'] },
  ])('never downgrades protected input %j into public execution', ({ tiers }) => {
    const protectedViewer = {
      ...viewer,
      tierAccess: tiers as FrontDeskConversationViewer['tierAccess'],
    };
    // Inject a mapping past schema validation and stub the digest to prove the store guard independently fails closed.
    state.mappings = [{ ...state.mappings[0], viewer: protectedViewer }];
    const turn = reserveConversationTurn(protectedViewer, FRONT_DESK_RECEIPT_COMMAND, id(1));
    expect(turn.routing?.reply).toBeUndefined();
    expect(listConfiguredFrontDeskExecutions()).toEqual([]);
    expect(state.files.has(conversationRef(viewer).path)).toBe(false);
    const saved = state.files.get(conversationRef(protectedViewer).path) as {
      executionRequests?: unknown[];
      taskState: { tasks: Array<{ workItemId?: string }> };
    };
    expect(saved.executionRequests ?? []).toEqual([]);
    expect(saved.taskState.tasks.every((task) => task.workItemId === undefined)).toBe(true);
  });
  it('blocks a protected mapping injected after public reservation before request inspection', () => {
    reserve();
    const bound = current().binding;
    state.mappings[0].viewer.tierAccess = ['confidential'];
    expect(inspectFrontDeskExecution(bound, charter)).toEqual({
      ok: false,
      reason: 'protected_scope',
    });
  });
});

describe('execution transcript version fence', () => {
  it('publishes atomic execution admission as version 3 so the old writer fails closed', () => {
    reserve();
    expect(transcript().version).toBe(3);
    const accepted = JSON.stringify(transcript());
    // Exact version boundary used by the earlier #929 v2 loader, before any write.
    const oldVersionGuard = (row: { version: number }) => {
      if (row.version !== 1 && row.version !== 2) throw new Error('invalid_history');
    };
    expect(() => oldVersionGuard(transcript())).toThrow('invalid_history');
    expect(JSON.stringify(transcript())).toBe(accepted);
    expect(readConversationHistory(viewer).messages).toHaveLength(2);
  });
  it.each([1, 2])(
    'keeps legacy version %s history readable and inert, with ordinary writes remaining version 2',
    (version) => {
      const ref = conversationRef(viewer);
      state.files.set(ref.path, {
        version,
        sessionId: ref.sessionId,
        turns: [
          {
            id: id(1),
            text: FRONT_DESK_RECEIPT_COMMAND,
            reply: 'Legacy recorded response',
            createdAt: 1,
          },
        ],
        ...(version === 2 ? { taskState: { tasks: [] } } : {}),
      });
      expect(readConversationHistory(viewer).messages.at(-1)?.text).toBe(
        'Legacy recorded response'
      );
      expect(listConfiguredFrontDeskExecutions()).toEqual([]);
      reserveConversationTurn(viewer, 'ordinary greeting', id(2));
      expect(transcript().version).toBe(2);
      expect(transcript().executionRequests ?? []).toEqual([]);
    }
  );
  it('migrates an interim execution-bearing v2 fixture on its next publication without changing authority', () => {
    reserve();
    const bound = current().binding;
    const interim = transcript();
    interim.version = 2;
    state.files.set(conversationRef(viewer).path, interim);
    expect(readConversationHistory(viewer).messages).toHaveLength(2);
    expect(transcript().version).toBe(2);
    reserveConversationTurn(viewer, 'ordinary greeting', id(2));
    expect(transcript().version).toBe(3);
    expect(current().binding).toEqual(bound);
    expect(inspectFrontDeskExecution(bound, charter).ok).toBe(true);
  });
  it('retains version 3 across reports, cancellation, generic replies, uncertainty, and retry reservation', () => {
    reserve();
    state.projections.set(id(1), {
      status: 'work_completed',
      text: 'Verified receipt',
      reportId: 'done-1',
    });
    readConversationExecutionReports(viewer);
    expect(transcript().version).toBe(3);
    state.projections.set(id(1), {
      status: 'uncertain',
      text: 'Receipt needs verification',
      reportId: 'unverified-1',
    });
    readConversationHistory(viewer);
    expect(transcript().version).toBe(3);
    reserveConversationTurn(viewer, 'Cancel ' + id(1), id(2));
    expect(transcript().version).toBe(3);
    reserveConversationTurn(viewer, 'ordinary greeting', id(3));
    expect(transcript().version).toBe(3);
    markConversationTurnNotStarted(viewer, id(3));
    expect(transcript().version).toBe(3);
    reserveConversationTurn(viewer, 'ordinary greeting', id(3));
    expect(transcript().version).toBe(3);
    markConversationTurnUncertain(viewer, id(3));
    expect(transcript().version).toBe(3);
    completeConversationTurn(viewer, id(3), 'ordinary answer');
    expect(transcript().version).toBe(3);
    expect(current().request.status).toBe('cancel_requested');
    expect(transcript().executionReports).toHaveLength(1);
  });
  it('never downgrades an existing version 3 even when its execution collections are empty', () => {
    const ref = conversationRef(viewer);
    state.files.set(ref.path, {
      version: 3,
      sessionId: ref.sessionId,
      turns: [],
      taskState: { tasks: [] },
      executionRequests: [],
      executionReports: [],
    });
    reserveConversationTurn(viewer, 'ordinary greeting', id(1));
    expect(transcript().version).toBe(3);
    completeConversationTurn(viewer, id(1), 'ordinary answer');
    expect(transcript().version).toBe(3);
  });
});

describe('immutable diagnostic artifact revision reservations', () => {
  const target = () => ({
    requestId: id(1),
    revision: 1,
    sha256: 'b'.repeat(64),
    format: 'compact' as const,
  });
  function completedParent() {
    reserve();
    state.projections.set(id(1), {
      status: 'work_completed',
      text: 'Verified receipt',
      reportId: 'parent-report',
      artifactPath: 'verified-parent.json',
      artifactSha256: 'b'.repeat(64),
    });
  }
  const revise = (n = 2, input = target()) =>
    reserveConversationTurn(
      viewer,
      frontDeskArtifactRevisionCommand(input.format),
      id(n),
      Date.now(),
      undefined,
      input
    );
  it('atomically records fresh child authority and immutable parent lineage with a v4 writer fence', () => {
    completedParent();
    const parent = structuredClone(current());
    const writes = state.writes;
    const turn = revise();
    expect(state.writes).toBe(writes + 1);
    expect(turn.routing?.authority).toBe('none');
    const entries = listConfiguredFrontDeskExecutions();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(parent);
    expect(entries[1].binding).toMatchObject({
      revision: 2,
      parent_request_id: id(1),
      parent_revision: 1,
      parent_sha256: target().sha256,
      receipt_format: 'compact',
      request_digest: frontDeskArtifactRevisionDigest(target()),
    });
    expect(entries[1].binding.work_item_id).not.toBe(parent.binding.work_item_id);
    expect(transcript().version).toBe(4);
    expect(inspectFrontDeskExecution(entries[1].binding, charter)).toMatchObject({ ok: true });
    const artifact = readConversationHistory(viewer).messages.find(
      (m) => m.id === 'parent-report'
    )?.artifact;
    expect(artifact).toMatchObject({ requestId: id(1), revision: 1, canRevise: false });
  });
  it('replays an exact retry without another child and rejects changed payload or concurrent feedback', () => {
    completedParent();
    const first = revise();
    expect(revise()).toMatchObject({ created: false, id: first.id });
    expect(() => revise(2, { ...target(), sha256: 'c'.repeat(64) })).toThrow('request_conflict');
    expect(() => revise(3)).toThrow('revision_conflict');
    expect(listConfiguredFrontDeskExecutions()).toHaveLength(2);
  });
  it('fails closed on stale, unauthorized, unverified, same-format and malformed targets without mutating the parent', () => {
    completedParent();
    const before = structuredClone(transcript());
    expect(() => revise(2, { ...target(), revision: 2 })).toThrow('revision_target_unavailable');
    expect(() => revise(2, { ...target(), sha256: 'c'.repeat(64) })).toThrow(
      'revision_target_unavailable'
    );
    expect(() =>
      reserveConversationTurn(
        { ...viewer, principalId: 'human:other' },
        frontDeskArtifactRevisionCommand('compact'),
        id(2),
        Date.now(),
        undefined,
        target()
      )
    ).toThrow('revision_target_unavailable');
    expect(() => revise(2, { ...target(), format: 'readable' as 'compact' })).toThrow(
      'invalid_revision'
    );
    expect(() =>
      reserveConversationTurn(
        viewer,
        'arbitrary instructions',
        id(2),
        Date.now(),
        undefined,
        target()
      )
    ).toThrow('invalid_revision');
    expect(transcript()).toEqual(before);
  });
  it('rechecks parent verification before execution and never accepts unknown parent outcomes', () => {
    completedParent();
    revise();
    const child = listConfiguredFrontDeskExecutions()[1].binding;
    state.projections.set(id(1), { status: 'uncertain', text: 'Unknown outcome' });
    expect(inspectFrontDeskExecution(child, charter)).toMatchObject({
      ok: false,
      reason: 'parent_artifact_unverified',
    });
  });
  it('keeps the new writer fence after unrelated conversation publications', () => {
    completedParent();
    revise();
    reserveConversationTurn(viewer, 'Hello', id(3));
    expect(transcript().version).toBe(4);
  });
});

it('stops offering revisions at the bounded request capacity without hiding completed artifacts', () => {
  for (let n = 1; n <= 64; n++) reserve(n);
  state.projections.set(id(1), {
    status: 'work_completed',
    text: 'Verified receipt',
    reportId: 'capacity-report',
    artifactPath: 'verified.json',
    artifactSha256: 'b'.repeat(64),
  });
  const artifact = readConversationHistory(viewer).messages.find(
    (m) => m.id === 'capacity-report'
  )?.artifact;
  expect(artifact).toMatchObject({ revision: 1, canRevise: false });
});
