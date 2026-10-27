import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

/**
 * CD-09 lifecycle: `customer-decision task-decisions` — the confirmed customer
 * decisions of a task's own requires_customer questions for direct CLI work,
 * on a fresh fixture root with the real case store, guard, audit chain and
 * work-coordination store. Only the approval gate is stubbed (approved by a
 * human); approvals are not what this file tests.
 */
const mocks = vi.hoisted(() => ({ gate: vi.fn(), load: vi.fn() }));
vi.mock('@agent/core/governance/approval-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-gate')>()),
  enforceApprovalGate: (...args: unknown[]) => mocks.gate(...args),
}));
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  loadApprovalRequest: (...args: unknown[]) => mocks.load(...args),
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: vi.fn(() => false),
}));

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-task-decisions-' + process.pid);
const TENANT = 'cd-task-decisions';
const OTHER = 'cd-task-decisions-other';
const INACTIVE = 'cd-task-decisions-off';
const CASE = 'case-cd';
const NOW = '2026-10-24T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const MISSION = 'MSN-CD09-TASKDEC';
const TASK = 'release';
const CONSUMER = `mission-${MISSION}.${TASK}`;
/** A value no audit record or id-only output may contain. */
const SENTINEL = 'release-window-sentinel-7731';
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const savedRoot = process.env.KYBERION_ROOT;

let facade: typeof import('./customer_decision.js');
let io: typeof import('@agent/core/secure-io');

