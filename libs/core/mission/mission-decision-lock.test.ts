import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { appendDecisions } from '../decision-ledger/ledger.js';
import type { DealRecord } from '../deal-store.js';
import type { DecisionAgenda } from '../customer-decision/model.js';
import {
  customerDecisionPaths,
  readConsumedDecisionLock,
  writeAgenda,
} from '../customer-decision/store.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import {
  pinTaskDecisions,
  reconcileTaskDecisions,
  resolveMissionDecisionCase,
  sweepDecisionConsumers,
  type MissionDecisionCase,
} from './mission-decision-lock.js';
import type { MissionState } from './mission-types.js';

const TENANT = 'acme-corp';
const MISSION = 'MSN-CD09-LOCK';
const NOW = '2026-10-24T00:00:00.000Z';
const LATER = '2026-10-25T00:00:00.000Z';

function agenda(): DecisionAgenda {
  return {
    version: '1.0.0',
    agenda_id: 'agd-test0001',
    tenant_slug: TENANT,
    case_id: 'case-a',
    customer: 'acme',
    title: 'Inception decisions',
    phase: 'inception',
    revision: 1,
    locale: 'ja',
    entries: [
      {
        entry_id: 'nfr.auth',
        item: 'NFR',
        key: 'auth.method',
        kind: 'choice',
        question: 'Which sign-in method?',
        org_default: { value: 'password-secret-value', source: 'hearing:aidlc_inception' },
        requires_customer: false,
      },
    ],
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
  };
}

function customerDecides(dir: string, value: unknown): void {
  appendDecisions(
    { dir },
    [
      {
        item: 'NFR',
        key: 'auth.method',
        level: 'customer-value',
        state: 'decided',
        value,
        basis: [{ ref: 'agenda:agd-test0001', version: 'h' }],
        origin: 'facade',
        decided_by: {
          kind: 'human',
          id: 'user:inv-1',
          on_behalf_of: { actor_id: 'customer:acme-cto', evidence: 'rcp-0001' },
        },
        decided_at: LATER,
      },
    ],
    { caseId: 'case-a' }
  );
}

function reworkItems() {
  return listWorkItems({}).filter((item) => item.item_id.startsWith('WI-CDR-'));
}

