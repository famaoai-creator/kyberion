import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrontDeskExecutionBinding,
  FrontDeskExecutionMapping,
} from './front-desk-execution-contract.js';
import type {
  FrontDeskConversationViewer,
  FrontDeskExecutionRequest,
} from './front-desk-conversation-store.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { DotWorkResultRow } from '../dot/dot-state-paths.js';

const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  artifactBytes: new Map<string, string>(),
  mappings: [] as FrontDeskExecutionMapping[],
  items: new Map<string, WorkItem>(),
  results: [] as DotWorkResultRow[],
  reads: [] as string[],
  artifactReads: [] as string[],
  digest: 'a'.repeat(64),
  writes: 0,
  locks: 0,
  failItemRead: false,
}));
vi.mock('../authority.js', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../lock-utils.js', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.locks++;
    return fn();
  },
}));
vi.mock('../workforce/artifact-store.js', () => ({
  readGovernedArtifactJson: (path: string) => {
    state.reads.push(path);
    return structuredClone(state.files.get(path) ?? null);
  },
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) => {
    state.writes++;
    state.files.set(path, structuredClone(value));
  },
}));
vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: (id: string) => {
    if (state.failItemRead) throw new Error('read unavailable');
    return structuredClone(state.items.get(id) ?? null);
  },
}));
vi.mock('../dot/dot-dispatch.js', () => ({ currentDotActions: () => [] }));
vi.mock('../dot/dot-charter.js', () => ({
  listDotCharters: () => [
    {
      charter: {
        dot_id: 'receipt-dot',
        scope: {
          tier: 'public',
          tenant_slug: 'tenant-a',
          organization_id: 'org-a',
          project_id: 'project-a',
        },
      },
    },
  ],
}));
vi.mock('../dot/dot-executor-reports.js', () => ({
  readDotWorkResults: () => structuredClone(state.results),
}));
vi.mock('../secure-io.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../secure-io.js')>();
  const artifactPath = (path: unknown) => String(path).includes('/front-desk/');
  return {
    ...original,
    safeExistsSync: (path: string) =>
      artifactPath(path) ? state.artifactBytes.has(path) : original.safeExistsSync(path),
    safeLstat: (path: string) =>
      artifactPath(path)
        ? { isFile: () => state.artifactBytes.has(path) }
        : original.safeLstat(path),
    safeReadFile: (path: string, options?: { encoding?: string | null }) => {
      if (!artifactPath(path))
        return original.safeReadFile(path, options as Parameters<typeof original.safeReadFile>[1]);
      state.artifactReads.push(path);
      const value = state.artifactBytes.get(path);
      if (value === undefined) throw new Error('missing artifact');
      return options?.encoding === 'utf8' ? value : Buffer.from(value);
    },
  };
});
vi.mock('./front-desk-execution-contract.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./front-desk-execution-contract.js')>();
  return {
    ...original,
    loadFrontDeskExecutionPolicy: () => ({ version: 1, mappings: structuredClone(state.mappings) }),
    frontDeskMappingDigest: () => state.digest,
    getFrontDeskExecutionMapping: (binding: FrontDeskExecutionBinding) =>
      binding.config_digest === state.digest
        ? structuredClone(state.mappings.find((mapping) => mapping.id === binding.mapping_id))
        : undefined,
  };
});

import {
  completeConversationTurn,
  conversationRef,
  markConversationTurnNotStarted,
  markConversationTurnUncertain,
  readConversationHistory,
  readFrontDeskConversationWork,
  reserveConversationTurn,
} from './front-desk-conversation-store.js';
import {
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
  frontDeskArtifactRevisionCommand,
  frontDeskExecutionExpectedContent,
} from './front-desk-execution-contract.js';
import { frontDeskExecutionArtifactPath } from './front-desk-execution-artifact.js';

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
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const transcript = () =>
  state.files.get(conversationRef(viewer).path) as {
    turns: Array<{ id: string; createdAt: number }>;
    taskState: { tasks: Array<Record<string, unknown>> };
    executionRequests: FrontDeskExecutionRequest[];
    executionReports?: Array<Record<string, unknown>>;
  };
const request = (n = 1) =>
  transcript().executionRequests.find((entry) => entry.binding.request_id === id(n))!;
const reserve = (n = 1) => reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, id(n));
const row = (n = 1) =>
  readFrontDeskConversationWork(viewer).tasks.find((task) => task.id === id(n))!;
