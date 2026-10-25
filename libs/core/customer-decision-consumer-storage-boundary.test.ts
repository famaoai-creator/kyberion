import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

/**
 * CD-09 consumer locks on a fresh root with the real tier/tenant guard: the
 * mission side assumes only the narrow customer_decision_consumer_store role,
 * inside an exact case capability, never decision_ledger. The response-time
 * sweep files its rework WorkItem with tenant registry enforcement on, under
 * the identity the customer room gives the facade (no role, no persona,
 * KYBERION_TENANT only).
 */
const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-consumer-boundary-' + process.pid);
const TENANT = 'cd-consumer-boundary';
const OTHER = 'cd-consumer-boundary-other';
const UNREGISTERED = 'cd-consumer-unregistered';
const CASE = 'case-a';
const NOW = '2026-10-24T00:00:00.000Z';
const LATER = '2026-10-25T00:00:00.000Z';
const savedRoot = process.env.KYBERION_ROOT;
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

let io: typeof import('./secure-io.js');
let authority: typeof import('./authority.js');
let core: typeof import('./core.js');
let store: typeof import('./customer-decision/store.js');
let consumption: typeof import('./customer-decision/consumption.js');
let ledger: typeof import('./decision-ledger/ledger.js');
let lockModule: typeof import('./mission/mission-decision-lock.js');
let capability: typeof import('./foundation/customer-decision-consumer-capability.js');
let resourceScope: typeof import('./foundation/resource-access-scope.js');
let coordination: typeof import('./workforce/work-coordination.js');

const profile = (tenant: string) => ({
  tenant_slug: tenant,
  display_name: tenant,
  status: 'active',
  assigned_role: 'pm',
});
const caseDir = (tenant: string) => `knowledge/confidential/${tenant}/decisions/${CASE}`;
const decisionCase = (tenant = TENANT) => ({
  tenantSlug: tenant,
  caseId: CASE,
  source: 'project' as const,
  location: { tenantSlug: tenant, caseId: CASE },
});
const task = { missionId: 'MSN-CD09-BOUNDARY', taskId: 'build' };

function agenda(tenant: string) {
  return {
    version: '1.0.0' as const,
    agenda_id: 'agd-boundary01',
    tenant_slug: tenant,
    case_id: CASE,
    customer: 'acme',
    title: 'Inception',
    phase: 'inception',
    revision: 1,
    locale: 'ja' as const,
    entries: [
      {
        entry_id: 'nfr.auth',
        item: 'NFR',
        key: 'auth.method',
        kind: 'choice' as const,
        question: 'Which sign-in method?',
        org_default: { value: 'password', source: 'hearing:aidlc_inception' },
        requires_customer: false,
      },
    ],
    status: 'draft' as const,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** Seed a case as the operator would (the facade's decision_ledger writer). */
function seedCase(tenant: string): void {
  authority.withExecutionContext(
    'decision_ledger',
    () => store.writeAgenda({ tenantSlug: tenant, caseId: CASE }, agenda(tenant)),
    'sovereign',
    tenant
  );
}

function customerDecides(tenant: string): void {
  authority.withExecutionContext(
    'decision_ledger',
    () =>
      ledger.appendDecisions(
        { tenantSlug: tenant, caseId: CASE },
        [
          {
            item: 'NFR',
            key: 'auth.method',
            level: 'customer-value',
            state: 'decided',
            value: 'sso',
            basis: [{ ref: 'agenda:agd-boundary01', version: 'h' }],
            origin: 'facade',
            decided_by: {
              kind: 'human',
              id: 'user:inv-1',
              on_behalf_of: { actor_id: 'customer:acme-cto', evidence: 'rcp-0001' },
            },
            decided_at: LATER,
          },
        ],
        { caseId: CASE }
      ),
    'sovereign',
    tenant
  );
}

const switches = [
  {
    version: '1.0.0' as const,
    switch_id: 'sw-boundary01',
    case_id: CASE,
    agenda_id: 'agd-boundary01',
    entry_id: 'nfr.auth',
    item: 'NFR',
    key: 'auth.method',
    kind: 'value_changed' as const,
    from: { layer: 'org_default' as const },
    to: { layer: 'customer' as const, decision_id: 'D-0001' },
    at: LATER,
  },
];

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-consumer-fixture"}');
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
  io = await import('./secure-io.js');
  authority = await import('./authority.js');
  core = await import('./core.js');
  store = await import('./customer-decision/store.js');
  consumption = await import('./customer-decision/consumption.js');
  ledger = await import('./decision-ledger/ledger.js');
  lockModule = await import('./mission/mission-decision-lock.js');
  capability = await import('./foundation/customer-decision-consumer-capability.js');
  resourceScope = await import('./foundation/resource-access-scope.js');
  coordination = await import('./workforce/work-coordination.js');
  expect((await import('./path-resolver.js')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const tenant of [TENANT, OTHER])
    io.safeWriteFile(
      path.join(ROOT, 'knowledge/personal/tenants', `${tenant}.json`),
      JSON.stringify(profile(tenant))
    );
  delete process.env.KYBERION_PERSONA;
}, 120_000);

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  authority.withExecutionContext('ecosystem_architect', () => {
    for (const tenant of [TENANT, OTHER, UNREGISTERED])
      io.safeRmSync(path.join(ROOT, caseDir(tenant)), { recursive: true, force: true });
  });
  coordination.setWorkCoordinationNamespace(`cd-consumer-boundary-${process.pid}`);
  coordination.clearWorkCoordinationStore();
});