function writeFixtureJson(relative: string, value: unknown): void {
  io.safeWriteFile(path.join(ROOT, relative), `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-task-decisions"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    copy('knowledge/product/orchestration');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  facade = await import('./customer_decision.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const [tenant, status] of [
    [TENANT, 'active'],
    [OTHER, 'active'],
    [INACTIVE, 'suspended'],
  ]) {
    writeFixtureJson(`knowledge/personal/tenants/${tenant}.json`, {
      tenant_slug: tenant,
      display_name: tenant,
      status,
      assigned_role: 'owner',
    });
  }
  for (const key of keys) delete process.env[key];
  mocks.gate.mockReturnValue({ allowed: true, status: 'approved', requestId: 'apr-td' });
  mocks.load.mockReturnValue({ decidedBy: 'user:owner', decidedByType: 'human', decidedAt: NOW });
}, 120_000);

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type Out = Record<string, unknown>;

describe('customer-decision task-decisions (CD-09 direct CLI work)', () => {
  const run = (argv: string[], missionCase?: () => { tenantSlug: string; caseId: string } | null) =>
    facade.runCustomerDecision(argv, {
      now: () => NOW,
      ...(missionCase ? { missionCase } : {}),
    }) as Promise<Out>;
  const runStdin = (argv: string[], stdin: string) =>
    facade.runCustomerDecision(argv, { now: () => NOW, stdin }) as Promise<Out>;
  const base = () => ['--tenant', TENANT, '--case', CASE];
  const decisionCase = () => ({
    tenantSlug: TENANT,
    caseId: CASE,
    source: 'project' as const,
    location: { tenantSlug: TENANT, caseId: CASE },
  });
  const ownCase = () => ({ tenantSlug: TENANT, caseId: CASE });
  const read = (tenant = TENANT, missionCase: () => ReturnType<typeof ownCase> | null = ownCase) =>
    run(['task-decisions', '--tenant', tenant, '--mission', MISSION, '--task', TASK], missionCase);
  /** This tenant's audit entries of one operation (the chain under test runs lives in its vitest sandbox). */
  async function auditEntries(operation: string): Promise<Out[]> {
    const { auditChain } = await import('@agent/core/governance/audit-chain');
    return (
      initialContext('ecosystem_architect', () => auditChain.loadAll()) as unknown as Out[]
    ).filter(
      (entry) =>
        entry.action === 'customer_decision' &&
        entry.operation === operation &&
        entry.tenantSlug === TENANT
    );
  }

  it('refuses an unbound process, another bound tenant and an inactive tenant', async () => {
    // The audit sandbox outlives a run: count what this run adds.
    const before = (await auditEntries('task_decisions_read')).length;
    await expect(read()).rejects.toThrow(/CUSTOMER_DECISION_TENANT_UNBOUND/u);
    process.env.KYBERION_TENANT = OTHER;
    await expect(read()).rejects.toThrow(/CUSTOMER_DECISION_TENANT_MISMATCH/u);
    process.env.KYBERION_TENANT = INACTIVE;
    await expect(read(INACTIVE)).rejects.toThrow(/CUSTOMER_DECISION_TENANT_INACTIVE/u);
    process.env.KYBERION_TENANT = TENANT;
    await expect(
      run([
        'task-decisions',
        '--tenant',
        TENANT,
        '--mission',
        MISSION,
        '--task',
        TASK,
        '--dir',
        ROOT,
      ])
    ).rejects.toThrow(/--dir is not accepted/u);
    expect(await auditEntries('task_decisions_read')).toHaveLength(before);
  });

  it('prints what the resumed pin delivers, to stdout only; audits ids only; another tenant gets nothing', async () => {
    process.env.KYBERION_TENANT = TENANT;
    const auditedBefore = (await auditEntries('task_decisions_read')).length;
    const lockApi = await import('@agent/core/mission/mission-decision-lock');
    await run(['draft', ...base(), '--customer', 'acme', '--title', 'Inception']);
    const held = lockApi.recordTaskDecisionProposals(
      {
        missionId: MISSION,
        taskId: TASK,
        requests: [
          {
            question: 'Which release window?',
            item: 'RELEASE',
            key: 'release.window',
            options: [
              { value: SENTINEL, label: 'Early November' },
              { value: 'late-window', label: 'Late November' },
            ],
            requires_customer: true,
          },
        ],
      },
      { decisionCase: decisionCase(), now: NOW }
    );
    const [proposalId] = held.hold_proposal_ids;
    // Nothing confirmed yet: no decisions.
    expect(await read()).toMatchObject({
      case_found: true,
      case_id: CASE,
      consumer: CONSUMER,
      lock_found: true,
      decisions: [],
      unconfirmed: [],
    });

    const collected = await run(['draft', ...base(), '--from-tasks', '--customer', 'acme']);
    const agendaId = String(collected.agenda_id);
    await run(['submit', ...base(), '--agenda', agendaId, '--by', 'user:owner']);
    await run(['actor-add', ...base(), '--customer', 'acme', '--actor', ACTOR, '--name', 'CTO']);
    const sent = await run([
      'send',
      ...base(),
      '--agenda',
      agendaId,
      '--name',
      'Hanako',
      '--role',
      'decider',
      '--actor',
      ACTOR,
    ]);
    const token = String(sent.link).split('#t=')[1];
    const view = await runStdin(['view', '--tenant', TENANT], JSON.stringify({ token }));
    await runStdin(
      ['respond', '--tenant', TENANT],
      JSON.stringify({
        token,
        content_hash: view.content_hash,
        answers: [{ entry_id: proposalId, choice: 'option', value: SENTINEL }],
      })
    );
    // Decided but not confirmed by the operator: still nothing to deliver.
    expect((await read()).decisions).toEqual([]);
    await run([
      'confirm',
      ...base(),
      '--agenda',
      agendaId,
      '--entry',
      proposalId,
      '--by',
      'user:owner',
    ]);

    const before = await read();
    expect(before.decisions).toEqual([
      expect.objectContaining({
        proposal_id: proposalId,
        agenda_id: agendaId,
        entry_id: proposalId,
        question: 'Which release window?',
        value: SENTINEL,
        option_label: 'Early November',
      }),
    ]);
    // The same as the resumed task's pin delivers.
    const pinned = lockApi.pinTaskDecisions(
      { missionId: MISSION, taskId: TASK, mode: 'start' },
      { decisionCase: decisionCase(), now: NOW }
    );
    const values = pinned?.decision_values;
    expect(values?.decisionIds).toEqual(
      (before.decisions as Out[]).map((decision) => decision.decision_id)
    );
    expect(values?.promptLines().join('\n')).toContain(JSON.stringify(SENTINEL));
    expect((await read()).decisions).toEqual(before.decisions);

    // Ids and counts only on the audit chain.
    const audited = (await auditEntries('task_decisions_read')).slice(auditedBefore);
    expect(audited).toHaveLength(4);
    expect(audited.at(-1)).toMatchObject({
      tenantSlug: TENANT,
      metadata: expect.objectContaining({
        mission_id: MISSION,
        task_id: TASK,
        consumer: CONSUMER,
        case_id: CASE,
        count: 1,
        decision_ids: [(before.decisions as Out[])[0].decision_id],
      }),
    });
    expect(JSON.stringify(audited)).not.toMatch(
      new RegExp(`${SENTINEL}|release window|Early November|release\\.window`, 'u')
    );

    // A mission whose case belongs to another tenant, or no case at all: nothing.
    for (const missionCase of [() => ({ tenantSlug: OTHER, caseId: CASE }), () => null]) {
      expect(await read(TENANT, missionCase)).toEqual({
        tenant_slug: TENANT,
        mission_id: MISSION,
        task_id: TASK,
        consumer: CONSUMER,
        case_found: false,
        decisions: [],
        unconfirmed: [],
      });
    }
    // Bound to the other tenant, the same mission and task resolve to nothing of this tenant.
    process.env.KYBERION_TENANT = OTHER;
    const other = await run([
      'task-decisions',
      '--tenant',
      OTHER,
      '--mission',
      MISSION,
      '--task',
      TASK,
    ]);
    expect(other).toMatchObject({ case_found: false, decisions: [] });
  }, 180_000);
});
