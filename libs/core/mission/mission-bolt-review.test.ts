import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addInboxEntry: vi.fn(),
  notify: vi.fn(() => ({ status: 'accepted' as const })),
}));
vi.mock('../deliverable-inbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deliverable-inbox.js')>()),
  addInboxEntry: mocks.addInboxEntry,
}));
vi.mock('../surface/operator-notifications.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorWithReceiptSync: mocks.notify,
}));

import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import type { DecisionAgenda } from '../customer-decision/model.js';
import {
  readAgenda,
  withCustomerDecisionCaseLock,
  writeAgenda,
} from '../customer-decision/store.js';
import { boltMilestone } from '../customer-decision/bolt-review.js';
import {
  customerDecisionMilestoneCapability,
  isCustomerDecisionMilestoneCapability,
} from '../foundation/customer-decision-milestone-capability.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import {
  boltReviewNextStep,
  fileBoltReviewWorkItem,
  notifyBoltReviewRejected,
  passBoltReviewMilestones,
} from './mission-bolt-review.js';
import type { MissionDecisionCase } from './mission-decision-lock.js';
import type { MissionState } from './mission-types.js';

const TENANT = 'acme-corp';
const NOW = '2026-10-24T00:00:00.000Z';
const BOLT_1 = 'MSN-BOLT-ONE';
const BOLT_2 = 'MSN-BOLT-TWO';

function review(agendaId: string, missionId: string, overrides: Partial<DecisionAgenda> = {}) {
  const agenda: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: agendaId,
    tenant_slug: TENANT,
    case_id: 'case-a',
    customer: 'acme',
    title: 'Review',
    phase: 'aidlc_construction',
    revision: 1,
    locale: 'en',
    bolt_mission_id: missionId,
    entries: [
      {
        entry_id: 'bolt_review',
        item: `bolt:${missionId}`,
        key: 'bolt.acceptance',
        kind: 'approval',
        question: 'Accept?',
        our_decision: { value: { approved: true } },
        requires_customer: false,
        override_until: { kind: 'milestone', milestone: boltMilestone(missionId) },
      },
    ],
    status: 'sent',
    approval: { content_hash: 'a'.repeat(64), approved_at: NOW, approved_by: 'user:boss' },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  return agenda;
}

