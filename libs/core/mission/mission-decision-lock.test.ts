import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { appendDecisions } from '../decision-ledger/ledger.js';
import type { DealRecord } from '../deal-store.js';
import type { DecisionAgenda } from '../customer-decision/model.js';
import {
  customerDecisionPaths,
  withCustomerDecisionCaseLock,
  readAgenda,
  readConsumedDecisionLock,
  writeAgenda,
} from '../customer-decision/store.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import {
  pinTaskDecisions,
  reconcileTaskDecisions,
  isTaskAwaitingCustomerDecision,
  recordTaskDecisionProposals,
  resolveMissionDecisionCase,
  sweepDecisionConsumers,
  SWEEP_LOCK_TIMEOUT_MS,
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

    it("carries the mission's project on the case only when it is a valid case id", () => {
      const deals = () => [deal('DEAL-1', [MISSION])];
      const onlyDeal = (candidate: MissionDecisionCase) => candidate.caseId === 'DEAL-1';
      const withProject = (projectId: string) =>
        state({
          relationships: { project: { project_id: projectId, relationship_type: 'belongs_to' } },
        });
      expect(
        resolveMissionDecisionCase(MISSION, {
          loadMissionState: () => withProject('PRJ-1'),
          listTenantDeals: deals,
          caseExists: onlyDeal,
        })
      ).toMatchObject({ caseId: 'DEAL-1', source: 'deal', projectId: 'PRJ-1' });
      const invalid = resolveMissionDecisionCase(MISSION, {
        loadMissionState: () => withProject('../not a case'),
        listTenantDeals: deals,
        caseExists: onlyDeal,
      });
      expect(invalid).toMatchObject({ caseId: 'DEAL-1', source: 'deal' });
      expect(invalid).not.toHaveProperty('projectId');
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
        decisionsRootExists: () => true,
        listTenantDeals: () => {
          throw new Error('[DEAL_SCOPE] unreadable');
        },
      };
      expect(pinTaskDecisions(task, broken)).toBeNull();
      expect(reconcileTaskDecisions(task, broken)).toMatchObject({ checked: 0, stale_count: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEAL_SCOPE'));
      expect(reworkItems()).toEqual([]);
      // Each boundary of the mission meets the same failure: warned once per message.
      const warned = warn.mock.calls.length;
      pinTaskDecisions({ ...task, taskId: 'other' }, broken);
      reconcileTaskDecisions({ ...task, taskId: 'other' }, broken);
      expect(warn.mock.calls.length).toBe(warned);
    });

    it('stops at one existence check when the tenant has no decisions root', () => {
      const listTenantDeals = vi.fn(() => []);
      const loadMissionState = () =>
        ({ mission_id: MISSION, tenant_slug: 'no-cases-tenant' }) as MissionState;
      // The real check, under the narrow role's existence-only capability.
      expect(pinTaskDecisions(task, { loadMissionState, listTenantDeals })).toBeNull();
      expect(listTenantDeals).not.toHaveBeenCalled();
      const rootExists = vi.fn(() => false);
      expect(
        resolveMissionDecisionCase(MISSION, {
          loadMissionState,
          listTenantDeals,
          decisionsRootExists: rootExists,
        })
      ).toBeNull();
      expect(rootExists).toHaveBeenCalledWith('no-cases-tenant');
      expect(listTenantDeals).not.toHaveBeenCalled();
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

  describe('task proposals (CD-09 実装中の判断を顧客に回す)', () => {
    const askLocale = {
      question: 'Which languages should the secret portal offer?',
      item: 'NFR',
      key: 'ui.locale',
      proposed_value: ['ja', 'secret-en'],
      requires_customer: false,
    };
    const askRelease = {
      question: 'May we release the secret build?',
      item: 'RELEASE',
      key: 'release.go',
      requires_customer: true,
    };
    const leaks = /secret|ui\.locale|release\.go|NFR|RELEASE/u;

    it('records nothing without a decision case and says so', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const result = recordTaskDecisionProposals(
        { ...task, requests: [askLocale, askRelease] },
        { loadMissionState: () => null }
      );
      expect(result).toEqual({
        case_found: false,
        consumer: 'mission-MSN-CD09-LOCK.impl',
        recorded: 0,
        proposal_ids: [],
        hold_proposal_ids: [],
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no decision case'));
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(leaks);
    });

    it('records proposals on the task lock and holds on requires_customer, ids only out', () => {
      expect(pinTaskDecisions(task, { decisionCase, now: NOW })?.pinned_count).toBe(1);
      const result = recordTaskDecisionProposals(
        { ...task, requests: [askLocale, askRelease], workItemId: 'WI-TASK' },
        { decisionCase, now: NOW }
      );
      expect(result).toMatchObject({ case_found: true, case_id: 'case-a', recorded: 2 });
      expect(result.hold_proposal_ids).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(leaks);
      const lock = readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-LOCK.impl')!;
      expect(lock.status).toBe('in_progress');
      expect(lock.hold).toEqual({ work_item_id: 'WI-TASK', at: NOW });
      expect(lock.decisions.map((entry) => entry.layer)).toEqual([
        'org_default',
        'task_proposal',
        'task_proposal',
      ]);
      // The proposal is not a pin of the case: a redispatch of the held task re-pins.
      const repinned = pinTaskDecisions(task, { decisionCase, now: LATER });
      expect(repinned).toEqual({
        consumer: 'mission-MSN-CD09-LOCK.impl',
        pinned_count: 1,
        pinned: true,
      });
      // The open requires_customer question keeps the re-pinned task held.
      expect(readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-LOCK.impl')?.hold).toEqual({
        work_item_id: 'WI-TASK',
        at: NOW,
      });
    });

    it('completes on our proposal while nobody decided it: no rework', () => {
      pinTaskDecisions(task, { decisionCase, now: NOW });
      const result = recordTaskDecisionProposals(
        { ...task, requests: [askLocale] },
        { decisionCase, now: NOW }
      );
      expect(result.hold_proposal_ids).toEqual([]);
      expect(reconcileTaskDecisions(task, { decisionCase, now: NOW })).toMatchObject({
        stale_count: 0,
        rework_work_item_ids: [],
      });
      expect(reworkItems()).toEqual([]);
    });

    it('releases a hold once the customer decision is confirmed, noting it on the WorkItem', () => {
      writeAgenda(
        { dir },
        {
          ...agenda(),
          entries: [
            ...agenda().entries,
            {
              entry_id: 'release',
              item: 'RELEASE',
              key: 'release.go',
              kind: 'approval',
              question: 'May we release the secret build?',
              requires_customer: true,
            },
          ],
          status: 'sent',
          approval: { content_hash: 'a'.repeat(64), approved_at: NOW, approved_by: 'user:boss' },
        }
      );
      const workItem = createWorkItem({
        title: 'impl',
        description: 'impl',
        status: 'blocked',
        metadata: { blocked_reason: 'awaiting_customer_decision', task_id: 'impl' },
      });
      pinTaskDecisions(task, { decisionCase, now: NOW });
      const held = recordTaskDecisionProposals(
        { ...task, requests: [askRelease], workItemId: workItem.item_id },
        { decisionCase, now: NOW }
      );
      expect(held.hold_proposal_ids).toHaveLength(1);
      const sweep = () =>
        sweepDecisionConsumers(
          { tenantSlug: TENANT, caseId: 'case-a', location: { dir } },
          { now: LATER }
        );
      // Not decided yet: still held.
      expect(sweep()).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
      appendDecisions(
        { dir },
        [
          {
            item: 'RELEASE',
            key: 'release.go',
            level: 'customer-value',
            state: 'decided',
            value: { approved: true },
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
      // Decided, but provisional until the operator confirms it.
      expect(sweep()).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
      const current = readAgenda({ dir }, 'agd-test0001')!;
      writeAgenda(
        { dir },
        {
          ...current,
          operator_confirmations: [
            { entry_id: 'release', decision_id: 'D-0001', by: 'user:boss', at: LATER },
          ],
        }
      );
      expect(sweep()).toEqual({
        stale_consumers: [],
        rework_work_item_ids: [],
        released_holds: ['mission-MSN-CD09-LOCK.impl'],
      });
      const lock = readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-LOCK.impl')!;
      expect(lock.hold).toMatchObject({ resolved_at: LATER });
      expect(
        lock.decisions.find((entry) => entry.layer === 'task_proposal')?.proposal
      ).toMatchObject({ resolved: { decision_id: 'D-0001', at: LATER } });
      const noted = getWorkItem(workItem.item_id)!;
      expect(noted.status).toBe('blocked');
      expect(noted.metadata).toMatchObject({
        blocked_reason: 'awaiting_customer_decision',
        customer_decision_hold: {
          status: 'resolved',
          case_id: 'case-a',
          decision_ids: ['D-0001'],
          next: 'pnpm mission resume MSN-CD09-LOCK',
        },
      });
      expect(JSON.stringify(noted)).not.toMatch(leaks);
      // Released once.
      expect(sweep()).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
    });
  });

  describe('re-pins and the sweep budget (CD-09 review)', () => {
    const releaseEntry = {
      entry_id: 'release',
      item: 'RELEASE',
      key: 'release.go',
      kind: 'approval' as const,
      question: 'May we release?',
      requires_customer: true,
    };
    const askRelease = {
      question: 'May we release?',
      item: 'RELEASE',
      key: 'release.go',
      requires_customer: true,
    };
    const decide = (item: string, key: string, value: unknown, at = LATER) =>
      appendDecisions(
        { dir },
        [
          {
            item,
            key,
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
            decided_at: at,
          },
        ],
        { caseId: 'case-a' }
      );
    const lockNow = () => readConsumedDecisionLock({ dir }, 'mission-MSN-CD09-LOCK.impl')!;
    const proposalsNow = () =>
      lockNow().decisions.filter((entry) => entry.layer === 'task_proposal');

    it('a resumed held task keeps its answered proposal even after the agenda closed: no new question, no hold', () => {
      writeAgenda(
        { dir },
        {
          ...agenda(),
          entries: [...agenda().entries, releaseEntry],
          status: 'sent',
          approval: { content_hash: 'a'.repeat(64), approved_at: NOW, approved_by: 'user:boss' },
        }
      );
      pinTaskDecisions(task, { decisionCase, now: NOW });
      expect(
        recordTaskDecisionProposals({ ...task, requests: [askRelease] }, { decisionCase, now: NOW })
          .hold_proposal_ids
      ).toHaveLength(1);
      decide('RELEASE', 'release.go', { approved: true });
      const current = readAgenda({ dir }, 'agd-test0001')!;
      writeAgenda(
        { dir },
        {
          ...current,
          operator_confirmations: [
            { entry_id: 'release', decision_id: 'D-0001', by: 'user:boss', at: LATER },
          ],
        }
      );
      sweepDecisionConsumers(
        { tenantSlug: TENANT, caseId: 'case-a', location: { dir } },
        { now: LATER }
      );
      // The operator closes the agenda, then resumes the mission.
      writeAgenda({ dir }, { ...readAgenda({ dir }, 'agd-test0001')!, status: 'closed' });
      expect(pinTaskDecisions(task, { decisionCase, now: LATER })?.pinned).toBe(true);
      expect(lockNow()).not.toHaveProperty('hold');
      expect(proposalsNow()).toEqual([
        expect.objectContaining({
          agenda_id: 'agd-test0001',
          entry_id: 'release',
          proposal: expect.objectContaining({ resolved: { decision_id: 'D-0001', at: LATER } }),
        }),
      ]);
      // The re-run asks again: answered, so no pending proposal and no hold.
      const again = recordTaskDecisionProposals(
        { ...task, requests: [askRelease] },
        { decisionCase, now: LATER }
      );
      expect(again.hold_proposal_ids).toEqual([]);
      expect(proposalsNow()).toHaveLength(1);
      expect(proposalsNow()[0].agenda_id).toBe('agd-test0001');
    });

    it('an uncollected proposal survives the re-pin of a new run', () => {
      pinTaskDecisions(task, { decisionCase, now: NOW });
      recordTaskDecisionProposals(
        {
          ...task,
          requests: [
            {
              question: 'Theme?',
              item: 'UX',
              key: 'ui.theme',
              proposed_value: 'dark',
              requires_customer: false,
            },
          ],
        },
        { decisionCase, now: NOW }
      );
      reconcileTaskDecisions(task, { decisionCase, now: NOW });
      pinTaskDecisions(task, { decisionCase, now: LATER });
      expect(proposalsNow()).toEqual([expect.objectContaining({ item: 'UX', value: 'dark' })]);
      expect(proposalsNow()[0]).not.toHaveProperty('agenda_id');
    });

    it('every dispatch attempt re-pins, so a retry after a switch files no rework', () => {
      pinTaskDecisions(task, { decisionCase, now: NOW });
      // The first attempt fails / blocks; the customer decides meanwhile.
      decide('NFR', 'auth.method', 'sso-secret-value');
      expect(pinTaskDecisions(task, { decisionCase, now: LATER })?.pinned).toBe(true);
      expect(reconcileTaskDecisions(task, { decisionCase, now: LATER })).toMatchObject({
        stale_count: 0,
        rework_work_item_ids: [],
      });
      expect(reworkItems()).toEqual([]);
    });

    it('a pin on an agenda withdrawn later is reconciled against what that agenda resolves to', () => {
      pinTaskDecisions(task, { decisionCase, now: NOW });
      writeAgenda({ dir }, { ...agenda(), status: 'withdrawn' });
      expect(reconcileTaskDecisions(task, { decisionCase, now: LATER })).toMatchObject({
        checked: 1,
        stale_count: 0,
        rework_work_item_ids: [],
      });
      // A later re-pin no longer pins the withdrawn agenda's decisions.
      expect(pinTaskDecisions(task, { decisionCase, now: LATER })?.pinned_count).toBe(0);
    });

    it('the sweep waits only briefly for a held case lock and skips with a warning', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const started = Date.now();
      const result = withCustomerDecisionCaseLock({ dir }, () =>
        sweepDecisionConsumers(
          { tenantSlug: TENANT, caseId: 'case-a', location: { dir } },
          { now: LATER }
        )
      );
      // The default budget (what respond uses) stays well inside the room's 15 s facade timeout.
      expect(SWEEP_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
      expect(Date.now() - started).toBeLessThan(SWEEP_LOCK_TIMEOUT_MS + 2_000);
      expect(result).toEqual({ stale_consumers: [], rework_work_item_ids: [] });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('customer decision consumer sweep skipped')
      );
    });

    describe('a held task stays held until the customer decision is confirmed', () => {
      const releaseAgenda = (confirmed: boolean) => ({
        ...agenda(),
        entries: [...agenda().entries, releaseEntry],
        status: 'sent' as const,
        approval: { content_hash: 'a'.repeat(64), approved_at: NOW, approved_by: 'user:boss' },
        ...(confirmed
          ? {
              operator_confirmations: [
                { entry_id: 'release', decision_id: 'D-0001', by: 'user:boss', at: LATER },
              ],
            }
          : {}),
      });
      const holdOn = () => {
        pinTaskDecisions(task, { decisionCase, now: NOW });
        const held = recordTaskDecisionProposals(
          { ...task, requests: [askRelease], workItemId: 'WI-TASK' },
          { decisionCase, now: NOW }
        );
        expect(held.hold_proposal_ids).toHaveLength(1);
        return held.hold_proposal_ids;
      };

      it('resumed before confirm, a result with no questions is still held', () => {
        const ids = holdOn();
        // mission resume → a new dispatch attempt re-pins.
        pinTaskDecisions(task, { decisionCase, now: LATER });
        expect(lockNow().hold).toEqual({ work_item_id: 'WI-TASK', at: NOW });
        const rerun = recordTaskDecisionProposals(
          { ...task, requests: [] },
          { decisionCase, now: LATER }
        );
        expect(rerun).toMatchObject({ case_found: true, hold_proposal_ids: ids });
      });

      it('a rerun that drops the requires_customer flag cannot lift the hold', () => {
        const ids = holdOn();
        pinTaskDecisions(task, { decisionCase, now: LATER });
        const rerun = recordTaskDecisionProposals(
          {
            ...task,
            requests: [{ ...askRelease, requires_customer: false, proposed_value: 'ship it' }],
          },
          { decisionCase, now: LATER }
        );
        expect(rerun.hold_proposal_ids).toEqual(ids);
        expect(proposalsNow()).toEqual([
          expect.objectContaining({
            proposal: expect.objectContaining({ requires_customer: true }),
          }),
        ]);
        expect(proposalsNow()[0]).not.toHaveProperty('value');
      });

      it('fails closed once the case is known, open before it is found', () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        holdOn();
        // A case whose state cannot be read (here: a corrupt agenda).
        safeWriteFile(
          `${customerDecisionPaths({ dir }).agendas}/agd-broken01.json`,
          '{"version":"1.0.0"}'
        );
        const failed = recordTaskDecisionProposals(
          { ...task, requests: [] },
          { decisionCase, now: LATER }
        );
        expect(failed).toMatchObject({ case_found: true, failed: true, case_id: 'case-a' });
        expect(
          isTaskAwaitingCustomerDecision({ ...task, taskId: 'unrelated' }, { decisionCase })
        ).toBe(true);
        // Finding the case itself fails (state unreadable, another tenant bound): not held.
        const lookupFails = {
          loadMissionState: () => {
            throw new Error('[ROLE_TENANT_SCOPE_MISMATCH] other tenant');
          },
        };
        expect(isTaskAwaitingCustomerDecision(task, lookupFails)).toBe(false);
        expect(recordTaskDecisionProposals({ ...task, requests: [] }, lookupFails)).toMatchObject({
          case_found: false,
          hold_proposal_ids: [],
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('customer decision case lookup failed')
        );
      });

      it('a resumed task with no questions and a case-lock timeout is blocked as a failed check', () => {
        holdOn();
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const result = withCustomerDecisionCaseLock({ dir }, () =>
          recordTaskDecisionProposals(
            { ...task, requests: [] },
            { decisionCase, now: LATER, lockTimeoutMs: 200 }
          )
        );
        expect(result).toMatchObject({ case_found: true, failed: true, case_id: 'case-a' });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('customer_decision_check_failed')
        );
      });

      it('a case lookup error falls back to the task WorkItem: held stays held, others are not', () => {
        const lookupFails = {
          loadMissionState: () => {
            throw new Error('[ROLE_TENANT_SCOPE_MISMATCH] other tenant');
          },
        };
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        expect(isTaskAwaitingCustomerDecision(task, lookupFails)).toBe(false);
        for (const reason of ['awaiting_customer_decision', 'customer_decision_check_failed']) {
          clearWorkCoordinationStore();
          createWorkItem({
            title: 'impl',
            description: 'impl',
            status: 'blocked',
            source: 'local',
            sourceRef: `mission:${MISSION}:impl`,
            metadata: { blocked_reason: reason },
          });
          expect(isTaskAwaitingCustomerDecision(task, lookupFails)).toBe(true);
        }
      });

      it('record-evidence reconcile keeps a held lock in progress and reports the hold by id', () => {
        const ids = holdOn();
        expect(isTaskAwaitingCustomerDecision(task, { decisionCase })).toBe(true);
        const check = reconcileTaskDecisions(task, { decisionCase, now: LATER });
        expect(check).toMatchObject({ held_proposal_ids: ids });
        expect(JSON.stringify(check)).not.toMatch(/release|RELEASE|secret/u);
        expect(lockNow()).toMatchObject({ status: 'in_progress', hold: { at: NOW } });
        expect(lockNow().last_check).toMatchObject({ at: LATER });
        expect(isTaskAwaitingCustomerDecision({ ...task, taskId: 'other' }, { decisionCase })).toBe(
          false
        );
      });

      it('after the operator confirms, the rerun completes', () => {
        writeAgenda({ dir }, releaseAgenda(false));
        holdOn();
        decide('RELEASE', 'release.go', { approved: true });
        // Decided but not confirmed: still held.
        expect(
          recordTaskDecisionProposals({ ...task, requests: [] }, { decisionCase, now: LATER })
            .hold_proposal_ids
        ).toHaveLength(1);
        writeAgenda({ dir }, releaseAgenda(true));
        pinTaskDecisions(task, { decisionCase, now: LATER });
        expect(lockNow()).not.toHaveProperty('hold');
        const rerun = recordTaskDecisionProposals(
          { ...task, requests: [] },
          { decisionCase, now: LATER }
        );
        expect(rerun.hold_proposal_ids).toEqual([]);
        expect(reconcileTaskDecisions(task, { decisionCase, now: LATER })).toMatchObject({
          stale_count: 0,
        });
        expect(lockNow().status).toBe('completed');
      });
    });
  });
});