afterAll(() => {
  coordination?.clearWorkCoordinationStore();
  coordination?.clearWorkCoordinationNamespace();
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

const rework = () =>
  coordination.listWorkItems({}).filter((item) => item.item_id.startsWith('WI-CDR-'));

describe('customer decision consumer locks on the real tier/tenant guard', () => {
  it('pins and reconciles as the narrow store role, with no persona in env', () => {
    seedCase(TENANT);
    expect(lockModule.pinTaskDecisions(task, { decisionCase: decisionCase(), now: NOW })).toEqual({
      consumer: 'mission-MSN-CD09-BOUNDARY.build',
      pinned_count: 1,
      pinned: true,
    });
    const file = path.join(ROOT, caseDir(TENANT), 'consumers/mission-MSN-CD09-BOUNDARY.build.json');
    expect(io.safeExistsSync(file)).toBe(true);
    // The ambient identity cannot read the confidential lock itself.
    expect(() => io.safeReadFile(file, { encoding: 'utf8' })).toThrow(
      /Higher tier required|POLICY|SECURITY|tenant/u
    );
    expect(
      lockModule.reconcileTaskDecisions(task, { decisionCase: decisionCase(), now: NOW })
    ).toMatchObject({ checked: 1, stale_count: 0, rework_work_item_ids: [] });
  });

  it('the narrow role cannot write the ledger or an agenda, nor read another tenant', () => {
    seedCase(TENANT);
    seedCase(OTHER);
    const scope = capability.customerDecisionConsumerCapability(TENANT, caseDir(TENANT), {
      read: ['decisions.jsonl', 'agendas'],
      write: 'consumers/mission-MSN-X.t.json',
    });
    const asStore = (fn: () => unknown) =>
      resourceScope.runInResourceAccessScope(scope, () =>
        authority.withExecutionContext(
          capability.CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
          fn,
          undefined,
          TENANT
        )
      );
    const inCase = (tenant: string, relative: string) => path.join(ROOT, caseDir(tenant), relative);
    expect(() =>
      asStore(() => io.safeWriteFile(inCase(TENANT, 'decisions.jsonl'), '{}\n'))
    ).toThrow(/RESOURCE_SCOPE_DENIED/u);
    expect(() =>
      asStore(() => io.safeWriteFile(inCase(TENANT, 'agendas/agd-boundary01.json'), '{}'))
    ).toThrow(/RESOURCE_SCOPE_DENIED/u);
    expect(() =>
      asStore(() => io.safeReadFile(inCase(OTHER, 'agendas/agd-boundary01.json')))
    ).toThrow(/RESOURCE_SCOPE_DENIED|tenant\.scope_violation/u);
    // The named consumer lock is writable.
    asStore(() => {
      io.safeMkdir(inCase(TENANT, 'consumers'), { recursive: true });
      io.safeWriteFile(
        inCase(TENANT, 'consumers/mission-MSN-X.t.json'),
        JSON.stringify({ consumer: 'mission-MSN-X.t', status: 'in_progress', decisions: [] })
      );
    });
    // No capability → the role is refused; a capability never names another tenant's case.
    expect(() =>
      authority.withExecutionContext(
        capability.CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
        () => undefined,
        undefined,
        TENANT
      )
    ).toThrow(/RESOURCE_SCOPE_REQUIRED/u);
    expect(() =>
      capability.customerDecisionConsumerCapability(TENANT, caseDir(OTHER), { read: [] })
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
    expect(() =>
      capability.customerDecisionConsumerCapability(TENANT, caseDir(TENANT), {
        read: [],
        write: 'agendas/agd-boundary01.json',
      })
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
  });

  it('with tenant enforcement on, the response sweep files the rework item for a registered tenant', () => {
    seedCase(TENANT);
    lockModule.pinTaskDecisions(task, { decisionCase: decisionCase(), now: NOW });
    lockModule.reconcileTaskDecisions(task, { decisionCase: decisionCase(), now: NOW });
    customerDecides(TENANT);
    // The identity the customer room gives the facade child.
    process.env.KYBERION_ENTITY_GOVERNANCE = 'enforce';
    process.env.KYBERION_TENANT = TENANT;
    const warn = vi.spyOn(core.logger, 'warn');
    const result = lockModule.sweepDecisionConsumers(
      { tenantSlug: TENANT, caseId: CASE, location: decisionCase().location, switches },
      { now: LATER }
    );
    // Only this path's warnings count; an unset CI locale warns on its own.
    expect(
      warn.mock.calls.map((call) => String(call[0])).filter((line) => !line.startsWith('[locale]'))
    ).toEqual([]);
    expect(result.rework_work_item_ids).toHaveLength(1);
    expect(rework().map((item) => item.item_id)).toEqual(result.rework_work_item_ids);
    warn.mockRestore();
  });

  it('with tenant enforcement on, an unregistered tenant warns and never throws', () => {
    process.env.KYBERION_PERSONA = 'sovereign';
    io.safeWriteFile(
      path.join(ROOT, 'knowledge/personal/tenants', `${UNREGISTERED}.json`),
      JSON.stringify(profile(UNREGISTERED))
    );
    delete process.env.KYBERION_PERSONA;
    seedCase(UNREGISTERED);
    lockModule.pinTaskDecisions(task, { decisionCase: decisionCase(UNREGISTERED), now: NOW });
    lockModule.reconcileTaskDecisions(task, { decisionCase: decisionCase(UNREGISTERED), now: NOW });
    customerDecides(UNREGISTERED);
    // The tenant is then removed from the registry.
    process.env.KYBERION_PERSONA = 'sovereign';
    io.safeRmSync(path.join(ROOT, 'knowledge/personal/tenants', `${UNREGISTERED}.json`));
    delete process.env.KYBERION_PERSONA;
    process.env.KYBERION_ENTITY_GOVERNANCE = 'enforce';
    process.env.KYBERION_TENANT = UNREGISTERED;
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => undefined);
    let result: ReturnType<typeof lockModule.sweepDecisionConsumers> | undefined;
    expect(() => {
      result = lockModule.sweepDecisionConsumers(
        {
          tenantSlug: UNREGISTERED,
          caseId: CASE,
          location: decisionCase(UNREGISTERED).location,
          switches,
        },
        { now: LATER }
      );
    }).not.toThrow();
    expect(result).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('customer decision rework filing skipped')
    );
    expect(rework()).toEqual([]);
    warn.mockRestore();
  });

  it('finds the case after one existence check of the tenant decisions root, as the narrow role', () => {
    seedCase(TENANT);
    const listTenantDeals = vi.fn(() => []);
    const state = (tenant: string) => () =>
      ({
        mission_id: task.missionId,
        tenant_slug: tenant,
        relationships: { project: { project_id: CASE, relationship_type: 'belongs_to' } },
      }) as never;
    expect(
      lockModule.resolveMissionDecisionCase(task.missionId, {
        loadMissionState: state(TENANT),
        listTenantDeals,
      })
    ).toMatchObject({ tenantSlug: TENANT, caseId: CASE, source: 'project' });
    // A tenant with no decisions root: no deal scan at all.
    expect(
      lockModule.resolveMissionDecisionCase(task.missionId, {
        loadMissionState: state('cd-consumer-none'),
        listTenantDeals,
      })
    ).toBeNull();
    expect(listTenantDeals).not.toHaveBeenCalled();
    // The root capability allows existence only.
    expect(() =>
      capability.customerDecisionConsumerCapability(
        TENANT,
        capability.customerDecisionsRootDir(TENANT),
        { read: ['decisions.jsonl'] }
      )
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
    expect(() =>
      capability.customerDecisionConsumerCapability(
        TENANT,
        capability.customerDecisionsRootDir(OTHER),
        {
          read: [],
        }
      )
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
  });

  it('a task boundary touches only its own consumer lock; the sweep may touch any', () => {
    const own = 'mission-MSN-X.t';
    const bound = (access: { read: string[]; write?: string }) =>
      capability.customerDecisionConsumerCapability(TENANT, caseDir(TENANT), {
        ...access,
        owner: own,
      });
    expect(() => bound({ read: [], write: `consumers/${own}.json` })).not.toThrow();
    expect(() => bound({ read: [`consumers/${own}.json`, 'agendas'] })).not.toThrow();
    expect(() => bound({ read: [], write: 'consumers/mission-MSN-X.other.json' })).toThrow(
      /RESOURCE_SCOPE_INVALID/u
    );
    expect(() => bound({ read: ['consumers/mission-MSN-X.other.json'] })).toThrow(
      /RESOURCE_SCOPE_INVALID/u
    );
    expect(() => bound({ read: ['consumers'] })).toThrow(/RESOURCE_SCOPE_INVALID/u);
    // The sweep kind: only inside the sweep, at construction and at use.
    const sweepAccess = {
      read: ['consumers', 'consumers/mission-MSN-X.other.json', `consumers/${own}.json`],
      write: 'consumers/mission-MSN-X.other.json',
    };
    expect(() =>
      capability.customerDecisionConsumerCapability(TENANT, caseDir(TENANT), sweepAccess)
    ).toThrow(/Only the customer decision consumer sweep/u);
    const sweepScope = capability.runInCustomerDecisionConsumerSweep(() =>
      capability.customerDecisionConsumerCapability(TENANT, caseDir(TENANT), sweepAccess)
    );
    expect(capability.isCustomerDecisionConsumerCapability(sweepScope)).toBe(false);
    expect(
      capability.runInCustomerDecisionConsumerSweep(() =>
        capability.isCustomerDecisionConsumerCapability(sweepScope)
      )
    ).toBe(true);
    // A task-boundary caller holding a sweep-shaped scope outside the sweep is refused.
    expect(() =>
      resourceScope.runInResourceAccessScope(sweepScope, () =>
        authority.withExecutionContext(
          capability.CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
          () => undefined,
          undefined,
          TENANT
        )
      )
    ).toThrow(/RESOURCE_SCOPE/u);
    // Task proposals go through the same own-lock path on the real guard.
    seedCase(TENANT);
    const recorded = lockModule.recordTaskDecisionProposals(
      {
        ...task,
        requests: [
          {
            question: 'Which theme?',
            item: 'UX',
            key: 'ui.theme',
            proposed_value: 'dark',
            requires_customer: false,
          },
        ],
      },
      { decisionCase: decisionCase(), now: NOW }
    );
    expect(recorded).toMatchObject({ case_found: true, recorded: 1 });
  });

  describe('content rules at the guard (a direct secure-io write under the capability)', () => {
    type LockEntry = { layer?: string; proposal?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    type LockJson = Record<string, unknown> & {
      decisions: LockEntry[];
      rework: unknown[];
      hold?: Record<string, unknown>;
    };
    const consumer = 'mission-MSN-CD09-BOUNDARY.build';
    const lockFile = `consumers/${consumer}.json`;
    const inCase = (relative: string) => path.join(ROOT, caseDir(TENANT), relative);
    const asConsumer = (access: { read: string[]; write?: string }, fn: () => unknown): unknown =>
      resourceScope.runInResourceAccessScope(
        capability.customerDecisionConsumerCapability(TENANT, caseDir(TENANT), {
          ...access,
          owner: consumer,
        }),
        () =>
          authority.withExecutionContext(
            capability.CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
            fn,
            undefined,
            TENANT
          )
      );
    const readLock = () =>
      asConsumer({ read: [lockFile] }, () =>
        JSON.parse(String(io.safeReadFile(inCase(lockFile), { encoding: 'utf8' })))
      ) as LockJson;
    const writeLock = (lock: unknown) =>
      asConsumer({ read: [], write: lockFile }, () =>
        io.safeWriteFile(inCase(lockFile), `${JSON.stringify(lock, null, 2)}\n`)
      );

    it('refuses dropping rework, rewriting a completed pin, appends and unlinks', () => {
      seedCase(TENANT);
      lockModule.pinTaskDecisions(task, { decisionCase: decisionCase(), now: NOW });
      customerDecides(TENANT);
      const settled = lockModule.reconcileTaskDecisions(task, {
        decisionCase: decisionCase(),
        now: LATER,
      });
      expect(settled.rework_work_item_ids).toHaveLength(1);
      const lock = readLock();
      expect(lock).toMatchObject({ status: 'completed' });
      expect(lock.rework).toHaveLength(1);
      const { rework: _dropped, ...withoutRework } = lock;
      void _dropped;
      expect(() => writeLock(withoutRework)).toThrow(
        /CUSTOMER_DECISION_CONSUMER_WRITE_REFUSED\] rework records are append-only/u
      );
      expect(() =>
        writeLock({
          ...lock,
          decisions: lock.decisions.map((entry: object) => ({ ...entry, value: 'sso' })),
        })
      ).toThrow(/pinned decisions of a completed consumer lock may not change/u);
      expect(() => writeLock({ ...lock, completed_at: NOW })).toThrow(/keeps its completed_at/u);
      expect(() => writeLock({ ...lock, mission_id: 'MSN-OTHER' })).toThrow(
        /mission_id may not change/u
      );
      expect(() =>
        asConsumer({ read: [], write: lockFile }, () =>
          io.safeAppendFileSync(inCase(lockFile), ' ')
        )
      ).toThrow(/CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED/u);
      expect(() =>
        asConsumer({ read: [], write: lockFile }, () => io.safeUnlinkSync(inCase(lockFile)))
      ).toThrow(/CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED/u);
      // What the store itself does still passes: a recorded check, an appended rework record.
      writeLock({
        ...lock,
        last_check: { at: LATER, checked: 1, stale_count: 0 },
        rework: [
          ...lock.rework,
          { work_item_id: 'WI-CDR-0123456789ABCDEF', refs: ['D-0001'], at: LATER },
        ],
      });
      expect(readLock().rework).toHaveLength(2);
    });

    it('refuses releasing a held task by editing its lock', () => {
      seedCase(TENANT);
      lockModule.pinTaskDecisions(task, { decisionCase: decisionCase(), now: NOW });
      const held = lockModule.recordTaskDecisionProposals(
        {
          ...task,
          requests: [
            {
              question: 'May we release?',
              item: 'RELEASE',
              key: 'release.go',
              requires_customer: true,
            },
          ],
          workItemId: 'WI-TASK',
        },
        { decisionCase: decisionCase(), now: NOW }
      );
      expect(held.hold_proposal_ids).toHaveLength(1);
      const lock = readLock();
      expect(lock.hold).toMatchObject({ work_item_id: 'WI-TASK', at: NOW });
      const pins = lock.decisions.filter((entry: LockEntry) => entry.layer !== 'task_proposal');
      expect(() => writeLock({ ...lock, decisions: pins })).toThrow(
        /task proposals may not be removed/u
      );
      const { hold: _hold, ...withoutHold } = lock;
      void _hold;
      expect(() => writeLock(withoutHold)).toThrow(/a hold may not be removed/u);
      expect(() => writeLock({ ...lock, hold: { ...lock.hold, resolved_at: LATER } })).toThrow(
        /every requires_customer proposal is resolved/u
      );
      const forged = lock.decisions.map((entry: LockEntry) =>
        entry.layer === 'task_proposal'
          ? {
              ...entry,
              agenda_id: 'agd-boundary01',
              entry_id: 'nfr.auth',
              proposal: { ...entry.proposal, resolved: { decision_id: 'D-0001', at: LATER } },
            }
          : entry
      );
      expect(() => writeLock({ ...lock, decisions: forged })).toThrow(
        /resolved only by a customer decision the operator confirmed/u
      );
      expect(() =>
        writeLock({
          ...lock,
          decisions: lock.decisions.map((entry: LockEntry) =>
            entry.layer === 'task_proposal'
              ? { ...entry, proposal: { ...entry.proposal, requires_customer: false } }
              : entry
          ),
        })
      ).toThrow(/never loses requires_customer/u);
      expect(
        lockModule.isTaskAwaitingCustomerDecision(task, {
          decisionCase: decisionCase(),
          now: LATER,
        })
      ).toBe(true);
    });

    describe('re-ask relink and supersede (CD-09 lifecycle)', () => {
      const ENTRY = {
        item: 'RELEASE',
        key: 'release.go',
        kind: 'approval' as const,
        question: 'May we release?',
        requires_customer: true,
      };
      /** Write an agenda as the operator facade does (decision_ledger). */
      const putAgenda = (
        agendaId: string,
        status: 'draft' | 'withdrawn' | 'closed',
        entry: Record<string, unknown>
      ) =>
        authority.withExecutionContext(
          'decision_ledger',
          () =>
            store.writeAgenda(
              { tenantSlug: TENANT, caseId: CASE },
              { ...agenda(TENANT), agenda_id: agendaId, status, entries: [entry as never] }
            ),
          'sovereign',
          TENANT
        );
      /** A held task whose question the operator collected onto agd-old00001. */
      function collected(): { lock: LockJson; proposalId: string } {
        seedCase(TENANT);
        lockModule.pinTaskDecisions(task, { decisionCase: decisionCase(), now: NOW });
        const held = lockModule.recordTaskDecisionProposals(
          {
            ...task,
            requests: [
              {
                question: ENTRY.question,
                item: ENTRY.item,
                key: ENTRY.key,
                requires_customer: true,
              },
            ],
            workItemId: 'WI-TASK',
          },
          { decisionCase: decisionCase(), now: NOW }
        );
        const [proposalId] = held.hold_proposal_ids;
        putAgenda('agd-old00001', 'draft', { ...ENTRY, entry_id: proposalId });
        authority.withExecutionContext(
          'decision_ledger',
          () => {
            const location = { tenantSlug: TENANT, caseId: CASE };
            const current = store.readConsumedDecisionLock(location, consumer)!;
            store.writeConsumedDecisionLock(location, {
              ...current,
              decisions: current.decisions.map((entry) =>
                entry.proposal?.proposal_id === proposalId
                  ? {
                      ...entry,
                      agenda_id: 'agd-old00001',
                      entry_id: proposalId,
                      proposal: { ...entry.proposal, collected_at: NOW },
                    }
                  : entry
              ),
            });
          },
          'sovereign',
          TENANT
        );
        return { lock: readLock(), proposalId };
      }
      const relinkTo = (
        lock: LockJson,
        proposalId: string,
        agendaId: string,
        edit: (proposal: Record<string, unknown>) => Record<string, unknown> = (p) => p
      ): LockJson => ({
        ...lock,
        decisions: lock.decisions.map((entry) => {
          if (entry.proposal?.proposal_id !== proposalId) return entry;
          const { collected_at: collectedAt, ...rest } = entry.proposal;
          return {
            ...entry,
            agenda_id: agendaId,
            entry_id: proposalId,
            proposal: edit({
              ...rest,
              collected_at: LATER,
              previous_links: [
                {
                  agenda_id: entry.agenda_id,
                  entry_id: entry.entry_id,
                  collected_at: collectedAt,
                  relinked_at: LATER,
                  relinked_by: 'user:alice',
                },
              ],
            }),
          };
        }),
      });

      it('allows the exact relink only once the old agenda is closed and onto a requires_customer entry', () => {
        const { lock, proposalId } = collected();
        putAgenda('agd-new00001', 'draft', { ...ENTRY, entry_id: proposalId });
        putAgenda('agd-plain0001', 'draft', {
          ...ENTRY,
          entry_id: proposalId,
          requires_customer: false,
          org_default: { value: { approved: true }, source: 'hearing:aidlc_inception' },
        });
        putAgenda('agd-other0001', 'draft', {
          ...ENTRY,
          entry_id: proposalId,
          key: 'release.other',
        });
        // The old agenda is still open: nothing to re-ask.
        expect(() => writeLock(relinkTo(lock, proposalId, 'agd-new00001'))).toThrow(
          /re-asked only when its agenda is closed, withdrawn or gone/u
        );
        putAgenda('agd-old00001', 'withdrawn', { ...ENTRY, entry_id: proposalId });
        expect(() => writeLock(relinkTo(lock, proposalId, 'agd-plain0001'))).toThrow(
          /only on a requires_customer agenda entry/u
        );
        expect(() => writeLock(relinkTo(lock, proposalId, 'agd-other0001'))).toThrow(
          /an agenda entry with its item and key/u
        );
        // A forged relink onto an agenda that does not exist.
        expect(() => writeLock(relinkTo(lock, proposalId, 'agd-missing01'))).toThrow(
          /re-asked on an agenda that is open/u
        );
        expect(() =>
          writeLock(
            relinkTo(lock, proposalId, 'agd-new00001', (p) => ({ ...p, question: 'Edited?' }))
          )
        ).toThrow(/keeps its question, item, key and value/u);
        expect(() =>
          writeLock(
            relinkTo(lock, proposalId, 'agd-new00001', (p) => ({
              ...p,
              resolved: { decision_id: 'D-0001', at: LATER },
            }))
          )
        ).toThrow(/re-asked task proposal is not resolved/u);
        expect(() =>
          writeLock({
            ...relinkTo(lock, proposalId, 'agd-new00001'),
            hold: { ...lock.hold, at: LATER },
          })
        ).toThrow(/a hold keeps its start|re-ask leaves the hold/u);

        // The legitimate path: the store helper + relinkTaskProposal on the real guard.
        const location = { tenantSlug: TENANT, caseId: CASE };
        const own = `consumers/${consumer}.json`;
        store.asCustomerDecisionConsumerOwner(
          TENANT,
          location,
          {
            owner: consumer,
            read: [
              'decisions.jsonl',
              'agendas/agd-old00001.json',
              'agendas/agd-new00001.json',
              own,
            ],
            write: own,
          },
          () => {
            const current = store.readConsumedDecisionLock(location, consumer)!;
            store.writeConsumedDecisionLock(location, {
              ...current,
              decisions: current.decisions.map((entry) =>
                entry.proposal?.proposal_id === proposalId
                  ? consumption.relinkTaskProposal(
                      { ...entry, proposal: entry.proposal },
                      { agenda_id: 'agd-new00001', entry_id: proposalId },
                      LATER,
                      'user:alice'
                    )
                  : entry
              ),
            });
          }
        );
        const relinked = readLock();
        const proposal = relinked.decisions.find(
          (entry) => entry.proposal?.proposal_id === proposalId
        )!.proposal!;
        expect(proposal.previous_links).toEqual([
          {
            agenda_id: 'agd-old00001',
            entry_id: proposalId,
            collected_at: NOW,
            relinked_at: LATER,
            relinked_by: 'user:alice',
          },
        ]);
        // History is immutable: dropped or edited links are refused.
        const withLinks = (links: unknown[]) => ({
          ...relinked,
          decisions: relinked.decisions.map((entry) =>
            entry.proposal?.proposal_id === proposalId
              ? { ...entry, proposal: { ...entry.proposal, previous_links: links } }
              : entry
          ),
        });
        expect(() => writeLock(withLinks([]))).toThrow(/appends exactly one earlier link/u);
        expect(() =>
          writeLock(
            withLinks([
              { ...(proposal.previous_links as object[])[0], relinked_by: 'user:mallory' },
            ])
          )
        ).toThrow(/appends exactly one earlier link/u);
        // Still held: the re-ask leaves the hold as it is.
        expect(relinked.hold).toEqual(lock.hold);
      });

      it('superseded is added once, alone, by another task of the mission; the lock is frozen', () => {
        const { lock } = collected();
        const by = { by_consumer: `${consumer}-v2`, by_task_id: 'build-v2', at: LATER };
        expect(() =>
          writeLock({ ...lock, superseded: { ...by, by_consumer: 'mission-MSN-OTHER.build-v2' } })
        ).toThrow(/superseded only by another task of the same mission/u);
        expect(() =>
          writeLock({ ...lock, superseded: { ...by, by_task_id: task.taskId } })
        ).toThrow(/superseded only by another task of the same mission/u);
        expect(() =>
          writeLock({ ...lock, status: 'completed', completed_at: LATER, superseded: by })
        ).toThrow(/adds only superseded/u);
        const superseded = authority.withExecutionContext(
          'decision_ledger',
          () =>
            store.supersededConsumedDecisionLock(
              store.readConsumedDecisionLock({ tenantSlug: TENANT, caseId: CASE }, consumer)!,
              by
            ),
          'sovereign',
          TENANT
        );
        writeLock(superseded);
        expect(readLock().superseded).toEqual(by);
        // Frozen: an identical re-write passes, anything else is refused.
        writeLock(superseded);
        expect(() =>
          writeLock({ ...superseded, last_check: { at: LATER, checked: 0, stale_count: 0 } })
        ).toThrow(/a superseded consumer lock is frozen/u);
        const { superseded: _dropped, ...unsuperseded } = superseded;
        void _dropped;
        expect(() => writeLock(unsuperseded)).toThrow(/a superseded consumer lock is frozen/u);
        expect(() =>
          store.supersededConsumedDecisionLock(superseded, { ...by, by_task_id: 'build-v3' })
        ).toThrow(/already superseded by another task/u);
      });

      it('a new lock is never superseded and never carries earlier links', () => {
        seedCase(TENANT);
        const fresh = {
          version: '1.0.0',
          case_id: CASE,
          consumer,
          mission_id: task.missionId,
          task_id: task.taskId,
          status: 'in_progress',
          locked_at: NOW,
          decisions: [],
        };
        const writeFresh = (lock: unknown) =>
          asConsumer({ read: [], write: lockFile }, () => {
            io.safeMkdir(inCase('consumers'), { recursive: true });
            io.safeWriteFile(inCase(lockFile), JSON.stringify(lock));
          });
        expect(() =>
          writeFresh({
            ...fresh,
            superseded: { by_consumer: `${consumer}-v2`, by_task_id: 'build-v2', at: NOW },
          })
        ).toThrow(/a new consumer lock is never superseded/u);
        expect(() =>
          writeFresh({
            ...fresh,
            decisions: [
              {
                item: 'RELEASE',
                key: 'release.go',
                layer: 'task_proposal',
                proposal: {
                  proposal_id: 'tp-0123456789abcdef',
                  question: 'May we release?',
                  requires_customer: true,
                  proposed_at: NOW,
                  previous_links: [
                    {
                      agenda_id: 'agd-old00001',
                      entry_id: 'x',
                      collected_at: NOW,
                      relinked_at: NOW,
                      relinked_by: 'user:alice',
                    },
                  ],
                },
              },
            ],
          })
        ).toThrow(/a new task proposal has no earlier links/u);
      });
    });

    it('a new lock starts in progress without rework', () => {
      seedCase(TENANT);
      const fresh = {
        version: '1.0.0',
        case_id: CASE,
        consumer,
        mission_id: task.missionId,
        task_id: task.taskId,
        status: 'completed',
        locked_at: NOW,
        decisions: [],
      };
      expect(() =>
        asConsumer({ read: [], write: lockFile }, () => {
          io.safeMkdir(inCase('consumers'), { recursive: true });
          io.safeWriteFile(inCase(lockFile), JSON.stringify(fresh));
        })
      ).toThrow(/a new consumer lock starts in progress/u);
    });

    it('the milestone store may only append to milestones_passed', async () => {
      seedCase(TENANT);
      const milestone = await import('./foundation/customer-decision-milestone-capability.js');
      const agendaFile = 'agendas/agd-boundary01.json';
      const asMilestone = (fn: () => unknown) =>
        resourceScope.runInResourceAccessScope(
          milestone.customerDecisionMilestoneCapability(TENANT, caseDir(TENANT), {
            read: [agendaFile],
            write: agendaFile,
          }),
          () =>
            authority.withExecutionContext(
              milestone.CUSTOMER_DECISION_MILESTONE_STORE_ROLE,
              fn,
              undefined,
              TENANT
            )
        );
      const current = asMilestone(() =>
        JSON.parse(String(io.safeReadFile(inCase(agendaFile), { encoding: 'utf8' })))
      ) as Record<string, unknown>;
      const write = (agendaRecord: unknown) =>
        asMilestone(() => io.safeWriteFile(inCase(agendaFile), JSON.stringify(agendaRecord)));
      expect(() => write({ ...current, title: 'Rewritten' })).toThrow(
        /CUSTOMER_DECISION_MILESTONE_WRITE_REFUSED/u
      );
      expect(() =>
        write({
          ...current,
          operator_confirmations: [
            { entry_id: 'nfr.auth', decision_id: 'D-0001', by: 'user:x', at: LATER },
          ],
          milestones_passed: ['bolt-after:MSN-A'],
        })
      ).toThrow(/may change only milestones_passed and updated_at/u);
      write({ ...current, milestones_passed: ['bolt-after:MSN-A'], updated_at: LATER });
      expect(() => write({ ...current, milestones_passed: [], updated_at: LATER })).toThrow(
        /may only append to milestones_passed/u
      );
      expect(() => asMilestone(() => io.safeAppendFileSync(inCase(agendaFile), ' '))).toThrow(
        /CUSTOMER_DECISION_WRITE_CONTENT_REQUIRED/u
      );
    });
  });
});
