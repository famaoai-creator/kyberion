import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
} from './fixtures/first-job-approval-fixture.js';

/**
 * CD-09: the release of a task held on a `requires_customer` proposal, driven
 * through the governed entry an operator runs (`customer-decision confirm`,
 * the BUILT facade `dist/scripts/customer_decision.js` in a child process
 * with no role, persona, SYSTEM_ROLE or mission in its env, bound to the
 * tenant) on a fresh fixture root: the real case store under
 * knowledge/confidential/<tenant>/decisions/, the real approval store and
 * gate (the child's `customer_decision:operator_confirm` request is decided
 * by the registered owner member as a human), the real audit chain and the
 * real work-coordination store. Only the agenda approval of `submit` in this
 * (parent) process is stubbed; it is not what this file tests.
 */
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@agent/core/governance/approval-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/governance/approval-gate')>();
  return {
    ...actual,
    enforceApprovalGate: (params: Parameters<typeof actual.enforceApprovalGate>[0]) =>
      params.operationId === 'customer_decision:agenda_approve'
        ? { allowed: true, status: 'approved', requestId: 'apr-agenda' }
        : actual.enforceApprovalGate(params),
  };
});
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  // `submit` reads the (stubbed) agenda approval's decider.
  loadApprovalRequest: (...args: unknown[]) => mocks.load(...args),
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: vi.fn(() => false),
}));

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-confirm-release-' + process.pid);
const TENANT = 'cd-confirm-release';
const OTHER = 'cd-confirm-release-other';
const CASE = 'case-cd';
const NOW = '2026-10-24T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const MISSION = 'MSN-CD09-CONFIRM';
const TASK = 'release';
const CONSUMER = `mission-${MISSION}.${TASK}`;
/** The registered organization member (owner of TENANT, no membership in OTHER). */
const OPERATOR = 'user:owner';
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

/**
 * The child runs the BUILT facade. When a source it runs has no built file,
 * or a newer mtime than its built file, the test is skipped with that reason
 * (run `pnpm -s build`) instead of silently testing stale code. Like `tsc -b`,
 * a source counts as built when it is older than its project's build info
 * (`dist/.tsbuildinfo`, `libs/core/dist/.tsbuildinfo`): tsc does not re-emit
 * a file whose content did not change.
 */
const SOURCE_DIRS = ['scripts/customer-decision', 'libs/core/customer-decision'];
const SOURCE_FILES = [
  'scripts/customer_decision.ts',
  'libs/core/mission/mission-decision-lock.ts',
  'libs/core/governance/approval-gate.ts',
  'libs/core/governance/approval-store.ts',
];
function builtFileOf(source: string): string {
  const js = source.replace(/\.ts$/u, '.js');
  return js.startsWith('libs/core/')
    ? `libs/core/dist/${js.slice('libs/core/'.length)}`
    : `dist/${js}`;
}
function staleDistReason(): string | null {
  const mtime = (relative: string) => {
    const file = path.join(SOURCE_ROOT, relative);
    return initialIO.safeExistsSync(file) ? initialIO.safeStat(file).mtimeMs : null;
  };
  const sources = [
    ...SOURCE_FILES,
    ...SOURCE_DIRS.flatMap((dir) =>
      initialIO
        .safeReaddir(path.join(SOURCE_ROOT, dir))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => `${dir}/${name}`)
    ),
  ];
  for (const source of sources) {
    if (mtime(builtFileOf(source)) === null) return `${builtFileOf(source)} is not built`;
    const info = source.startsWith('libs/core/')
      ? 'libs/core/dist/.tsbuildinfo'
      : 'dist/.tsbuildinfo';
    if ((mtime(source) ?? 0) > (mtime(info) ?? 0)) return `${info} is older than ${source}`;
  }
  return null;
}
const STALE_DIST = staleDistReason();

let facade: typeof import('./customer_decision.js');
let io: typeof import('@agent/core/secure-io');
/** Agent-session markers of the runner (e.g. a provider CLI), blanked: the owner decides as a human. */
let agentMarkers: Record<string, string | undefined> = {};