describe('mission bolt review (CD-10)', () => {
  let dir: string;
  let decisionCase: MissionDecisionCase;
  const statuses: Record<string, string> = {};
  const loadMissionState = (id: string) =>
    (statuses[id] ? { mission_id: id, status: statuses[id] } : null) as MissionState | null;
  const options = () => ({ decisionCase, loadMissionState, now: NOW });
  const milestonesOf = (agendaId: string) => readAgenda({ dir }, agendaId)?.milestones_passed ?? [];

  beforeEach(() => {
    dir = pathResolver.sharedTmp(`mission-bolt-review-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    decisionCase = { tenantSlug: TENANT, caseId: 'case-a', source: 'project', location: { dir } };
    for (const key of Object.keys(statuses)) delete statuses[key];
    mocks.addInboxEntry.mockReset();
    mocks.notify.mockClear();
  });
  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('next-bolt milestone', () => {
    it('passes on the next bolt start, not on the same mission or an unfinished one', () => {
      writeAgenda({ dir }, review('agd-review0001', BOLT_1));
      statuses[BOLT_1] = 'active';
      // The reviewed bolt itself restarting never closes its own review.
      expect(passBoltReviewMilestones(BOLT_1, options())?.passed_agenda_ids).toEqual([]);
      // A bolt that is not finished yet keeps the review open.
      expect(passBoltReviewMilestones(BOLT_2, options())?.passed_agenda_ids).toEqual([]);
      expect(milestonesOf('agd-review0001')).toEqual([]);

      statuses[BOLT_1] = 'completed';
      expect(passBoltReviewMilestones(BOLT_2, options())).toEqual({
        case_id: 'case-a',
        milestone: boltMilestone(BOLT_2),
        passed_agenda_ids: ['agd-review0001'],
      });
      expect(milestonesOf('agd-review0001')).toEqual([boltMilestone(BOLT_1)]);
      // Idempotent: a second start adds nothing.
      expect(passBoltReviewMilestones(BOLT_2, options())?.passed_agenda_ids).toEqual([]);
      expect(milestonesOf('agd-review0001')).toEqual([boltMilestone(BOLT_1)]);
    });

    it('leaves closed / withdrawn reviews and non-review agendas alone', () => {
      statuses[BOLT_1] = 'completed';
      writeAgenda({ dir }, review('agd-review0001', BOLT_1, { status: 'closed' }));
      const plain = review('agd-plain0001', BOLT_1);
      delete plain.bolt_mission_id;
      writeAgenda({ dir }, plain);
      expect(passBoltReviewMilestones(BOLT_2, options())?.passed_agenda_ids).toEqual([]);
      expect(milestonesOf('agd-review0001')).toEqual([]);
      expect(milestonesOf('agd-plain0001')).toEqual([]);
    });

    it('a mission without a case costs one existence check and no lock', () => {
      const rootExists = vi.fn(() => false);
      const caseExists = vi.fn(() => true);
      expect(
        passBoltReviewMilestones(BOLT_2, {
          loadMissionState: () => ({ mission_id: BOLT_2, tenant_slug: TENANT }) as MissionState,
          decisionsRootExists: rootExists,
          caseExists,
          listTenantDeals: () => {
            throw new Error('no deal scan expected');
          },
        })
      ).toBeNull();
      expect(rootExists).toHaveBeenCalledTimes(1);
      expect(caseExists).not.toHaveBeenCalled();
      // A mission without a tenant: nothing at all.
      expect(passBoltReviewMilestones(BOLT_2, { loadMissionState: () => null })).toBeNull();
    });

    it('a busy case warns and never blocks the start', () => {
      statuses[BOLT_1] = 'completed';
      writeAgenda({ dir }, review('agd-review0001', BOLT_1));
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const result = withCustomerDecisionCaseLock({ dir }, () =>
        passBoltReviewMilestones(BOLT_2, { ...options(), lockTimeoutMs: 50 })
      );
      expect(result).toBeNull();
      const ours = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => !line.includes('[locale]'));
      expect(ours.some((line) => line.startsWith('bolt review milestone skipped'))).toBe(true);
      expect(milestonesOf('agd-review0001')).toEqual([]);
    });

    it('the milestone capability is exact: agenda files only, one write', () => {
      const caseDir = 'knowledge/confidential/acme-corp/decisions/case-a';
      const scope = customerDecisionMilestoneCapability(TENANT, caseDir, {
        read: ['agendas'],
        write: 'agendas/agd-review0001.json',
      });
      expect(scope).toMatchObject({
        readExact: [`${caseDir}/agendas`, `${caseDir}/agendas/agd-review0001.json`],
        writeExact: [`${caseDir}/agendas/agd-review0001.json`],
        mkdirExact: [`${caseDir}/agendas`],
      });
      expect(isCustomerDecisionMilestoneCapability(scope)).toBe(true);
      for (const access of [
        { read: ['decisions.jsonl'] },
        { read: ['consumers'] },
        { read: [], write: 'receipts/rcp-0000000000000001.json' },
        { read: [], write: 'consumers/mission-MSN-A.task.json' },
        { read: [], write: 'attachments/x.png' },
      ])
        expect(() => customerDecisionMilestoneCapability(TENANT, caseDir, access)).toThrow(
          /RESOURCE_SCOPE_INVALID/u
        );
      expect(() =>
        customerDecisionMilestoneCapability('other-co', caseDir, { read: ['agendas'] })
      ).toThrow(/RESOURCE_SCOPE_INVALID/u);
      expect(
        isCustomerDecisionMilestoneCapability({
          ...scope,
          writeExact: [...scope.writeExact, `${caseDir}/agendas/agd-review0002.json`],
        })
      ).toBe(false);
      expect(
        isCustomerDecisionMilestoneCapability({ ...scope, mkdirExact: [`${caseDir}/consumers`] })
      ).toBe(false);
    });
  });

  it('shows the bolt review command after finish only when the mission has a case', () => {
    expect(boltReviewNextStep(BOLT_1, { decisionCase })).toContain(
      `customer-decision bolt-review --tenant ${TENANT} --case case-a --mission ${BOLT_1}`
    );
    expect(boltReviewNextStep(BOLT_1, { decisionCase: null })).toBeNull();
  });

  describe('answer routing', () => {
    const input = {
      tenantSlug: TENANT,
      caseId: 'case-a',
      agendaId: 'agd-review0001',
      entryId: 'bolt_review',
      ref: 'D-0002',
      missionId: BOLT_1,
      projectId: 'PRJ-1',
    };

    beforeEach(() => {
      setWorkCoordinationNamespace(`mission-bolt-review-test-${process.pid}`);
      clearWorkCoordinationStore();
    });
    afterEach(() => {
      clearWorkCoordinationStore();
      clearWorkCoordinationNamespace();
    });

    it('request_changes files one backlog WorkItem with ids only', () => {
      const first = fileBoltReviewWorkItem(input);
      expect(fileBoltReviewWorkItem(input)).toBe(first);
      const items = listWorkItems({}).filter((item) => item.item_id.startsWith('WI-CDB-'));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        item_id: first,
        status: 'backlog',
        context: {
          tenant_slug: TENANT,
          project_id: 'PRJ-1',
          mission_id: BOLT_1,
          work_shape: 'solution_project',
        },
        metadata: {
          kind: 'customer_decision_bolt_changes',
          agenda_id: 'agd-review0001',
          ref: 'D-0002',
        },
      });
      // A different decision is a different item.
      expect(fileBoltReviewWorkItem({ ...input, ref: 'D-0003' })).not.toBe(first);
    });

    it('reject notifies the operator and adds an inbox entry, ids only', () => {
      const notice = notifyBoltReviewRejected(input);
      expect(notice.inbox_entry_id).toMatch(/^INBOX-CDB-/u);
      expect(mocks.addInboxEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: notice.inbox_entry_id,
          ifAbsent: true,
          missionId: BOLT_1,
          tenantSlug: TENANT,
          kind: 'customer_decision_bolt_rejected',
        })
      );
      expect(mocks.notify).toHaveBeenCalledWith(
        'question',
        expect.objectContaining({ correlation_id: notice.inbox_entry_id }),
        { deduplicationKey: notice.inbox_entry_id }
      );
      const sent = JSON.stringify([mocks.addInboxEntry.mock.calls, mocks.notify.mock.calls]);
      for (const id of ['agd-review0001', 'D-0002', 'case-a', BOLT_1]) expect(sent).toContain(id);
      expect(notifyBoltReviewRejected(input).inbox_entry_id).toBe(notice.inbox_entry_id);
    });
  });
});