function materialize(n = 1, status: WorkItem['status'] = 'done') {
  const binding = request(n).binding;
  state.items.set(binding.work_item_id, {
    item_id: binding.work_item_id,
    title: 'Receipt',
    description: '',
    status,
    priority: 'normal',
    source: 'local',
    source_ref: 'test',
    project_id: 'project-a',
    labels: [],
    dependencies: [],
    version: 1,
    created_at: new Date(1000).toISOString(),
    updated_at: new Date(2000).toISOString(),
    current_attempt_id: 'attempt-' + n,
    context: { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'project-a' },
    metadata: { front_desk_execution: binding, action_ref: 'action-' + n },
  });
  const path = frontDeskExecutionArtifactPath(binding, state.mappings[0]);
  const content = frontDeskExecutionExpectedContent(
    binding,
    state.mappings[0],
    conversationRef(viewer).sessionId
  );
  const sha256 = createHash('sha256').update(content).digest('hex');
  state.artifactBytes.set(path, content);
  state.results.push({
    dot_id: 'receipt-dot',
    work_item_id: binding.work_item_id,
    action_ref: 'action-' + n,
    attempt_id: 'attempt-' + n,
    mode: 'pipeline',
    status: 'done',
    summary: 'Completed ' + path,
    started_at: new Date(1000).toISOString(),
    completed_at: new Date(2000).toISOString(),
    front_desk_verification: {
      artifact_path: path,
      sha256,
      revision: binding.revision,
      request_digest: binding.request_digest,
      verified_at: new Date(2000).toISOString(),
    },
  });
  return { path, content, sha256 };
}
function revise(parent = 1, child = 2) {
  const artifact = row(parent).artifact!;
  const format = artifact.format === 'readable' ? 'compact' : 'readable';
  reserveConversationTurn(
    viewer,
    frontDeskArtifactRevisionCommand(format),
    id(child),
    Date.now(),
    undefined,
    { requestId: id(parent), revision: artifact.revision, sha256: artifact.sha256!, format }
  );
}
function assertReadOnly<T>(read: () => T): T {
  const before = JSON.stringify([...state.files]);
  const writes = state.writes;
  const locks = state.locks;
  state.reads = [];
  const result = read();
  expect(state.writes).toBe(writes);
  expect(state.locks).toBe(locks);
  expect(JSON.stringify([...state.files])).toBe(before);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 5000, toFake: ['Date'] });
  state.files.clear();
  state.artifactBytes.clear();
  state.items.clear();
  state.results = [];
  state.reads = [];
  state.artifactReads = [];
  state.writes = 0;
  state.locks = 0;
  state.failItemRead = false;
  state.digest = 'a'.repeat(64);
  state.mappings = [
    {
      id: 'receipt',
      viewer: structuredClone(viewer),
      dotId: 'receipt-dot',
      exactCommand: FRONT_DESK_RECEIPT_COMMAND,
      pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
    },
  ];
});
afterEach(() => vi.useRealTimers());