describe('mission decision lock (CD-09)', () => {
  let dir: string;
  let decisionCase: MissionDecisionCase;
  const task = { missionId: MISSION, taskId: 'impl' };

  beforeEach(() => {
    dir = pathResolver.sharedTmp(`mission-decision-lock-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    writeAgenda({ dir }, agenda());
    decisionCase = { tenantSlug: TENANT, caseId: 'case-a', source: 'project', location: { dir } };
    setWorkCoordinationNamespace(`mission-decision-lock-test-${process.pid}`);
    clearWorkCoordinationStore();
  });
  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
    vi.restoreAllMocks();
  });

  describe('case resolution', () => {
    const state = (overrides: Partial<MissionState> = {}) =>
      ({ mission_id: MISSION, tenant_slug: TENANT, ...overrides }) as MissionState;
    const deal = (dealId: string, missionIds: string[]) =>
      ({ deal_id: dealId, tenant_slug: TENANT, mission_ids: missionIds }) as DealRecord;

    it('uses the project case, else a deal listing the mission, else nothing', () => {
      const project = state({
        relationships: { project: { project_id: 'PRJ-1', relationship_type: 'belongs_to' } },
      });
      const exists = (ids: string[]) => (candidate: MissionDecisionCase) =>
        ids.includes(candidate.caseId);
      const deals = () => [deal('DEAL-other', ['MSN-OTHER']), deal('DEAL-1', [MISSION])];
      expect(
        resolveMissionDecisionCase(MISSION, {
          loadMissionState: () => project,
          listTenantDeals: deals,
          caseExists: exists(['PRJ-1', 'DEAL-1']),
        })
      ).toMatchObject({ caseId: 'PRJ-1', source: 'project', tenantSlug: TENANT });
      expect(
        resolveMissionDecisionCase(MISSION.toLowerCase(), {
          loadMissionState: () => project,
          listTenantDeals: deals,
          caseExists: exists(['DEAL-1']),
        })
      ).toMatchObject({ caseId: 'DEAL-1', source: 'deal' });
      expect(
        resolveMissionDecisionCase(MISSION, {
          loadMissionState: () => project,
          listTenantDeals: deals,
          caseExists: exists([]),
        })
      ).toBeNull();
      // No tenant: no lookup at all.
      const listTenantDeals = vi.fn(deals);
      expect(
        resolveMissionDecisionCase(MISSION, {
          loadMissionState: () => state({ tenant_slug: undefined }),
          listTenantDeals,
        })
      ).toBeNull();
      expect(listTenantDeals).not.toHaveBeenCalled();
    });

    it('leaves a mission without a case alone, and a lookup failure never throws', () => {
      const none = { loadMissionState: () => null };
      expect(pinTaskDecisions(task, none)).toBeNull();
      expect(reconcileTaskDecisions(task, none)).toEqual({
        checked: 0,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const broken = {
        loadMissionState: () => state(),
        listTenantDeals: () => {
          throw new Error('[DEAL_SCOPE] unreadable');
        },
      };
      expect(pinTaskDecisions(task, broken)).toBeNull();
      expect(reconcileTaskDecisions(task, broken)).toMatchObject({ checked: 0, stale_count: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEAL_SCOPE'));
      expect(reworkItems()).toEqual([]);
    });
  });

  it('pins at start, keeps the pin on a re-recorded start, and stays fresh without a WorkItem', () => {
    const options = { decisionCase, now: NOW };
    expect(pinTaskDecisions(task, options)).toEqual({
      consumer: 'mission-MSN-CD09-LOCK.impl',
      pinned_count: 1,
      pinned: true,
    });
    expect(pinTaskDecisions({ ...task, mode: 'if_absent' }, options)).toMatchObject({
      pinned: false,
    });
    const result = reconcileTaskDecisions(task, { decisionCase, now: LATER });
    expect(result).toEqual({
      consumer: 'mission-MSN-CD09-LOCK.impl',
      checked: 1,
      stale_count: 0,
      rework_work_item_ids: [],
    });
    expect(reworkItems()).toEqual([]);
    const lock = readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-LOCK.impl');
    expect(lock).toMatchObject({ status: 'completed', completed_at: LATER });
    // A record-task after completion does not move the pin; a new worker run does.
    expect(pinTaskDecisions({ ...task, mode: 'if_absent' }, options)?.pinned).toBe(false);
    expect(pinTaskDecisions(task, options)?.pinned).toBe(true);
  });

  it('files one rework WorkItem when the decision changed during the task, without values', () => {
    pinTaskDecisions(task, { decisionCase, now: NOW });
    customerDecides(dir, 'sso-secret-value');
    const result = reconcileTaskDecisions(task, { decisionCase, now: LATER });
    expect(result.stale_count).toBe(1);
    expect(result.rework_work_item_ids).toHaveLength(1);
    expect(result.rework_work_item_ids[0]).toMatch(/^WI-CDR-[A-F0-9]{16}$/u);
    // The result goes to public evidence: counts, consumer and ids only.
    expect(JSON.stringify(result)).not.toMatch(/secret-value|auth\.method|NFR|nfr\.auth/u);
    const items = reworkItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_id: result.rework_work_item_ids[0],
      status: 'backlog',
      context: { tenant_slug: TENANT, mission_id: MISSION, work_shape: 'solution_project' },
      metadata: { kind: 'customer_decision_rework', case_id: 'case-a', stale_count: 1 },
    });
    expect(JSON.stringify(items[0])).not.toMatch(/secret-value|auth\.method|NFR|nfr\.auth/u);
    // Re-recording evidence and a later sweep of the same switch find the same item.
    expect(reconcileTaskDecisions(task, { decisionCase, now: LATER }).rework_work_item_ids).toEqual(
      result.rework_work_item_ids
    );
    const swept = sweepDecisionConsumers(
      {
        tenantSlug: TENANT,
        caseId: 'case-a',
        location: { dir },
        switches: [
          {
            version: '1.0.0',
            switch_id: 'sw-test0001',
            case_id: 'case-a',
            agenda_id: 'agd-test0001',
            entry_id: 'nfr.auth',
            item: 'NFR',
            key: 'auth.method',
            kind: 'value_changed',
            from: { layer: 'org_default' },
            to: { layer: 'customer', decision_id: 'D-0001' },
            at: LATER,
          },
        ],
      },
      { now: LATER }
    );
    expect(swept).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
    expect(reworkItems()).toHaveLength(1);
  });

  it('a response after completion files the same single WorkItem the completion check would', () => {
    pinTaskDecisions(task, { decisionCase, now: NOW });
    expect(reconcileTaskDecisions(task, { decisionCase, now: NOW }).stale_count).toBe(0);
    customerDecides(dir, 'sso-secret-value');
    const switches = [
      {
        version: '1.0.0' as const,
        switch_id: 'sw-test0001',
        case_id: 'case-a',
        agenda_id: 'agd-test0001',
        entry_id: 'nfr.auth',
        item: 'NFR',
        key: 'auth.method',
        kind: 'value_changed' as const,
        from: { layer: 'org_default' as const },
        to: { layer: 'customer' as const, decision_id: 'D-0001' },
        at: LATER,
      },
    ];
    const sweep = () =>
      sweepDecisionConsumers(
        { tenantSlug: TENANT, caseId: 'case-a', location: { dir }, switches },
        { now: LATER }
      );
    const first = sweep();
    expect(first.stale_consumers).toEqual(['mission-MSN-CD09-LOCK.impl']);
    expect(first.rework_work_item_ids).toHaveLength(1);
    // Re-running the sweep, or the completion check, yields no second item.
    expect(sweep()).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
    expect(reconcileTaskDecisions(task, { decisionCase, now: LATER }).rework_work_item_ids).toEqual(
      first.rework_work_item_ids
    );
    expect(reworkItems().map((item) => item.item_id)).toEqual(first.rework_work_item_ids);
    expect(getWorkItem(first.rework_work_item_ids[0])).not.toBeNull();
  });

  it('a running task is left to its own completion check by the sweep', () => {
    pinTaskDecisions(task, { decisionCase, now: NOW });
    customerDecides(dir, 'sso-secret-value');
    expect(
      sweepDecisionConsumers(
        { tenantSlug: TENANT, caseId: 'case-a', location: { dir } },
        { now: LATER }
      )
    ).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
    expect(safeExistsSync(customerDecisionPaths({ dir }).consumers)).toBe(true);
    expect(reworkItems()).toEqual([]);
  });
});
