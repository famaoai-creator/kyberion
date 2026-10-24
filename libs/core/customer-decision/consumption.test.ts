import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DecisionRecord } from '../decision-ledger/model.js';
import {
  buildConsumedDecisionLock,
  currentDecisionRef,
  decisionReworkWorkItemId,
  findStaleConsumersForSwitches,
  missionTaskConsumerId,
  openAgendas,
  reconcileConsumedDecisionLock,
  unreworkedStale,
} from './consumption.js';
import { CONSUMER_ID_PATTERN, type DecisionAgenda, type DecisionSwitch } from './model.js';
import {
  customerDecisionPaths,
  listConsumedDecisionLocks,
  readConsumedDecisionLock,
  writeConsumedDecisionLock,
  type ConsumedDecisionLockRecord,
} from './store.js';

const NOW = '2026-10-24T00:00:00.000Z';
const LATER = '2026-10-25T00:00:00.000Z';

function agenda(overrides: Partial<DecisionAgenda> = {}): DecisionAgenda {
  return {
    version: '1.0.0',
    agenda_id: 'agd-test0001',
    tenant_slug: 'acme-corp',
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
        org_default: { value: 'password', source: 'hearing:aidlc_inception' },
        requires_customer: false,
      },
      {
        entry_id: 'data.retention',
        item: 'DATA',
        key: 'retention.days',
        kind: 'choice',
        question: 'How long?',
        org_default: { value: 30, source: 'hearing:aidlc_inception' },
        requires_customer: false,
      },
    ],
    status: 'sent',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function customerDecision(id: string, key: string, item: string, value: unknown): DecisionRecord {
  return {
    id,
    case_id: 'case-a',
    item,
    key,
    level: 'customer-value',
    state: 'decided',
    value,
    basis: [{ ref: 'agenda:agd-test0001', version: 'h' }],
    origin: 'facade',
    status: 'active',
    decided_by: {
      kind: 'human',
      id: 'user:inv-1',
      on_behalf_of: { actor_id: 'customer:acme-cto', evidence: 'rcp-0001' },
    },
    decided_at: NOW,
  };
}

function record(
  lock: ReturnType<typeof buildConsumedDecisionLock>,
  overrides: Partial<ConsumedDecisionLockRecord> = {}
): ConsumedDecisionLockRecord {
  return {
    version: '1.0.0',
    ...lock,
    tenant_slug: 'acme-corp',
    mission_id: 'MSN-CD09',
    task_id: 'impl',
    status: 'in_progress',
    ...overrides,
  };
}

function switchOf(entryId: string, item: string, key: string): DecisionSwitch {
  return {
    version: '1.0.0',
    switch_id: 'sw-test0001',
    case_id: 'case-a',
    agenda_id: 'agd-test0001',
    entry_id: entryId,
    item,
    key,
    kind: 'value_changed',
    from: { layer: 'org_default', value: 'password' },
    to: { layer: 'customer', value: 'sso', decision_id: 'D-0001' },
    at: LATER,
  };
}

