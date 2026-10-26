import { dotWorkItemInput } from './dot-work-item.js';
import { admissionForDotRecord } from './dot-admission-identity.js';
import type { DotActionRecord } from './dot-action-ledger.js';
import { DOT_DISPOSITION_OVERRIDES } from './dot-extension-registry.js';
import * as operationsHalt from '../governance/operations-halt.js';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '../path-resolver.js';
import {
  spawnManagedProcess,
  stopManagedProcess,
  type ManagedProcessHandle,
} from '../managed-process.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { getFoundationIo } from '../foundation/io.js';
import { safeCopyFileSync, safeMkdir, safeWriteFile, safeRmSync } from '../secure-io.js';
import {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import { dotAdmissionItemId, genericDotActionIdentity } from './dot-admission-identity.js';
import {
  appendActionRecord,
  currentDotActions,
  dotProposalHash,
  readDotActionLedger,
} from './dot-action-ledger.js';
import {
  dispatchDotProposals,
  reconcileDotAdmissions,
  type DotDispatchDeps,
} from './dot-dispatch.js';
import type { DotCharter } from './dot-charter.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
import type { DotProposal } from './dot-proposals.js';

const CHARTER: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'admission-recovery',
  version: '1.0.0',
  title: 'Admission recovery',
  purpose: 'Offline durable admission test',
  status: 'active',
  scope: { tier: 'public' },
  goal: { statement: 'One item for each intended operation' },
  attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }] },
  authority: {
    authority_role: 'organization_operator',
    allowed_work_shapes: ['direct_reply'],
    max_concurrent_delegations: 20,
  },
  notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { heartbeat_id: 'admission-recovery' },
};
const PROPOSAL: DotProposal = {
  action_id: 'dot_delegate_work',
  title: 'Durable operation',
  objective: 'Create exactly one durable item',
  work_shape: 'direct_reply',
};
let rootDir: string;
const children: ManagedProcessHandle[] = [];
function deps(overrides: Partial<DotDispatchDeps> = {}): DotDispatchDeps {
  return {
    rootDir,
    operationKey: 'wake-one',
    now: () => new Date('2026-10-11T09:00:00Z'),
    gate: (input) => ({
      actionId: input.actionId,
      allowed: true,
      decision: input.requestedDecision ?? 'auto',
      score: 0,
      maxScore: 6,
      policyVersion: 'offline-test',
      executionMode: 'apply',
      reason: 'injected offline gate',
      axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
    }),
    route: () => ({
      level: 'none',
      timing: 'digest',
      proceed: true,
      parked: false,
      shadow: false,
      notified: false,
    }),
    assertTenant: () => {},
    listCharters: () => [CHARTER],
    audit: () => {},
    notify: () => {
      throw new Error('unexpected notification');
    },
    appendInbox: () => {
      throw new Error('unexpected handoff');
    },
    ...overrides,
  };
}
function items() {
  return listWorkItems({}, { rootDir });
}
function interruptFinalLedgerAppend(): void {
  const io = getFoundationIo();
  const append = io.appendFile.bind(io);
  vi.spyOn(io, 'appendFile').mockImplementation((file, content) => {
    if (file.endsWith('/dot-action-ledger.jsonl') && content.includes('"status":"dispatched"')) {
      throw new Error('simulated crash after durable WorkItem snapshot');
    }
    append(file, content);
  });
}
function missingAdmission() {
  const result = dispatchDotProposals(
    CHARTER,
    [PROPOSAL],
    deps({
      createWorkItem: () => {
        throw new Error('simulated interruption before item creation');
      },
    })
  );
  expect(result.records[0].status).toBe('admitted');
  expect(items()).toHaveLength(0);
  return result.records[0];
}
beforeEach(() => {
  rootDir = 'active/shared/tmp/dot-admission-recovery-' + randomUUID();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) stopManagedProcess(child.resourceId, child.child);
  withExecutionContext('ecosystem_architect', () =>
    safeRmSync(rootDir, { recursive: true, force: true })
  );
});