function writeFixtureJson(relative: string, value: unknown): void {
  io.safeWriteFile(path.join(ROOT, relative), `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    seedFirstJobTestRoot(SOURCE_ROOT, ROOT);
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  facade = await import('./customer_decision.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const tenant of [TENANT, OTHER]) {
    writeFixtureJson(`knowledge/personal/tenants/${tenant}.json`, {
      tenant_slug: tenant,
      display_name: tenant,
      status: 'active',
      assigned_role: 'owner',
    });
  }
  writeFixtureJson('knowledge/personal/members/owner.json', syntheticFirstJobOwner(TENANT));
  for (const key of keys) delete process.env[key];
  const { cliAgentSessionEnv } = await import('@agent/core/governance/cli-operator-principal');
  agentMarkers = Object.fromEntries(cliAgentSessionEnv().map((key) => [key, process.env[key]]));
  for (const key of Object.keys(agentMarkers)) delete process.env[key];
  mocks.load.mockReturnValue({ decidedBy: OPERATOR, decidedAt: NOW });
}, 120_000);

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const [key, value] of [...Object.entries(saved), ...Object.entries(agentMarkers)]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Out = Record<string, unknown>;

interface ChildRun {
  status: number | null;
  out: Out | null;
  stderr: string;
}

describe('customer-decision confirm releases a held task (CD-09, governed entry, real identity)', () => {
  const run = (argv: string[], stdin?: string) =>
    facade.runCustomerDecision(argv, {
      now: () => NOW,
      ...(stdin !== undefined ? { stdin } : {}),
    }) as Promise<Out>;
  const base = () => ['--tenant', TENANT, '--case', CASE];
  const decisionCase = () => ({
    tenantSlug: TENANT,
    caseId: CASE,
    source: 'project' as const,
    location: { tenantSlug: TENANT, caseId: CASE },
  });
  const customer = async (verb: 'view' | 'respond', body: unknown) =>
    (await run([verb, '--tenant', TENANT], JSON.stringify(body))) as Out;

  /** `customer-decision <argv>` as the operator runs it: the built facade, bound to `boundTenant`. */
  async function confirmChild(argv: string[], boundTenant: string): Promise<ChildRun> {
    const result = await io.safeExecResultAsync(
      process.execPath,
      [path.join(SOURCE_ROOT, 'dist/scripts/customer_decision.js'), 'confirm', ...argv, '--json'],
      {
        cwd: ROOT,
        env: {
          MISSION_ROLE: '',
          MISSION_ID: '',
          KYBERION_PERSONA: '',
          KYBERION_SUDO: '',
          SYSTEM_ROLE: '',
          KYBERION_TENANT: boundTenant,
          KYBERION_TENANT_SCOPE_REQUIRED: '1',
          KYBERION_ROOT: ROOT,
        },
        timeoutMs: 120_000,
        maxOutputMB: 8,
      }
    );
    let out: Out | null = null;
    try {
      out = JSON.parse(result.stdout.trim()) as Out;
    } catch {
      out = null;
    }
    return { status: result.status, out, stderr: result.stderr };
  }

  async function lock() {
    const { readConsumedDecisionLock } = await import('@agent/core/customer-decision');
    const { DECISION_LEDGER_ROLES } = await import('@agent/core/decision-ledger');
    return initialContext(
      DECISION_LEDGER_ROLES.write,
      () => readConsumedDecisionLock({ tenantSlug: TENANT, caseId: CASE }, CONSUMER),
      undefined,
      TENANT
    );
  }

  /** The audit chain the CLI child wrote under the fixture root (`active/shared/logs/audit/`). */
  function auditEntries(operation: string): Out[] {
    const dir = path.join(ROOT, 'active/shared/logs/audit');
    return initialContext('ecosystem_architect', () =>
      (io.safeExistsSync(dir) ? io.safeReaddir(dir) : [])
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) =>
          String(io.safeReadFile(path.join(dir, name), { encoding: 'utf8' }))
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Out)
        )
    ).filter((entry) => entry.action === 'customer_decision' && entry.operation === operation);
  }

  it.skipIf(STALE_DIST !== null)(
    `holds on requires_customer until the owner confirms through the CLI; another tenant or no human approval cannot release it${STALE_DIST ? ` (skipped: ${STALE_DIST} — run pnpm -s build)` : ''}`,
    async () => {
      const coordination = await import('@agent/core/workforce/work-coordination');
      const lockApi = await import('@agent/core/mission/mission-decision-lock');
      const { readLedger } = await import('@agent/core/decision-ledger');

      // The operator opened the case (its inception agenda) before the mission ran.
      expect(
        await run(['draft', ...base(), '--customer', 'acme', '--title', 'Inception'])
      ).toMatchObject({ status: 'draft' });
      // The worker held the task: a blocked WorkItem and a requires_customer proposal on its lock.
      const workItem = coordination.createWorkItem({
        title: TASK,
        description: TASK,
        status: 'blocked',
        metadata: { blocked_reason: 'awaiting_customer_decision' },
      });
      const held = lockApi.recordTaskDecisionProposals(
        {
          missionId: MISSION,
          taskId: TASK,
          requests: [
            {
              question: 'May we release the order screen on 11/1?',
              item: 'RELEASE',
              key: 'order.release',
              requires_customer: true,
            },
          ],
          workItemId: workItem.item_id,
        },
        { decisionCase: decisionCase(), now: NOW }
      );
      expect(held).toMatchObject({ case_found: true, recorded: 1 });
      expect(held.hold_proposal_ids).toEqual(held.proposal_ids);
      const [proposalId] = held.proposal_ids;
      const awaiting = () =>
        lockApi.isTaskAwaitingCustomerDecision(
          { missionId: MISSION, taskId: TASK },
          { decisionCase: decisionCase(), now: NOW }
        );
      expect(awaiting()).toBe(true);

      // The operator collects, submits and sends it; the customer approves.
      const collected = await run(['draft', ...base(), '--from-tasks', '--customer', 'acme']);
      const agendaId = String(collected.agenda_id);
      await run(['submit', ...base(), '--agenda', agendaId, '--by', OPERATOR]);
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
      const view = await customer('view', { token });
      expect(
        await customer('respond', {
          token,
          content_hash: view.content_hash,
          answers: [{ entry_id: proposalId, choice: 'approve' }],
        })
      ).toMatchObject({ ok: true });
      const decisionId = initialContext(
        'ecosystem_architect',
        () =>
          readLedger({ tenantSlug: TENANT, caseId: CASE }).find(
            (record) => record.key === 'order.release'
          )?.id
      );
      expect(decisionId).toEqual(expect.any(String));
      // Decided by the customer, but provisional until the operator confirms: still held.
      expect(awaiting()).toBe(true);

      const confirmArgs = (tenant: string) => [
        '--tenant',
        tenant,
        '--case',
        CASE,
        '--agenda',
        agendaId,
        '--entry',
        proposalId,
        '--by',
        OPERATOR,
      ];
      const stillHeld = async () => {
        expect(awaiting()).toBe(true);
        expect((await lock())?.hold?.resolved_at).toBeUndefined();
        expect(coordination.getWorkItem(workItem.item_id)?.metadata).not.toHaveProperty(
          'customer_decision_hold'
        );
        expect(auditEntries('operator_confirm')).toEqual([]);
      };

      // Wrong tenant 1: a CLI bound to another tenant cannot reach this tenant's case.
      const crossTenant = await confirmChild(confirmArgs(TENANT), OTHER);
      expect(crossTenant.status, crossTenant.stderr).toBe(2);
      expect(crossTenant.stderr).toMatch(/CUSTOMER_DECISION_TENANT_MISMATCH/u);
      await stillHeld();
      // Wrong tenant 2: the same case id under the other tenant is not this case.
      const otherCase = await confirmChild(confirmArgs(OTHER), OTHER);
      expect(otherCase.status, otherCase.stderr).toBe(2);
      expect(otherCase.stderr).toMatch(/agenda not found/u);
      await stillHeld();

      // The operator alone cannot release it: the gate opens a human-only request.
      const pending = await confirmChild(confirmArgs(TENANT), TENANT);
      expect(pending.status, pending.stderr).toBe(0);
      expect(pending.out).toMatchObject({
        entry_id: proposalId,
        decision_id: decisionId,
        request_status: 'created',
        approval_request_id: expect.any(String),
      });
      await stillHeld();
      const requestId = String(pending.out?.approval_request_id);
      const { loadApprovalRequest } = await vi.importActual<
        typeof import('@agent/core/governance/approval-store')
      >('@agent/core/governance/approval-store');
      const { decideApprovalRequest } = await import('@agent/core/governance/approval-store');
      const request = loadApprovalRequest('terminal', requestId);
      expect(request).toMatchObject({
        status: 'pending',
        correlationId: `${agendaId}:${proposalId}:${decisionId}`,
        scope: { tenant_slug: TENANT },
        accountability: {
          finalDecision: 'human_only',
          effectBinding: 'customer_decision:operator_confirm',
        },
      });
      // Re-running before anyone decides asks again, releases nothing.
      const again = await confirmChild(confirmArgs(TENANT), TENANT);
      expect(again.out).toMatchObject({
        approval_request_id: requestId,
        request_status: 'pending',
      });
      await stillHeld();

      // The registered owner member decides as a human.
      decideApprovalRequest('mission_controller', {
        channel: 'terminal',
        requestId,
        decision: 'approved',
        decidedBy: OPERATOR,
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'surface_session',
        payloadHash: request?.accountability?.payloadHash,
        effectBinding: request?.accountability?.effectBinding,
      });
      // Still the other tenant's CLI cannot use the approved request.
      const crossAfterApproval = await confirmChild(confirmArgs(TENANT), OTHER);
      expect(crossAfterApproval.status).toBe(2);
      expect(crossAfterApproval.stderr).toMatch(/CUSTOMER_DECISION_TENANT_MISMATCH/u);
      await stillHeld();

      const confirmed = await confirmChild(confirmArgs(TENANT), TENANT);
      expect(confirmed.status, confirmed.stderr).toBe(0);
      expect(confirmed.out).toMatchObject({
        entry_id: proposalId,
        decision_id: decisionId,
        confirmed_by: OPERATOR,
        approval_request_id: requestId,
        status: 'confirmed',
        already_confirmed: false,
      });

      // Released: the lock records the resolution, the hold is cleared ...
      const released = await lock();
      expect(released?.hold?.resolved_at).toEqual(expect.any(String));
      expect(released?.decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            proposal: expect.objectContaining({
              proposal_id: proposalId,
              resolved: { decision_id: decisionId, at: expect.any(String) },
            }),
          }),
        ])
      );
      expect(awaiting()).toBe(false);
      // ... the WorkItem says the task can resume (ids only, no decision content) ...
      const noted = coordination.getWorkItem(workItem.item_id);
      expect(noted).toMatchObject({
        status: 'blocked',
        metadata: {
          customer_decision_hold: {
            status: 'resolved',
            case_id: CASE,
            consumer: CONSUMER,
            decision_ids: [decisionId],
            next: `pnpm mission resume ${MISSION}`,
          },
        },
      });
      expect(JSON.stringify(noted)).not.toMatch(/order screen|order\.release|RELEASE/u);
      // ... and the resumed task re-pins without a hold (it does not ask again).
      expect(
        lockApi.recordTaskDecisionProposals(
          { missionId: MISSION, taskId: TASK, requests: [], workItemId: workItem.item_id },
          { decisionCase: decisionCase(), now: NOW }
        )
      ).toMatchObject({ case_found: true, hold_proposal_ids: [] });
      expect(awaiting()).toBe(false);

      // Audited with the operator principal, in the tenant, with the approval.
      const audited = auditEntries('operator_confirm');
      expect(audited).toEqual([
        expect.objectContaining({
          agentId: 'customer-decision',
          result: 'completed',
          tenantSlug: TENANT,
          metadata: expect.objectContaining({
            agenda_id: agendaId,
            entry_id: proposalId,
            decision_id: decisionId,
            confirmed_by: OPERATOR,
            request_id: requestId,
            already_confirmed: false,
          }),
        }),
      ]);
      // The two asks before the decision, by the operator, in this tenant only.
      expect(auditEntries('operator_confirm_request')).toEqual([
        expect.objectContaining({
          tenantSlug: TENANT,
          metadata: expect.objectContaining({ request_id: requestId, requested_by: OPERATOR }),
        }),
        expect.objectContaining({
          tenantSlug: TENANT,
          metadata: expect.objectContaining({ request_id: requestId, requested_by: OPERATOR }),
        }),
      ]);
      const status = await run(['status', ...base()]);
      expect((status.task_proposals as Out).awaiting_customer).toEqual([
        expect.objectContaining({
          consumer: CONSUMER,
          status: 'resolved',
          decision_ids: [decisionId],
        }),
      ]);
    },
    240_000
  );
});