describe('customer decision consumption (CD-09)', () => {
  it('derives a file-safe consumer id from the mission and task', () => {
    expect(missionTaskConsumerId('msn-cd09', 'impl')).toBe('mission-MSN-CD09.impl');
    const odd = missionTaskConsumerId('MSN-CD09', '../etc/passwd');
    expect(odd).toMatch(CONSUMER_ID_PATTERN);
    expect(odd).not.toContain('/');
    expect(odd).toBe(missionTaskConsumerId('MSN-CD09', '../etc/passwd'));
  });

  it('pins every effective decision of the open agendas only', () => {
    const agendas = [
      agenda(),
      agenda({ agenda_id: 'agd-closed01', status: 'closed' }),
      agenda({ agenda_id: 'agd-withdrawn', status: 'withdrawn' }),
    ];
    expect(openAgendas(agendas).map((item) => item.agenda_id)).toEqual(['agd-test0001']);
    const lock = buildConsumedDecisionLock({
      caseId: 'case-a',
      consumer: 'mission-MSN-CD09.impl',
      agendas,
      ledger: [],
      now: NOW,
    });
    expect(lock.decisions).toEqual([
      {
        agenda_id: 'agd-test0001',
        entry_id: 'nfr.auth',
        item: 'NFR',
        key: 'auth.method',
        layer: 'org_default',
        value: 'password',
      },
      {
        agenda_id: 'agd-test0001',
        entry_id: 'data.retention',
        item: 'DATA',
        key: 'retention.days',
        layer: 'org_default',
        value: 30,
      },
    ]);
  });

  it('reconciles a lock: fresh when only the layer changed, stale with the current decision ref', () => {
    const lock = buildConsumedDecisionLock({
      caseId: 'case-a',
      consumer: 'mission-MSN-CD09.impl',
      agendas: [agenda()],
      ledger: [],
      now: NOW,
    });
    // The customer kept the default for retention (same value) and changed auth.
    const ledger = [
      customerDecision('D-0001', 'auth.method', 'NFR', 'sso'),
      customerDecision('D-0002', 'retention.days', 'DATA', 30),
    ];
    const result = reconcileConsumedDecisionLock(lock, [agenda()], ledger, LATER);
    expect(result.checked).toBe(2);
    expect(result.stale).toEqual([
      {
        agenda_id: 'agd-test0001',
        entry_id: 'nfr.auth',
        item: 'NFR',
        key: 'auth.method',
        current_decision_id: 'D-0001',
        ref: 'D-0001',
      },
    ]);
    // An agenda closed after the pin still says what is in force.
    expect(
      reconcileConsumedDecisionLock(lock, [agenda({ status: 'closed' })], [], LATER).stale
    ).toEqual([]);
    // A pinned agenda that is gone makes its entries stale.
    expect(reconcileConsumedDecisionLock(lock, [], [], LATER).stale.map((s) => s.ref)).toEqual([
      'agd-test0001/nfr.auth:gone',
      'agd-test0001/data.retention:gone',
    ]);
    expect(currentDecisionRef('agd-x', 'e', { layer: 'org_default' })).toBe('agd-x/e:org_default');
  });

  it('derives one rework id per mission, task and ref set, with no decision content', () => {
    const id = decisionReworkWorkItemId('msn-cd09', 'impl', ['D-0002', 'D-0001']);
    expect(id).toMatch(/^WI-CDR-[A-F0-9]{16}$/u);
    expect(decisionReworkWorkItemId('MSN-CD09', 'impl', ['D-0001', 'D-0002', 'D-0001'])).toBe(id);
    expect(decisionReworkWorkItemId('MSN-CD09', 'other', ['D-0001', 'D-0002'])).not.toBe(id);
  });

  it('sweeps only completed consumers that pinned a switched entry, skipping covered refs', () => {
    const base = buildConsumedDecisionLock({
      caseId: 'case-a',
      consumer: 'mission-MSN-CD09.impl',
      agendas: [agenda()],
      ledger: [],
      now: NOW,
    });
    const ledger = [customerDecision('D-0001', 'auth.method', 'NFR', 'sso')];
    const completed = record(base, { status: 'completed', completed_at: NOW });
    const running = record(
      { ...base, consumer: 'mission-MSN-CD09.run' },
      { task_id: 'run', status: 'in_progress' }
    );
    const input = {
      switches: [switchOf('nfr.auth', 'NFR', 'auth.method')],
      agendas: [agenda()],
      ledger,
      now: LATER,
    };
    const findings = findStaleConsumersForSwitches({ ...input, locks: [completed, running] });
    expect(
      findings.map((finding) => [finding.lock.consumer, finding.stale.map((s) => s.ref)])
    ).toEqual([['mission-MSN-CD09.impl', ['D-0001']]]);
    // A switch on an entry the lock did not pin, or a covered ref: nothing.
    expect(
      findStaleConsumersForSwitches({
        ...input,
        switches: [switchOf('other', 'X', 'other.key')],
        locks: [completed],
      })
    ).toEqual([]);
    const covered = {
      ...completed,
      rework: [{ work_item_id: 'WI-CDR-0000000000000000', refs: ['D-0001'], at: LATER }],
    };
    expect(findStaleConsumersForSwitches({ ...input, locks: [covered] })).toEqual([]);
    expect(unreworkedStale(covered, findings[0].stale)).toEqual([]);
  });

  describe('consumer lock store', () => {
    let dir: string;
    beforeEach(() => {
      dir = pathResolver.sharedTmp(`customer-decision-consumers-${randomUUID()}`);
      safeMkdir(dir, { recursive: true });
    });
    afterEach(() => safeRmSync(dir, { recursive: true, force: true }));

    it('writes, reads and lists locks under consumers/, schema-validated', () => {
      const lock = record(
        buildConsumedDecisionLock({
          caseId: 'case-a',
          consumer: 'mission-MSN-CD09.impl',
          agendas: [agenda()],
          ledger: [],
          now: NOW,
        })
      );
      writeConsumedDecisionLock({ dir }, lock);
      expect(
        safeExistsSync(path.join(customerDecisionPaths({ dir }).consumers, `${lock.consumer}.json`))
      ).toBe(true);
      expect(readConsumedDecisionLock({ dir }, lock.consumer)).toEqual(lock);
      expect(() => readConsumedDecisionLock({ dir }, '../escape')).toThrow(
        /CUSTOMER_DECISION_CONSUMER_ID_INVALID/u
      );
      expect(() =>
        writeConsumedDecisionLock({ dir }, { ...lock, status: 'unknown' as never })
      ).toThrow();
      // A corrupt record is reported and skipped.
      safeWriteFile(
        path.join(customerDecisionPaths({ dir }).consumers, 'mission-MSN-CD09.bad.json'),
        '{"version":"1.0.0"}'
      );
      const invalid: string[] = [];
      expect(
        listConsumedDecisionLocks({ dir }, (consumer) => invalid.push(consumer)).map(
          (item) => item.consumer
        )
      ).toEqual(['mission-MSN-CD09.impl']);
      expect(invalid).toEqual(['mission-MSN-CD09.bad']);
    });

    it('refuses a lock bound to another case', () => {
      const lock = record(
        buildConsumedDecisionLock({
          caseId: 'case-a',
          consumer: 'mission-MSN-CD09.impl',
          agendas: [],
          ledger: [],
          now: NOW,
        })
      );
      expect(() =>
        writeConsumedDecisionLock({ tenantSlug: 'acme-corp', caseId: 'case-b' }, lock)
      ).toThrow(/CUSTOMER_DECISION_CASE_MISMATCH/u);
    });
  });
});
