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
      io.safeWriteFile(inCase(TENANT, 'consumers/mission-MSN-X.t.json'), '{}');
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
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([]);
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
});
