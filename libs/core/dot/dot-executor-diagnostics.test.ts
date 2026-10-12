import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '../authority.js';
import * as locks from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { storageFloorRelativePath, SYSTEM_PARTITION } from '../storage-layout.js';
import {
  clearWorkCoordinationNamespace,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import type {
  WorkEffectOwnership,
  WorkItem,
  WorkItemAttempt,
} from '../workforce/work-coordination-types.js';
import type { DotCharter } from './dot-charter.js';
import { inspectDotExecution, type DotExecutionObservation } from './dot-executor-diagnostics.js';
import { inspectExecutorSchedulingCursor } from './dot-executor-scheduling.js';
import { DOT_STATE_ROOT, dotStatePath, DOT_WORK_RESULTS_FILE } from './dot-state-paths.js';
import { dotExecutorStatusSection } from './dot-executor.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const EARLIER = '2026-10-11T11:00:00.000Z';
const NAMESPACE = 'dot-executor-diagnostics';
let root: string;
let sequence = 0;

function charter(
  scope: DotCharter['scope'] = {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'ops-org',
  }
): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'ops',
    version: '1.0.0',
    title: 'Ops dot',
    purpose: 'Observe operations.',
    status: 'active',
    scope,
    goal: {
      statement: 'Observe operations.',
      budget: { wall_clock_ms_per_wake: 120_000, max_turns_per_wake: 4 },
    },
    attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *' }] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_work_shapes: ['task_session'],
    },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: 'dot-ops' },
  };
}

function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    item_id: id,
    title: 'Synthetic work ' + id,
    description: 'Synthetic diagnostics fixture.',
    status: 'ready',
    priority: 'normal',
    source: 'local',
    source_ref: id,
    project_id: 'diagnostics-project',
    labels: [],
    dependencies: [],
    version: 1,
    created_at: EARLIER,
    updated_at: EARLIER,
    context: {
      tenant_slug: 'acme',
      organization_id: 'ops-org',
      project_id: 'diagnostics-project',
      work_shape: 'routine_operation',
    },
    metadata: { dot_id: 'ops', action_ref: 'action-' + id },
    ...overrides,
  };
}

function attempt(runId: string, overrides: Partial<WorkItemAttempt> = {}): WorkItemAttempt {
  return {
    attempt_id: 'attempt-' + runId,
    run_id: runId,
    status: 'failed',
    started_at: EARLIER,
    ended_at: '2026-10-11T11:10:00.000Z',
    actor_peer_id: 'dot:ops',
    ...overrides,
  };
}

function hold(runId: string, overrides: Partial<WorkEffectOwnership> = {}): WorkEffectOwnership {
  return {
    target: 'path:docs/operations.md',
    attempt_id: runId,
    actor_id: 'dot:ops',
    tenant_slug: 'acme',
    state: 'held',
    acquired_at: EARLIER,
    ...overrides,
  };
}

const cursorFile = () => path.join(root, DOT_STATE_ROOT, 'executor-schedule.json');
const itemsFile = () =>
  path.join(root, 'active/shared/runtime/work-coordination', NAMESPACE, 'items.jsonl');

async function write(file: string, content: string): Promise<void> {
  await withExecutionContextAsync('ecosystem_architect', async () => {
    safeMkdir(path.dirname(file), { recursive: true });
    safeWriteFile(file, content);
  });
}

async function inventory(rows: unknown[]): Promise<void> {
  await write(itemsFile(), rows.map((row) => JSON.stringify(row) + '\n').join(''));
}

type Inspection = Record<string, unknown> & {
  items: DotExecutionObservation[];
  scheduling: ReturnType<typeof inspectExecutorSchedulingCursor>;
};

function inspect(c = charter(), now = NOW): Inspection {
  return inspectDotExecution(c, { rootDir: root, now: () => now }) as Inspection;
}

/** Names, directory entries and content hashes expose writes, deletes and new store/lock files. */
function snapshot(dir: string): Record<string, string> {
  if (!safeExistsSync(dir)) return {};
  const result: Record<string, string> = {};
  for (const name of safeReaddir(dir).sort()) {
    const file = path.join(dir, name);
    if (safeLstat(file).isDirectory()) {
      result[name + '/'] = 'directory';
      for (const [child, hash] of Object.entries(snapshot(file))) result[name + '/' + child] = hash;
    } else {
      result[name] = createHash('sha256').update(safeReadFile(file)).digest('hex');
    }
  }
  return result;
}