describe('exact-viewer read-only conversation work projection', () => {
  it('does not create an absent transcript, lock, report, or work item', () => {
    expect(assertReadOnly(() => readFrontDeskConversationWork(viewer))).toEqual({
      sessionId: conversationRef(viewer).sessionId,
      tasks: [],
    });
    expect(state.reads).toEqual([conversationRef(viewer).path]);
    expect(state.files.size).toBe(0);
    expect(state.items.size).toBe(0);
  });
  it.each([
    { principalId: 'human:bob' },
    { memberId: 'bob' },
    { source: 'loopback' },
    { role: 'readonly' },
    { tenantSlugs: ['tenant-b'] },
    { organizationIds: ['org-b'] },
    { projectIds: ['project-b'] },
    { tierAccess: ['public', 'confidential'] },
  ])('never crosses a changed identity/restriction: %j', (change) => {
    reserve();
    const other = { ...viewer, ...change } as FrontDeskConversationViewer;
    state.mappings.push({ ...state.mappings[0], id: 'other', viewer: other });
    const result = assertReadOnly(() => readFrontDeskConversationWork(other));
    expect(result.tasks).toEqual([]);
    expect(state.reads).toEqual([conversationRef(other).path]);
    expect(state.reads).not.toContain(conversationRef(viewer).path);
  });
  it('reads only the exact transcript even when another configured partition is malformed', () => {
    reserve();
    const other = { ...viewer, principalId: 'human:bob' };
    state.mappings.push({ ...state.mappings[0], id: 'other', viewer: other });
    state.files.set(conversationRef(other).path, { invalid: true });
    expect(assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks).toHaveLength(1);
    expect(state.reads).toEqual([conversationRef(viewer).path]);
  });
  it('fails closed for missing identity, swapped sessions and malformed history without overwriting it', () => {
    expect(() => readFrontDeskConversationWork({ ...viewer, source: 'anonymous' })).toThrow(
      'identity_required'
    );
    expect(() => readFrontDeskConversationWork({ ...viewer, principalId: undefined })).toThrow(
      'identity_required'
    );
    expect(state.reads).toEqual([]);
    state.files.set(conversationRef(viewer).path, {
      version: 2,
      sessionId: 'other',
      turns: [],
      taskState: { tasks: [] },
    });
    const before = JSON.stringify([...state.files]);
    expect(() => readFrontDeskConversationWork(viewer)).toThrow('invalid_history');
    expect(JSON.stringify([...state.files])).toBe(before);
    expect(state.writes).toBe(0);
  });
  it('bounds and redacts display text, excludes request bodies, and never promotes a recorded work reference', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, 'Create a summary password=hidden-value', id(1));
    const data = transcript();
    data.taskState.tasks[0].workItemId = 'WI-reserved-not-real';
    state.files.set(conversationRef(viewer).path, data);
    const projected = assertReadOnly(() => readFrontDeskConversationWork(viewer));
    expect(projected.tasks[0].title.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(projected)).not.toContain('hidden-value');
    expect(projected.tasks[0]).not.toHaveProperty('requestText');
    expect(projected.tasks[0]).not.toHaveProperty('workItemId');
    expect(projected.tasks[0]).not.toHaveProperty('executionStatus');
  });
  it('retains the 64-task bound and rejects overflow instead of returning an unbounded response', () => {
    state.mappings = [];
    state.files.set(conversationRef(viewer).path, {
      version: 2,
      sessionId: conversationRef(viewer).sessionId,
      turns: [],
      taskState: {
        tasks: Array.from({ length: 64 }, (_, n) => ({
          id: id(n),
          title: 'Request ' + n,
          requestText: 'Create request ' + n,
          createdAt: 1000,
          updates: [],
          state: 'recorded',
        })),
      },
    });
    expect(assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks).toHaveLength(64);
    const data = transcript();
    data.taskState.tasks.push({ ...data.taskState.tasks[0], id: id(65) });
    state.files.set(conversationRef(viewer).path, data);
    expect(() => readFrontDeskConversationWork(viewer)).toThrow('invalid_history');
  });
});

describe('conversation outcomes and pending uncertainty', () => {
  it('maps conversation completion to answered with a recorded excerpt, never verified work completion', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, 'Create a summary', id(1));
    vi.setSystemTime(6000);
    completeConversationTurn(viewer, id(1), 'The answer is ready.', 'answered');
    vi.setSystemTime(9000);
    expect(assertReadOnly(() => row())).toMatchObject({
      id: id(1),
      sourceStatus: 'answered',
      turnState: 'settled',
      resultExcerpt: 'The answer is ready.',
      createdAt: 5000,
      lastRecordedAt: 6000,
    });
    expect(row()).not.toHaveProperty('executionStatus');
    expect(row()).not.toHaveProperty('verifiedAt');
    expect(row()).not.toHaveProperty('artifact');
  });
  it.each(['awaiting_input', 'needs_execution'] as const)(
    'keeps structured %s separate from answered',
    (outcome) => {
      state.mappings = [];
      reserveConversationTurn(viewer, 'Create a summary', id(1));
      completeConversationTurn(viewer, id(1), 'The report is complete.', outcome);
      expect(row().sourceStatus).toBe(outcome);
      expect(row()).not.toHaveProperty('executionStatus');
    }
  );
  it('restores pending, uncertain, and explicitly not-started turns without replay or writes', () => {
    state.mappings = [];
    for (let n = 1; n <= 3; n++) reserveConversationTurn(viewer, 'Create summary ' + n, id(n));
    markConversationTurnUncertain(viewer, id(2));
    markConversationTurnNotStarted(viewer, id(3));
    state.files.set(conversationRef(viewer).path, JSON.parse(JSON.stringify(transcript())));
    expect(
      assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks.map(
        (task) => task.turnState
      )
    ).toEqual(['pending', 'uncertain', 'not_started']);
    expect(state.items.size).toBe(0);
  });
  it('does not let an answered status question hide an uncertain work turn', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, 'Create a summary', id(1));
    markConversationTurnUncertain(viewer, id(1));
    reserveConversationTurn(viewer, 'Status of ' + id(1), id(2));
    expect(assertReadOnly(() => row()).turnState).toBe('uncertain');
  });
  it('uses unknown for an evicted unresolved turn without assigning a fresh timestamp', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, 'Create a summary', id(1));
    const data = transcript();
    data.turns = [];
    state.files.set(conversationRef(viewer).path, data);
    vi.setSystemTime(9000);
    expect(row()).toMatchObject({
      sourceStatus: 'recorded',
      turnState: 'unknown',
      lastRecordedAt: 5000,
    });
  });
});