describe('durable generic dot admission', () => {
  it('replays from disk after a real snapshot commits but the dispatched ledger append fails', async () => {
    interruptFinalLedgerAppend();
    const first = dispatchDotProposals(CHARTER, [PROPOSAL], deps());
    expect(first.records[0].status).toBe('admitted');
    expect(items()).toHaveLength(1);
    const original = items()[0];
    expect(original.item_id).toBe(dotAdmissionItemId(first.records[0].action_ref));
    expect(readDotActionLedger({ rootDir }).map((row) => row.status)).toEqual(['admitted']);
    vi.restoreAllMocks();
    // Discard dispatch module state: recovery must rely on persisted identity.
    vi.resetModules();
    const restarted = await import('./dot-dispatch.js');
    const replay = restarted.dispatchDotProposals(CHARTER, [PROPOSAL], deps());
    expect(replay.records[0]).toMatchObject({
      status: 'dispatched',
      work_item_id: original.item_id,
    });
    expect(items()).toEqual([original]);
    expect(restarted.dispatchDotProposals(CHARTER, [PROPOSAL], deps()).duplicates).toEqual([
      first.records[0].action_ref,
    ]);
    expect(items()).toEqual([original]);
  });

  it('reconciles an admitted operation whose item was never created', () => {
    const admitted = missingAdmission();
    expect(reconcileDotAdmissions(CHARTER, deps())).toMatchObject([
      {
        action_ref: admitted.action_ref,
        status: 'dispatched',
        work_item_id: admitted.work_item_id,
      },
    ]);
    expect(items()).toHaveLength(1);
    expect(items()[0].version).toBe(1);
    expect(reconcileDotAdmissions(CHARTER, deps())).toEqual([]);
    expect(items()).toHaveLength(1);
  });

  it('rejects changed semantics under the same operation key without changing the original item', () => {
    const first = dispatchDotProposals(CHARTER, [PROPOSAL], deps()).records[0];
    const original = items()[0];
    const replay = dispatchDotProposals(
      CHARTER,
      [{ ...PROPOSAL, objective: 'Different operation' }],
      deps()
    );
    expect(replay.records[0].reason).toMatch(/identity conflict/);
    expect(replay.records[0].action_ref).toBe(first.action_ref);
    expect(items()).toEqual([original]);
    expect(currentDotActions(CHARTER.dot_id, { rootDir })[0]).toEqual(first);
  });

  it('allows a distinct later operation only after verified successful completion', () => {
    const first = dispatchDotProposals(CHARTER, [PROPOSAL], deps()).records[0];
    const original = getWorkItem(first.work_item_id!, { rootDir })!;
    expect(original.metadata?.action_ref).toBe(first.action_ref);
    expect(original.context).toMatchObject({});
    expect(original.context?.tenant_slug).toBe(CHARTER.scope.tenant_slug);
    expect(original.context?.organization_id).toBe(CHARTER.scope.organization_id);
    expect(original.context?.project_id).toBe('default');
    const later = dispatchDotProposals(
      CHARTER,
      [PROPOSAL],
      deps({
        operationKey: 'wake-two',
        findWorkItemByActionRef: (ref) =>
          ref === first.action_ref
            ? { ...original, status: 'done', current_attempt_id: 'success' }
            : undefined,
        readWorkResults: () => [
          {
            dot_id: CHARTER.dot_id,
            action_ref: first.action_ref,
            work_item_id: first.work_item_id!,
            attempt_id: 'success',
            status: 'done',
            completed_at: '2026-10-11T09:00:01Z',
          } as DotWorkResultRow,
        ],
      })
    ).records[0];
    expect(later.status).toBe('dispatched');
    expect(later.action_ref).not.toBe(first.action_ref);
    expect(items()).toHaveLength(2);
  });

  it.each(['ready', 'in_progress', 'archived'] as const)(
    'does not retry unresolved %s work on a new wake, even after the semantic window',
    (status) => {
      const first = dispatchDotProposals(CHARTER, [PROPOSAL], deps()).records[0];
      updateWorkItem({
        itemId: first.work_item_id!,
        rootDir,
        status,
        metadata: { dot_executor: { uncertain_effect: true } },
      });
      const replay = dispatchDotProposals(
        CHARTER,
        [PROPOSAL],
        deps({ operationKey: 'wake-two', now: () => new Date('2026-10-13T09:00:00Z') })
      );
      expect(replay.duplicates).toEqual([first.action_ref]);
      expect(items()).toHaveLength(1);
    }
  );

  it('includes tenant scope in operation identity even when dot and operation names match', () => {
    const a: DotCharter = {
      ...CHARTER,
      scope: { tier: 'confidential', tenant_slug: 'fixture-alpha' },
    };
    const b: DotCharter = {
      ...CHARTER,
      scope: { tier: 'confidential', tenant_slug: 'fixture-beta' },
    };
    const first = dispatchDotProposals(a, [PROPOSAL], deps()).records[0];
    const second = dispatchDotProposals(b, [PROPOSAL], deps()).records[0];
    expect(first.status).toBe('dispatched');
    expect(second.status).toBe('dispatched');
    expect(first.action_ref).not.toBe(second.action_ref);
    expect(
      items()
        .map((item) => item.context?.tenant_slug)
        .sort()
    ).toEqual(['fixture-alpha', 'fixture-beta']);
  });

  it('repairs the ledger without reopening an archived item or rewriting its snapshot', () => {
    interruptFinalLedgerAppend();
    const first = dispatchDotProposals(CHARTER, [PROPOSAL], deps()).records[0];
    vi.restoreAllMocks();
    const archived = updateWorkItem({
      itemId: first.work_item_id!,
      rootDir,
      status: 'archived',
      metadata: { archive_reason: 'finished elsewhere' },
    });
    const replay = dispatchDotProposals(CHARTER, [PROPOSAL], deps());
    expect(replay.records[0].status).toBe('dispatched');
    expect(getWorkItem(archived.item_id, { rootDir })).toEqual(archived);
    expect(items()).toHaveLength(1);
  });

  it.each(['ready', 'archived'] as const)(
    'adopts a verified legacy random-ID %s item without reopening or duplicating it',
    (status) => {
      const legacy: DotActionRecord = {
        ...PROPOSAL,
        action_ref: 'legacy-random-action',
        dot_id: CHARTER.dot_id,
        actor_id: 'dot:' + CHARTER.dot_id,
        status: 'parked',
        decision: 'auto',
        proposal_hash: dotProposalHash(CHARTER.dot_id, PROPOSAL),
        at: '2026-10-11T09:00:00Z',
      };
      const {
        itemId: _id,
        sourceRef: _source,
        ...oldInput
      } = dotWorkItemInput(CHARTER, legacy, rootDir);
      const created = createWorkItem(oldInput);
      const original =
        status === 'archived'
          ? updateWorkItem({ itemId: created.item_id, rootDir, status })
          : created;
      appendActionRecord(
        {
          ...legacy,
          scope: CHARTER.scope,
          status: 'admitted',
          admission: admissionForDotRecord(CHARTER, legacy),
          work_item_id: dotAdmissionItemId(legacy.action_ref),
        },
        deps()
      );
      const result = reconcileDotAdmissions(CHARTER, deps());
      expect(result[0].reason).toBeUndefined();
      expect(result[0]).toMatchObject({ status: 'dispatched', work_item_id: original.item_id });
      expect(items()).toHaveLength(1);
      expect(getWorkItem(original.item_id, { rootDir })).toEqual(original);
    }
  );

  it('holds an unfinished admission after a record-only autonomy override', () => {
    missingAdmission();
    DOT_DISPOSITION_OVERRIDES.push({
      id: 'test-shadow',
      dispose: () => ({ disposition: 'shadow', reason: 'demoted' }),
    });
    try {
      expect(reconcileDotAdmissions(CHARTER, deps())[0].status).toBe('admitted');
      expect(items()).toHaveLength(0);
    } finally {
      DOT_DISPOSITION_OVERRIDES.pop();
    }
  });
  it('does not create missing work while operations are halted', () => {
    missingAdmission();
    vi.spyOn(operationsHalt, 'isOperationsHalted').mockReturnValue(true);
    expect(reconcileDotAdmissions(CHARTER, deps())[0].status).toBe('admitted');
    expect(items()).toHaveLength(0);
  });
  it('recovers notified fyi work but retains admission when it now requires a veto', () => {
    const gate = (input: Parameters<NonNullable<DotDispatchDeps['gate']>>[0]) => ({
      ...deps().gate!(input),
      decision: 'notify' as const,
    });
    const admitted = dispatchDotProposals(
      CHARTER,
      [PROPOSAL],
      deps({
        gate,
        createWorkItem: () => {
          throw new Error('interrupted');
        },
      })
    ).records[0];
    expect(admitted.status).toBe('admitted');
    expect(
      reconcileDotAdmissions(
        CHARTER,
        deps({ gate: (input) => ({ ...gate(input), vetoWindowMinutes: 30 }) })
      )[0].status
    ).toBe('admitted');
    expect(items()).toHaveLength(0);
    expect(reconcileDotAdmissions(CHARTER, deps({ gate }))[0].status).toBe('dispatched');
    expect(items()).toHaveLength(1);
  });
  it.each(['inactive', 'role', 'shape', 'gate'] as const)(
    'does not create missing work after current authorization changes: %s',
    (kind) => {
      missingAdmission();
      const charter = structuredClone(CHARTER);
      let options = deps();
      if (kind === 'inactive') charter.status = 'paused';
      if (kind === 'role') charter.authority.authority_role = 'different-role';
      if (kind === 'shape') charter.authority.allowed_work_shapes = [];
      if (kind === 'gate') {
        const gate = options.gate!;
        options = { ...options, gate: (input) => ({ ...gate(input), allowed: false }) };
      }
      expect(reconcileDotAdmissions(charter, options)[0].status).toBe('admitted');
      expect(items()).toHaveLength(0);
    }
  );

  it('preserves generic ordinals when an ineligible front-desk proposal is interleaved', () => {
    const frontdesk: DotProposal = {
      ...PROPOSAL,
      front_desk_execution: {
        mapping_id: 'nonexistent-offline-fixture',
        config_digest: 'a'.repeat(64),
        conversation_key: 'b'.repeat(64),
        request_id: '12345678-1234-1234-1234-123456789abc',
        revision: 1,
        request_digest: 'c'.repeat(64),
        work_item_id: 'WI-FD-' + 'd'.repeat(48),
      },
    };
    const proposals = [PROPOSAL, frontdesk, { ...PROPOSAL, title: 'Third proposal' }];
    const first = dispatchDotProposals(CHARTER, proposals, deps());
    expect(first.records.map((row) => row.admission?.ordinal)).toEqual([0, 2]);
    expect(first.records[1].action_ref).toBe(
      genericDotActionIdentity(CHARTER, proposals[2], 2, 'wake-one').action_ref
    );
    expect(dispatchDotProposals(CHARTER, proposals, deps()).duplicates).toEqual(
      first.records.map((row) => row.action_ref)
    );
    expect(items()).toHaveLength(2);
  });

  it('retains proposal ordinal identities across a multi-proposal replay', () => {
    const proposals = [PROPOSAL, { ...PROPOSAL, title: 'Second operation' }];
    const first = dispatchDotProposals(CHARTER, proposals, deps());
    expect(first.records.map((row) => row.action_ref)).toEqual(
      proposals.map(
        (proposal, ordinal) =>
          genericDotActionIdentity(CHARTER, proposal, ordinal, 'wake-one').action_ref
      )
    );
    const replay = dispatchDotProposals(CHARTER, proposals, deps());
    expect(replay.duplicates).toEqual(first.records.map((row) => row.action_ref));
    expect(items()).toHaveLength(2);
  });
});