beforeEach(async () => {
  root = pathResolver.rootResolve(
    storageFloorRelativePath(
      'scratch',
      SYSTEM_PARTITION,
      'dot-executor-diagnostics-tests',
      String(process.pid) + '-' + String(++sequence)
    )
  );
  setWorkCoordinationNamespace(NAMESPACE);
  await withExecutionContextAsync('ecosystem_architect', async () => {
    safeMkdir(root, { recursive: true });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearWorkCoordinationNamespace();
  await withExecutionContextAsync('ecosystem_architect', async () => {
    safeRmSync(root, { recursive: true, force: true });
  });
});

describe('read-only executor scheduling evidence', () => {
  it('distinguishes a missing cursor from a confirmed healthy executor', () => {
    expect(inspect().scheduling).toMatchObject({ state: 'unrecorded' });
    expect(inspect().scheduling.next).toContain('absence alone does not prove');
    expect(safeExistsSync(cursorFile())).toBe(false);
  });

  it('reports malformed JSON syntax as blocking normal sweeps without exposing parser details', async () => {
    await write(cursorFile(), '{ "after":');
    const result = inspect().scheduling;
    expect(result.state).toBe('blocked');
    expect(result.reason).toContain('normal executor sweeps stop before claiming work');
    expect(result.next).toContain('do not delete or reset');
    expect(JSON.stringify(result)).not.toMatch(/SyntaxError|Unexpected|after/);
  });

  it.each([{}, [], { after: '' }, { after: 42 }, 'invalid'])(
    'reports truthy invalid cursor shape %j as blocked',
    async (value) => {
      await write(cursorFile(), JSON.stringify(value));
      const result = inspect().scheduling;
      expect(result.state).toBe('blocked');
      expect(result.reason).toContain('stop before claiming work');
      expect(result.next).toContain('do not delete or reset');
    }
  );

  it.each([null, false, 0, ''])('reports falsy persisted cursor %j as blocked', async (value) => {
    await write(cursorFile(), JSON.stringify(value));
    const result = inspect().scheduling;
    expect(result.state).toBe('blocked');
    expect(result.reason).toContain('normal executor sweeps stop before claiming work');
  });

  it('accepts a valid recorded cursor without promising liveness', async () => {
    await write(cursorFile(), JSON.stringify({ after: 'ops:synthetic-scope-hash' }));
    const result = inspect().scheduling;
    expect(result.state).toBe('recorded');
    expect(result.reason).toContain('liveness is not established');
  });
});

describe('strict inventory and scope projection', () => {
  it('reports a missing inventory as unknown rather than an empty healthy queue', () => {
    expect(inspect()).toMatchObject({ inventory: 'unknown', items: [] });
    expect(inspect().reason).toContain('store is missing');
    expect(safeExistsSync(itemsFile())).toBe(false);
  });

  it('distinguishes a present empty inventory from missing evidence', async () => {
    await inventory([]);
    expect(inspect()).toMatchObject({
      inventory: 'no_current_evidence',
      items_total: 0,
      items: [],
    });
    expect(inspect().reason).toContain('not proof of healthy progression');
  });

  it.each(['{invalid-json\n', '{}\n', 'null\n', 'false\n'])(
    'contains invalid inventory %j without echoing parser details',
    async (content) => {
      await write(itemsFile(), content);
      const result = inspect();
      expect(result).toMatchObject({ inventory: 'unknown', items: [] });
      expect(JSON.stringify(result)).not.toContain('SyntaxError');
    }
  );

  it('validates malformed historical rows before latest-snapshot deduplication', async () => {
    const invalid = { ...item('same'), context: { project_id: 'diagnostics-project' } };
    await inventory([invalid, item('same', { version: 2 })]);
    expect(inspect()).toMatchObject({ inventory: 'unknown', items: [] });
  });

  it('projects only exact typed tenant and organization before inspecting private ownership', async () => {
    const secret = 'FOREIGN-PRIVATE-EVIDENCE';
    const foreign = (id: string, context: WorkItem['context']) =>
      item(id, {
        context,
        description: secret,
        effect_ownership: { secret } as unknown as WorkEffectOwnership,
        metadata: { dot_id: 'ops', target: { secret }, dot_executor: { summary: secret } },
      });
    await inventory([
      item('visible'),
      foreign('foreign-tenant', {
        tenant_slug: 'other',
        organization_id: 'ops-org',
        project_id: 'diagnostics-project',
        work_shape: 'routine_operation',
      }),
      foreign('foreign-org', {
        tenant_slug: 'acme',
        organization_id: 'other-org',
        project_id: 'diagnostics-project',
        work_shape: 'routine_operation',
      }),
      foreign('missing-org', {
        tenant_slug: 'acme',
        project_id: 'diagnostics-project',
        work_shape: 'routine_operation',
      }),
      foreign('missing-tenant', {
        organization_id: 'ops-org',
        project_id: 'diagnostics-project',
        work_shape: 'routine_operation',
      }),
    ]);
    const result = inspect();
    expect(result).toMatchObject({ inventory: 'observed', items_total: 1 });
    expect(result.items).toMatchObject([{ work_item_id: 'visible', state: 'queued' }]);
    expect(JSON.stringify(result)).not.toMatch(
      /FOREIGN-PRIVATE-EVIDENCE|foreign-tenant|foreign-org|missing-org|missing-tenant/
    );
  });

  it('does not infer scope or mission associations from labels and metadata', async () => {
    await inventory([
      item('label-only', {
        context: { project_id: 'diagnostics-project', work_shape: 'routine_operation' },
        labels: ['mission:MSN-PRIVATE-LABEL', 'tenant:acme', 'organization:ops-org'],
        metadata: {
          dot_id: 'ops',
          tenant_slug: 'acme',
          organization_id: 'ops-org',
          mission_id: 'MSN-PRIVATE-METADATA',
        },
      }),
      item('typed-scope', { labels: ['mission:MSN-UNVERIFIED-ASSOCIATION'] }),
    ]);
    const result = inspect();
    expect(result.items.map((entry) => entry.work_item_id)).toEqual(['typed-scope']);
    expect(JSON.stringify(result)).not.toMatch(/MSN-PRIVATE|MSN-UNVERIFIED|label-only/);
  });

  it('keeps the unscoped charter separate from tenant and organization items', async () => {
    await inventory([
      item('tenant-item'),
      item('unscoped', {
        context: { project_id: 'diagnostics-project', work_shape: 'routine_operation' },
      }),
    ]);
    expect(inspect(charter({ tier: 'public' })).items.map((entry) => entry.work_item_id)).toEqual([
      'unscoped',
    ]);
  });

  it('honors explicit handoff addressing within the exact scope', async () => {
    await inventory([
      item('handed-away', { metadata: { dot_id: 'ops', handoff_to: 'another-dot' } }),
      item('handed-in', { metadata: { dot_id: 'another-dot', handoff_to: 'ops' } }),
      item('unaddressed', { metadata: { dot_id: 'another-dot' } }),
    ]);
    expect(inspect().items.map((entry) => entry.work_item_id)).toEqual(['handed-in']);
  });
});

describe('current execution and retained effect evidence', () => {
  it('retains the exact archived held attempt after the current ID is cleared', async () => {
    await inventory([
      item('archived', {
        status: 'archived',
        attempts: [attempt('run-held')],
        effect_ownership: hold('run-held'),
      }),
    ]);
    const observed = inspect().items[0];
    expect(observed).toMatchObject({
      work_item_id: 'archived',
      item_status: 'archived',
      state: 'blocked',
      reason_code: 'retained_effect_hold',
      held_attempt_id: 'run-held',
      latest_recorded_attempt_id: 'run-held',
      observed_since: EARLIER,
      age_ms: 3_600_000,
    });
    expect(observed).not.toHaveProperty('current_attempt_id');
    expect(observed.next).toContain('verify execution stopped');
    expect(observed.next).toContain('pnpm kyberion dot release <dot_id> <work_item_id>');
    expect(observed.next).toContain('human approval');
  });

  it('does not relabel an explicitly held old attempt as the current running attempt', async () => {
    await inventory([
      item('mismatch', {
        status: 'in_progress',
        current_attempt_id: 'run-new',
        attempts: [
          attempt('run-old'),
          attempt('run-new', { status: 'running', ended_at: undefined }),
        ],
        effect_ownership: hold('run-old'),
      }),
    ]);
    expect(inspect().items[0]).toMatchObject({
      state: 'unknown',
      reason_code: 'held_evidence_inconsistent',
      held_attempt_id: 'run-old',
      current_attempt_id: 'run-new',
      latest_recorded_attempt_id: 'run-new',
    });
  });

  it('treats a normal current running owner as in flight, even when its hold is old', async () => {
    const old = '2026-10-01T12:00:00.000Z';
    await inventory([
      item('running-owner', {
        status: 'in_progress',
        current_attempt_id: 'run-live',
        attempts: [
          attempt('run-live', { status: 'running', started_at: old, ended_at: undefined }),
        ],
        effect_ownership: hold('run-live', { acquired_at: old }),
      }),
    ]);
    const observed = inspect().items[0];
    expect(observed).toMatchObject({
      state: 'running',
      reason_code: 'running_owner_snapshot',
      age_ms: 864_000_000,
    });
    expect(observed.reason).toContain('does not prove live execution');
    expect(observed.next).toContain('before any retry');
    expect(observed.next).not.toContain('dot release');
  });

  it('does not confuse an unowned running snapshot with established liveness', async () => {
    await inventory([
      item('running', {
        status: 'in_progress',
        current_attempt_id: 'run-live',
        attempts: [attempt('run-live', { status: 'running', ended_at: undefined })],
      }),
    ]);
    const observed = inspect().items[0];
    expect(observed).toMatchObject({ state: 'running', reason_code: 'running_snapshot' });
    expect(observed.reason).toContain('liveness is not established');
  });

  it('does not manufacture a current attempt from the latest historical attempt', async () => {
    await inventory([
      item('missing-current', { status: 'in_progress', attempts: [attempt('run-old')] }),
    ]);
    expect(inspect().items[0]).toMatchObject({
      state: 'unknown',
      reason_code: 'item_evidence_unusable',
      latest_recorded_attempt_id: 'run-old',
    });
    expect(inspect().items[0]).not.toHaveProperty('current_attempt_id');
  });

  it('reports absent held-attempt history as inconsistent instead of safe to retry', async () => {
    await inventory([
      item('missing-attempt', {
        status: 'archived',
        effect_ownership: hold('run-unrecorded'),
      }),
    ]);
    expect(inspect().items[0]).toMatchObject({
      state: 'unknown',
      reason_code: 'held_evidence_inconsistent',
      held_attempt_id: 'run-unrecorded',
    });
  });

  it('uses the latest ready snapshot after operator verification supersedes blocked metadata', async () => {
    const reopened = item('reopened', {
      version: 2,
      metadata: {
        dot_id: 'ops',
        target: 'path:docs/operations.md',
        dot_executor: {
          status: 'blocked',
          mode: 'pipeline',
          completed_at: '2026-10-11T11:10:00.000Z',
          operator_verified_at: '2026-10-11T11:30:00.000Z',
          operator_verified_reason: 'Synthetic verified reconciliation.',
        },
      },
      attempts: [attempt('run-old', { failure_reason: 'lease_expired' })],
    });
    await inventory([item('reopened', { status: 'blocked' }), reopened]);
    const observed = inspect().items[0];
    expect(inspect().items_total).toBe(1);
    expect(observed).toMatchObject({
      state: 'queued',
      reason_code: 'ready_snapshot',
      item_status: 'ready',
      latest_recorded_attempt_id: 'run-old',
    });
    expect(observed).not.toHaveProperty('held_attempt_id');
    expect(observed.next).toContain(
      'Unsuperseded terminal results and expired attempts can still block'
    );
  });

  it.each(['2026-10-12T12:00:00.000Z', 'invalid-date'])(
    'does not turn unusable item timestamp %s into a numeric age',
    async (updated_at) => {
      await inventory([item('time-unknown', { updated_at })]);
      expect(inspect().items[0]).toMatchObject({
        state: 'unknown',
        reason_code: 'item_evidence_unusable',
        age_ms: null,
      });
    }
  );

  it.each(['2026-10-12T12:00:00.000Z', 'invalid-date'])(
    'does not turn unusable hold timestamp %s into a numeric age',
    async (acquired_at) => {
      await inventory([
        item('hold-time-unknown', {
          status: 'archived',
          attempts: [attempt('held')],
          effect_ownership: hold('held', { acquired_at }),
        }),
      ]);
      expect(inspect().items[0]).toMatchObject({
        state: 'unknown',
        reason_code: 'held_evidence_inconsistent',
        age_ms: null,
      });
    }
  );

  it('contains an invalid observation clock without throwing or inventing ages', async () => {
    await inventory([item('clock-unknown')]);
    expect(inspect(charter(), new Date('invalid'))).toMatchObject({
      observed_at: null,
      items: [{ state: 'unknown', age_ms: null }],
    });
  });

  it('finds a same-scope target owner even when it is addressed to another dot', async () => {
    await inventory([
      item('waiting', { metadata: { dot_id: 'ops', target: 'path:docs/operations.md' } }),
      item('other-owner', {
        status: 'archived',
        metadata: { dot_id: 'another-dot' },
        attempts: [attempt('held')],
        effect_ownership: hold('held', { target: 'path:docs/**' }),
      }),
    ]);
    expect(inspect().items).toMatchObject([
      {
        work_item_id: 'waiting',
        state: 'blocked',
        reason_code: 'target_owned',
        blocking_work_item_id: 'other-owner',
        held_attempt_id: 'held',
        age_ms: 3_600_000,
      },
    ]);
    expect(inspect().items_total).toBe(1);
  });

  it('never projects foreign-tenant or foreign-organization target owners', async () => {
    await inventory([
      item('waiting', { metadata: { dot_id: 'ops', target: 'path:docs/operations.md' } }),
      item('FOREIGN-ORG-OWNER', {
        context: {
          tenant_slug: 'acme',
          organization_id: 'other-org',
          project_id: 'diagnostics-project',
          work_shape: 'routine_operation',
        },
        effect_ownership: hold('FOREIGN-ORG-RUN'),
      }),
      item('FOREIGN-TENANT-OWNER', {
        context: {
          tenant_slug: 'other',
          organization_id: 'ops-org',
          project_id: 'diagnostics-project',
          work_shape: 'routine_operation',
        },
        effect_ownership: hold('FOREIGN-TENANT-RUN', { tenant_slug: 'other' }),
      }),
    ]);
    expect(inspect().items).toMatchObject([
      { work_item_id: 'waiting', state: 'queued', reason_code: 'ready_snapshot' },
    ]);
    expect(JSON.stringify(inspect())).not.toContain('FOREIGN');
  });

  it('prioritizes blockers in bounded output without losing the total', async () => {
    await inventory([
      ...Array.from({ length: 21 }, (_, i) => item('ready-' + String(i).padStart(2, '0'))),
      item('z-blocked', { status: 'blocked' }),
    ]);
    const result = inspect();
    expect(result).toMatchObject({ items_total: 22, items_omitted: 2 });
    expect(result.items).toHaveLength(20);
    expect(result.items[0]).toMatchObject({
      work_item_id: 'z-blocked',
      state: 'blocked',
      reason_code: 'item_blocked',
    });
  });
});

describe('inspection never mutates execution state', () => {
  it.each(['missing', 'valid', 'malformed', 'invalid-shape'] as const)(
    'leaves all store bytes and paths unchanged with a %s cursor and takes no locks',
    async (cursorState) => {
      await inventory([
        item('archived', {
          status: 'archived',
          attempts: [attempt('held')],
          effect_ownership: hold('held'),
        }),
        item('queued'),
      ]);
      const cursorContent = {
        valid: '{ "after": "ops:scope" }\n',
        malformed: '{ "after":',
        'invalid-shape': '{ "after": 0 }\n',
      };
      if (cursorState !== 'missing') await write(cursorFile(), cursorContent[cursorState]);
      await write(
        path.join(path.dirname(itemsFile()), 'leases.jsonl'),
        '{"synthetic":"lease-evidence"}\n'
      );
      await write(
        path.join(root, 'active/shared/observability/work-coordination', NAMESPACE, 'events.jsonl'),
        '{"synthetic":"event-evidence"}\n'
      );
      await write(
        path.join(root, DOT_STATE_ROOT, 'work-results.jsonl'),
        '{"synthetic":"historical-results"}\n'
      );
      await write(
        path.join(root, 'active/shared/runtime/locks', 'existing.lock'),
        '{"synthetic":"retained-lock"}\n'
      );
      const before = snapshot(root);
      const lock = vi.spyOn(locks, 'withLockSync');
      const acquire = vi.spyOn(locks, 'acquireLock');
      const release = vi.spyOn(locks, 'releaseLock');
      const first = inspect();
      expect(first.items[0]).toMatchObject({ work_item_id: 'archived', state: 'blocked' });
      expect(inspect()).toEqual(first);
      expect(snapshot(root)).toEqual(before);
      expect(lock).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    }
  );

  it('creates no files or directories while inspecting missing stores', () => {
    const before = snapshot(root);
    expect(inspect()).toMatchObject({
      inventory: 'unknown',
      scheduling: { state: 'unrecorded' },
    });
    expect(snapshot(root)).toEqual(before);
  });
});

describe('malformed and uncorrelated execution evidence', () => {
  it.each([
    null,
    {},
    [{ run_id: 'run', status: 'running' }],
    [{ attempt_id: 'a', run_id: 'r', status: 'invalid', started_at: EARLIER }],
    [{ attempt_id: 'a', run_id: 'r', status: 'running', started_at: 'not-a-time' }],
  ])('never treats malformed attempts %j as queued or running', async (attempts) => {
    await inventory([{ ...item('malformed'), attempts }]);
    expect(inspect().items[0]).toMatchObject({
      state: 'unknown',
      reason_code: 'item_evidence_unusable',
    });
  });
  it('preserves current diagnosis when historical summary is malformed', async () => {
    const c = charter({ tier: 'public' });
    await inventory([
      item('held', {
        context: { project_id: 'diagnostics-project', work_shape: 'routine_operation' },
        status: 'archived',
        attempts: [attempt('r')],
        effect_ownership: hold('r', { tenant_slug: undefined }),
      }),
    ]);
    await write(
      path.join(root, dotStatePath(c, DOT_WORK_RESULTS_FILE)),
      JSON.stringify({
        dot_id: 'ops',
        work_item_id: 'held',
        action_ref: 'action-held',
        attempt_id: 'r',
        status: 'blocked',
        mode: 'pipeline',
        summary: null,
        started_at: EARLIER,
        completed_at: EARLIER,
      }) + '\n'
    );
    const section = dotExecutorStatusSection().collect(c, { rootDir: root, now: () => NOW });
    expect(section).toMatchObject({
      history_status: 'unavailable',
      execution: { items: [{ work_item_id: 'held', state: 'blocked', held_attempt_id: 'r' }] },
    });
  });
  it('does not claim live execution when a terminal result precedes a failed release', async () => {
    const c = charter({ tier: 'public' });
    await inventory([
      item('held', {
        context: { project_id: 'diagnostics-project', work_shape: 'routine_operation' },
        status: 'in_progress',
        current_attempt_id: 'r',
        attempts: [attempt('r', { status: 'running', ended_at: undefined })],
        effect_ownership: hold('r', { tenant_slug: undefined }),
      }),
    ]);
    await write(
      path.join(root, dotStatePath(c, DOT_WORK_RESULTS_FILE)),
      JSON.stringify({
        dot_id: 'ops',
        work_item_id: 'held',
        action_ref: 'action-held',
        attempt_id: 'r',
        status: 'blocked',
        mode: 'pipeline',
        summary: 'Synthetic timeout; release failed',
        started_at: EARLIER,
        completed_at: EARLIER,
      }) + '\n'
    );
    const section = dotExecutorStatusSection().collect(c, { rootDir: root, now: () => NOW });
    expect(section).toMatchObject({
      history_status: 'historical',
      execution: { items: [{ reason_code: 'running_owner_snapshot' }] },
    });
    expect((section.execution as Inspection).items[0].reason).toContain(
      'does not prove live execution'
    );
    expect((section.execution as Inspection).items[0].next).toContain('before any retry');
  });
});