describe('fresh execution readback and immutable artifact lineage', () => {
  it('does not present the reserved binding as an existing WorkItem before approval', () => {
    reserve();
    const projected = assertReadOnly(() => row());
    expect(projected).toMatchObject({
      sourceStatus: 'needs_execution',
      executionStatus: 'awaiting_approval',
      artifact: { verification: 'pending', currentness: 'requested_pending' },
    });
    expect(projected).not.toHaveProperty('workItemId');
    expect(projected).not.toHaveProperty('verifiedAt');
    expect(projected.artifact).not.toHaveProperty('sha256');
  });
  it.each([
    ['ready', 'queued'],
    ['in_progress', 'running'],
  ] as const)('projects real %s work without inventing verification', (status, expected) => {
    reserve();
    materialize(1, status);
    const projected = assertReadOnly(() => row());
    expect(projected).toMatchObject({
      executionStatus: expected,
      workItemId: request().binding.work_item_id,
    });
    expect(projected).not.toHaveProperty('verifiedAt');
    expect(projected.artifact).not.toHaveProperty('sha256');
  });
  it('checks actual current bytes/hash and exposes checked-now separately from recorded time without artifact paths', () => {
    reserve();
    const receipt = materialize();
    vi.setSystemTime(9000);
    const projected = assertReadOnly(() => row());
    expect(projected).toMatchObject({
      sourceStatus: 'needs_execution',
      executionStatus: 'work_completed',
      lastRecordedAt: 5000,
      verifiedAt: 9000,
      workItemId: request().binding.work_item_id,
      artifact: {
        requestId: id(1),
        revision: 1,
        format: 'readable',
        sha256: receipt.sha256,
        verifiedAt: 9000,
        verification: 'verified',
        currentness: 'latest_verified',
      },
    });
    expect(state.artifactReads).toContain(receipt.path);
    expect(JSON.stringify(projected)).not.toContain(receipt.path);
    expect(projected.artifact).not.toHaveProperty('artifactPath');
    expect(projected.artifact).not.toHaveProperty('changeReason');
    expect(transcript().executionReports ?? []).toHaveLength(0);
  });
  it('never reuses a persisted successful receipt after byte tampering or missing artifact', () => {
    reserve();
    const receipt = materialize();
    readConversationHistory(viewer); // Establish the older durable success report.
    expect(transcript().executionReports?.[0].status).toBe('work_completed');
    state.artifactBytes.set(receipt.path, receipt.content + ' ');
    const projected = assertReadOnly(() => row());
    expect(projected.executionStatus).toBe('uncertain');
    expect(projected.artifact).toMatchObject({
      verification: 'unknown',
      currentness: 'requested_unknown',
    });
    expect(projected).not.toHaveProperty('verifiedAt');
    expect(projected.artifact).not.toHaveProperty('sha256');
    expect(JSON.stringify(projected)).not.toContain('Completed');
    expect(JSON.stringify(projected)).not.toContain(receipt.path);
    state.artifactBytes.delete(receipt.path);
    expect(assertReadOnly(() => row()).executionStatus).toBe('uncertain');
  });
  it.each(['mapping', 'digest', 'readback'] as const)(
    'shows unknown and removes verification after %s is unavailable',
    (cause) => {
      reserve();
      materialize();
      readConversationHistory(viewer);
      if (cause === 'mapping') state.mappings = [];
      if (cause === 'digest') state.digest = 'b'.repeat(64);
      if (cause === 'readback') state.failItemRead = true;
      const projected = assertReadOnly(() => row());
      expect(projected.executionStatus).toBe('unknown');
      expect(projected.artifact?.verification).toBe('unknown');
      expect(projected).not.toHaveProperty('workItemId');
      expect(projected).not.toHaveProperty('verifiedAt');
      expect(projected.artifact).not.toHaveProperty('sha256');
    }
  );
  it.each(['scope', 'binding'] as const)(
    'never associates a mismatched governed item: %s',
    (change) => {
      reserve();
      materialize();
      const item = state.items.get(request().binding.work_item_id)!;
      if (change === 'scope') item.context!.project_id = 'other-project';
      else item.metadata!.front_desk_execution = { ...request().binding, revision: 2 };
      const projected = assertReadOnly(() => row());
      expect(projected.executionStatus).toBe('unknown');
      expect(projected).not.toHaveProperty('workItemId');
      expect(projected.artifact).not.toHaveProperty('sha256');
    }
  );
  it('keeps a verified parent latest while a child is pending, then marks the verified parent older', () => {
    reserve();
    materialize();
    revise();
    let tasks = assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks;
    expect(tasks[0].artifact?.currentness).toBe('latest_verified');
    expect(tasks[1].artifact).toMatchObject({
      requestId: id(2),
      revision: 2,
      format: 'compact',
      parentRequestId: id(1),
      parentRevision: 1,
      changeReason: 'format_change',
      verification: 'pending',
      currentness: 'requested_pending',
    });
    expect(tasks[1].artifact).not.toHaveProperty('sha256');
    materialize(2);
    tasks = assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks;
    expect(tasks[0].artifact?.currentness).toBe('older_verified');
    expect(tasks[1].artifact?.currentness).toBe('latest_verified');
    revise(2, 3);
    tasks = assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks;
    expect(tasks.map((task) => task.artifact?.currentness)).toEqual([
      'older_verified',
      'latest_verified',
      'requested_pending',
    ]);
  });
  it('does not let a newer unverified child hide the latest verified parent or unrelated receipt', () => {
    reserve();
    materialize();
    revise();
    const child = materialize(2);
    reserve(3);
    materialize(3);
    state.artifactBytes.set(child.path, 'corrupted');
    const tasks = assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks;
    expect(tasks.map((task) => task.artifact?.currentness)).toEqual([
      'latest_verified',
      'requested_unknown',
      'latest_verified',
    ]);
    expect(tasks[1].artifact).not.toHaveProperty('sha256');
  });
  it('verifies the parent bytes too, so a valid child cannot outlive tampered parent evidence', () => {
    reserve();
    const parent = materialize();
    revise();
    materialize(2);
    state.artifactBytes.set(parent.path, 'corrupted');
    const tasks = assertReadOnly(() => readFrontDeskConversationWork(viewer)).tasks;
    expect(tasks.map((task) => task.executionStatus)).toEqual(['uncertain', 'uncertain']);
    expect(tasks.every((task) => !task.verifiedAt && !task.artifact?.sha256)).toBe(true);
  });
  it.each([
    ['Cancel ', 'cancel_requested'],
    ['Add a chart to ', 'blocked'],
  ] as const)(
    'preserves %s intent without claiming cancellation or completion',
    (command, status) => {
      reserve();
      materialize();
      reserveConversationTurn(viewer, command + id(1), id(2));
      const projected = assertReadOnly(() => row());
      expect(projected.executionStatus).toBe(status);
      expect(projected).not.toHaveProperty('verifiedAt');
      expect(projected.artifact?.currentness).toBe('requested_unknown');
      expect(projected.artifact).not.toHaveProperty('sha256');
    }
  );
});