interface ChildResult {
  ok: boolean;
  value?: { records: Array<{ action_ref: string; status: string }>; duplicates: string[] };
  error?: string;
}

function seedChildRoot(): string {
  const fixtureRoot = path.resolve(rootDir);
  withExecutionContext('ecosystem_architect', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'dot-admission-race-fixture', private: true })
    );
    for (const relative of [
      'knowledge/product/schemas/governed-work-item.schema.json',
      'knowledge/product/schemas/workitem-label-taxonomy.schema.json',
      'knowledge/product/governance/security-policy.json',
      'knowledge/product/governance/role-assumption-policy.json',
    ]) {
      safeMkdir(path.dirname(path.join(fixtureRoot, relative)), { recursive: true });
      safeCopyFileSync(pathResolver.rootResolve(relative), path.join(fixtureRoot, relative));
    }
  });
  return fixtureRoot;
}

async function raceAdmissions(fixtureRoot: string): Promise<ChildResult[]> {
  const pending = [0, 1].map(() => {
    // Import current source explicitly: a stale dist cannot make this regression pass.
    const moduleUrl = pathToFileURL(pathResolver.rootResolve('libs/core/dot/dot-dispatch.ts')).href;
    const code = [
      'import { dispatchDotProposals } from ' + JSON.stringify(moduleUrl) + ';',
      'const charter = ' + JSON.stringify(CHARTER) + ';',
      'const proposal = ' + JSON.stringify(PROPOSAL) + ';',
      'const options = { rootDir: ' +
        JSON.stringify(fixtureRoot) +
        ', operationKey: "race-operation",',
      'gate: (input) => ({ actionId: input.actionId, allowed: true, decision: "auto", score: 0, maxScore: 6, policyVersion: "test", executionMode: "apply", reason: "offline", axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 }, shadow: false, escalations: [], highRiskPathMatches: [] }),',
      'route: () => ({ level: "none", timing: "digest", proceed: true, parked: false, shadow: false, notified: false }),',
      'listCharters: () => [charter], assertTenant: () => {}, audit: () => {}, notify: () => { throw new Error("unexpected notification"); } };',
      'process.stdin.once("data", () => {',
      'try { const value = dispatchDotProposals(charter, [proposal], options); process.stdout.write(JSON.stringify({ ok: true, value }) + "\\n"); }',
      'catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + "\\n"); }',
      'finally { process.exit(0); }',
      '}); process.stdout.write("READY\\n");',
    ].join('\n');
    const handle = spawnManagedProcess({
      resourceId: 'dot-admission-race-' + randomUUID(),
      kind: 'service',
      ownerId: 'dot-admission-recovery-tests',
      ownerType: 'test',
      command: process.execPath,
      args: ['--import', 'tsx', '--input-type=module', '-e', code],
      spawnOptions: {
        cwd: pathResolver.rootDir(),
        env: { ...process.env, KYBERION_ROOT: fixtureRoot, KYBERION_REASONING_BACKEND: 'stub' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });
    children.push(handle);
    let stdout = '';
    let stderr = '';
    let onReady!: () => void;
    let failReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      failReady = reject;
    });
    handle.child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) onReady();
    });
    handle.child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const result = new Promise<ChildResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('child timed out: ' + stderr + stdout);
        failReady(error);
        reject(error);
        stopManagedProcess(handle.resourceId, handle.child);
      }, 30_000);
      handle.child.once('error', (error) => {
        clearTimeout(timer);
        failReady(error);
        reject(error);
      });
      handle.child.once('close', (code) => {
        clearTimeout(timer);
        const line = stdout
          .trim()
          .split('\n')
          .reverse()
          .find((line) => line.startsWith('{"ok":'));
        if (code !== 0 || !line) {
          const error = new Error('child failed: ' + stderr + stdout);
          failReady(error);
          reject(error);
          return;
        }
        resolve(JSON.parse(line));
      });
    });
    void result.catch(() => {});
    return { handle, ready, result };
  });
  await Promise.all(pending.map((entry) => entry.ready));
  for (const entry of pending) entry.handle.child.stdin?.write('GO\n');
  return Promise.all(pending.map((entry) => entry.result));
}

it('serializes two fresh processes replaying the same operation into exactly one creation', async () => {
  const results = await raceAdmissions(seedChildRoot());
  expect(
    results.every((result) => result.ok),
    JSON.stringify(results)
  ).toBe(true);
  const records = results.flatMap((result) => result.value!.records);
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe('dispatched');
  expect(results.flatMap((result) => result.value!.duplicates)).toEqual([records[0].action_ref]);
  expect(items()).toHaveLength(1);
  expect(items()[0].version).toBe(1);
  expect(readDotActionLedger({ rootDir }).map((row) => row.status)).toEqual([
    'admitted',
    'dispatched',
  ]);
}, 45_000);