describe('read-only history for inert resume', () => {
  it('sanitizes persisted bound status-question replies using the same current readback', () => {
    reserve();
    const receipt = materialize();
    reserveConversationTurn(viewer, 'Status of ' + id(1), id(2));
    expect(JSON.stringify(transcript())).toContain(receipt.path);
    state.artifactReads = [];
    let history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
    expect(JSON.stringify(history)).not.toContain(receipt.path);
    expect(state.artifactReads).toEqual([receipt.path]);
    const completedReply = history.messages.find(
      (message) => message.id === id(2) + '-secretary'
    )!.text;
    state.items.get(request().binding.work_item_id)!.status = 'blocked';
    state.results[0].status = 'blocked';
    state.results[0].summary = 'STATUS_REPLY_PRIVATE_SENTINEL /private/failure.json';
    reserveConversationTurn(viewer, 'Status of ' + id(1), id(3));
    expect(JSON.stringify(transcript())).toContain('STATUS_REPLY_PRIVATE_SENTINEL');
    history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
    expect(JSON.stringify(history)).not.toContain(receipt.path);
    expect(JSON.stringify(history)).not.toContain('STATUS_REPLY_PRIVATE_SENTINEL');
    expect(JSON.stringify(history)).not.toContain('/private/failure.json');
    expect(history.messages.find((message) => message.id === id(2) + '-secretary')!.text).not.toBe(
      completedReply
    );
    expect(history.messages.some((message) => message.artifact)).toBe(false);
  });

  it('never forwards a verified artifact path or raw executor failure summary in a fresh report', () => {
    reserve();
    const receipt = materialize();
    let history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
    expect(history.messages.some((message) => message.artifact?.sha256 === receipt.sha256)).toBe(
      true
    );
    expect(JSON.stringify(history)).not.toContain(receipt.path);
    expect(JSON.stringify(history)).not.toContain('active/shared/artifacts');
    const item = state.items.get(request().binding.work_item_id)!;
    item.status = 'blocked';
    state.results[0].status = 'blocked';
    state.results[0].summary = 'PRIVATE_FAILURE_SENTINEL /private/internal/artifact.json';
    history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
    expect(history.messages.some((message) => message.artifact)).toBe(false);
    expect(JSON.stringify(history)).not.toContain('PRIVATE_FAILURE_SENTINEL');
    expect(JSON.stringify(history)).not.toContain('/private/internal/artifact.json');
    expect(JSON.stringify(history)).not.toContain(receipt.path);
  });

  it('projects freshly verified completion without a lock, report sync, or transcript publication', () => {
    reserve();
    const receipt = materialize();
    vi.setSystemTime(9000);
    const history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
    expect(state.reads).toEqual([conversationRef(viewer).path]);
    expect(history.messages.filter((message) => message.artifact)).toMatchObject([
      { artifact: { requestId: id(1), revision: 1, sha256: receipt.sha256, format: 'readable' } },
    ]);
    expect(state.artifactReads).toContain(receipt.path);
    expect(transcript().executionReports ?? []).toEqual([]);
    expect(assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }))).toEqual(
      history
    );
  });
  it.each(['mapping', 'bytes', 'readback'] as const)(
    'replaces an older successful history report with current uncertainty after %s changes',
    (change) => {
      reserve();
      const receipt = materialize();
      const previous = readConversationHistory(viewer); // Legacy synchronization stays supported.
      const previousSuccess = previous.messages.find((message) => message.artifact)!;
      expect(transcript().executionReports).toHaveLength(1);
      if (change === 'mapping') state.mappings = [];
      if (change === 'bytes') state.artifactBytes.set(receipt.path, 'changed');
      if (change === 'readback') state.failItemRead = true;
      const history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
      expect(history.messages.some((message) => message.artifact)).toBe(false);
      expect(history.messages.some((message) => message.text === previousSuccess.text)).toBe(false);
      expect(JSON.stringify(history)).not.toContain(receipt.path);
      expect(
        history.messages.filter((message) => message.id.startsWith('front-desk-'))
      ).toHaveLength(1);
      expect(transcript().executionReports?.[0].status).toBe('work_completed');
    }
  );
  it('keeps exact-viewer isolation and pending/uncertain turns without reconstructing replies', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, 'Create a summary', id(1));
    markConversationTurnUncertain(viewer, id(1));
    const history = assertReadOnly(() => readConversationHistory(viewer, { readOnly: true }));
    expect(history.pending).toBe(1);
    expect(history.messages).toMatchObject([{ id: id(1) + '-user', role: 'user' }]);
    expect(history.messages).toHaveLength(1);
    const other = { ...viewer, principalId: 'human:bob' };
    expect(
      assertReadOnly(() => readConversationHistory(other, { readOnly: true })).messages
    ).toEqual([]);
    expect(state.reads).toEqual([conversationRef(other).path]);
  });
  it('does not render an orphaned success report lacking a current executable request', () => {
    state.mappings = [];
    reserveConversationTurn(viewer, 'Create a summary', id(1));
    const data = transcript();
    data.executionReports = [
      {
        id: 'front-desk-orphan',
        requestId: id(2),
        status: 'work_completed',
        text: 'Obsolete successful execution',
        createdAt: 5000,
      },
    ];
    state.files.set(conversationRef(viewer).path, data);
    expect(
      assertReadOnly(() => readConversationHistory(viewer, { readOnly: true })).messages.some(
        (message) => message.id === 'front-desk-orphan'
      )
    ).toBe(false);
  });
});
