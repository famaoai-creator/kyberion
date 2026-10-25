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
  mergeTaskProposals,
  openAgendas,
  pendingTaskProposals,
  reconcileConsumedDecisionLock,
  resolvedTaskProposalDecisions,
  unconfirmedTaskProposals,
  taskProposalAgendaEntry,
  taskProposalHolds,
  taskProposalId,
  taskProposalsOf,
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

describe('task proposals (CD-09 実装中の判断を顧客に回す)', () => {
  const consumer = 'mission-MSN-CD09.impl';
  const proposeLocale = {
    question: 'Which languages should the portal offer?',
    item: 'NFR',
    key: 'ui.locale',
    proposed_value: ['ja', 'en'],
    options: [
      { value: ['ja'], label: 'Japanese' },
      { value: ['ja', 'en'], label: 'Japanese + English' },
    ],
    requires_customer: false,
    rationale: 'overseas branch',
  };
  const askRelease = {
    question: 'May we release on 11/1?',
    item: 'RELEASE',
    key: 'release.go',
    requires_customer: true,
    topic: 'release',
  };
  const empty = { consumer, decisions: [] };

  it('records proposals with stable ids, replaces an uncollected one, keeps a collected one', () => {
    const first = mergeTaskProposals({
      lock: empty,
      requests: [proposeLocale, askRelease],
      agendas: [],
      now: NOW,
    });
    const id = taskProposalId(consumer, 'NFR', 'ui.locale');
    expect(id).toMatch(/^tp-[a-f0-9]{16}$/u);
    expect(first.proposal_ids).toEqual([id, taskProposalId(consumer, 'RELEASE', 'release.go')]);
    const [locale, release] = taskProposalsOf(first);
    expect(locale).toMatchObject({
      item: 'NFR',
      key: 'ui.locale',
      layer: 'task_proposal',
      value: ['ja', 'en'],
      proposal: { proposal_id: id, requires_customer: false, proposed_at: NOW },
    });
    expect(locale).not.toHaveProperty('agenda_id');
    // A requires_customer question carries no value: it is a hold, not a pin.
    expect(release).not.toHaveProperty('value');
    expect(pendingTaskProposals(first)).toHaveLength(2);

    const replaced = mergeTaskProposals({
      lock: { consumer, decisions: first.decisions },
      requests: [{ ...proposeLocale, proposed_value: ['ja'] }],
      agendas: [],
      now: LATER,
    });
    expect(taskProposalsOf(replaced)).toHaveLength(2);
    expect(taskProposalsOf(replaced)[0].value).toEqual(['ja']);

    const collected = replaced.decisions.map((entry) =>
      entry.proposal?.proposal_id === id
        ? { ...entry, agenda_id: 'agd-test0002', entry_id: id }
        : entry
    );
    const kept = mergeTaskProposals({
      lock: { consumer, decisions: collected },
      requests: [{ ...proposeLocale, proposed_value: ['en'] }],
      agendas: [],
      now: LATER,
    });
    expect(taskProposalsOf(kept)[0]).toMatchObject({ agenda_id: 'agd-test0002', value: ['ja'] });
  });

  it('links a question an open agenda already asks to that entry at once', () => {
    const merged = mergeTaskProposals({
      lock: empty,
      requests: [{ ...proposeLocale, item: 'NFR', key: 'auth.method', proposed_value: 'sso' }],
      agendas: [agenda(), agenda({ agenda_id: 'agd-closed01', status: 'closed' })],
      now: NOW,
    });
    expect(taskProposalsOf(merged)[0]).toMatchObject({
      agenda_id: 'agd-test0001',
      entry_id: 'nfr.auth',
      proposal: { collected_at: NOW },
    });
    expect(pendingTaskProposals(merged)).toEqual([]);
  });

  it('builds the agenda entry: our decision is the proposal; requires_customer carries none', () => {
    const merged = mergeTaskProposals({
      lock: empty,
      requests: [proposeLocale, askRelease],
      agendas: [],
      now: NOW,
    });
    const [locale, release] = taskProposalsOf(merged);
    expect(taskProposalAgendaEntry(locale)).toEqual({
      entry_id: locale.proposal.proposal_id,
      item: 'NFR',
      key: 'ui.locale',
      kind: 'choice',
      question: proposeLocale.question,
      options: proposeLocale.options,
      our_decision: { value: ['ja', 'en'], rationale: 'overseas branch' },
      requires_customer: false,
    });
    expect(taskProposalAgendaEntry(release)).toEqual({
      entry_id: release.proposal.proposal_id,
      item: 'RELEASE',
      key: 'release.go',
      kind: 'approval',
      question: askRelease.question,
      requires_customer: true,
    });
  });

  it('a proposal is stale only once collected and a different decided value is in force', () => {
    const sso = { ...proposeLocale, item: 'NFR', key: 'auth.method', proposed_value: 'sso' };
    const uncollected = mergeTaskProposals({ lock: empty, requests: [sso], agendas: [], now: NOW });
    const lockOf = (decisions: typeof uncollected.decisions) =>
      record({ case_id: 'case-a', consumer, locked_at: NOW, decisions });
    // Not on an agenda yet: not checked against anything.
    expect(
      reconcileConsumedDecisionLock(lockOf(uncollected.decisions), [agenda()], [], NOW).stale
    ).toEqual([]);
    const collected = mergeTaskProposals({
      lock: empty,
      requests: [sso],
      agendas: [agenda()],
      now: NOW,
    }).decisions;
    // Collected, the customer has not decided (org default only): not stale.
    const undecided = agenda({
      entries: [{ ...agenda().entries[0], org_default: undefined }],
    });
    expect(reconcileConsumedDecisionLock(lockOf(collected), [undecided], [], NOW).stale).toEqual(
      []
    );
    // The customer decided the same value: fresh; a different one: stale.
    const same = [customerDecision('D-0001', 'auth.method', 'NFR', 'sso')];
    expect(reconcileConsumedDecisionLock(lockOf(collected), [agenda()], same, NOW).stale).toEqual(
      []
    );
    const other = [customerDecision('D-0001', 'auth.method', 'NFR', 'password')];
    expect(
      reconcileConsumedDecisionLock(lockOf(collected), [agenda()], other, NOW).stale
    ).toMatchObject([{ agenda_id: 'agd-test0001', entry_id: 'nfr.auth', ref: 'D-0001' }]);
  });

  it('a hold resolves only on an operator-confirmed customer decision', () => {
    const releaseEntry = {
      entry_id: 'release',
      item: 'RELEASE',
      key: 'release.go',
      kind: 'approval' as const,
      question: 'May we release?',
      requires_customer: true,
    };
    const withRelease = (confirmed: boolean) =>
      agenda({
        entries: [releaseEntry],
        ...(confirmed
          ? {
              operator_confirmations: [
                { entry_id: 'release', decision_id: 'D-0001', by: 'user:boss', at: NOW },
              ],
            }
          : {}),
      });
    const lock = {
      decisions: mergeTaskProposals({
        lock: empty,
        requests: [askRelease],
        agendas: [withRelease(false)],
        now: NOW,
      }).decisions,
    };
    const id = taskProposalId(consumer, 'RELEASE', 'release.go');
    expect(taskProposalHolds(lock, [withRelease(false)], [], NOW)).toEqual([
      { proposal_id: id, collected: true },
    ]);
    const decided = [customerDecision('D-0001', 'release.go', 'RELEASE', { approved: true })];
    // Decided but provisional until the operator confirms it.
    expect(taskProposalHolds(lock, [withRelease(false)], decided, NOW)[0]).not.toHaveProperty(
      'resolved_decision_id'
    );
    expect(taskProposalHolds(lock, [withRelease(true)], decided, NOW)).toEqual([
      { proposal_id: id, collected: true, resolved_decision_id: 'D-0001' },
    ]);
  });

  it('stores task proposals through the lock schema', () => {
    const dir = pathResolver.sharedTmp(`consumption-proposals-${randomUUID()}`);
    safeMkdir(dir, { recursive: true });
    try {
      const merged = mergeTaskProposals({
        lock: empty,
        requests: [proposeLocale, askRelease],
        agendas: [],
        now: NOW,
      });
      const lock = record(
        { case_id: 'case-a', consumer, locked_at: NOW, decisions: merged.decisions },
        { hold: { work_item_id: 'WI-1', at: NOW } }
      );
      writeConsumedDecisionLock({ dir }, lock);
      expect(readConsumedDecisionLock({ dir }, consumer)).toEqual(lock);
      // A task_proposal entry must carry its proposal, and only it may.
      const broken = {
        ...lock,
        decisions: [{ item: 'NFR', key: 'ui.locale', layer: 'task_proposal' as const }],
      };
      expect(() => writeConsumedDecisionLock({ dir }, broken)).toThrow();
    } finally {
      safeRmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CD-09 review fixes', () => {
  const consumer = 'mission-MSN-CD09.impl';
  const empty = { consumer, decisions: [] };

  it('a requires_customer question never links to an entry our decision could settle; the reverse links', () => {
    const asksAuth = (requires: boolean) => ({
      question: 'Which sign-in method?',
      item: 'NFR',
      key: 'auth.method',
      requires_customer: requires,
      ...(requires ? {} : { proposed_value: 'sso' }),
    });
    // agenda(): nfr.auth is not requires_customer.
    const strict = mergeTaskProposals({
      lock: empty,
      requests: [asksAuth(true)],
      agendas: [agenda()],
      now: NOW,
    });
    expect(pendingTaskProposals(strict)).toHaveLength(1);
    const requiresAgenda = agenda({
      entries: [{ ...agenda().entries[0], org_default: undefined, requires_customer: true }],
    });
    for (const requires of [true, false]) {
      const linked = mergeTaskProposals({
        lock: empty,
        requests: [asksAuth(requires)],
        agendas: [requiresAgenda],
        now: NOW,
      });
      expect(taskProposalsOf(linked)[0]).toMatchObject({
        agenda_id: 'agd-test0001',
        entry_id: 'nfr.auth',
      });
    }
  });

  it('a ref without a ledger id carries a value hash: A → B → C are three refs, no value spelled out', () => {
    const refOf = (value: unknown) =>
      currentDecisionRef('agd-test0001', 'nfr.auth', { layer: 'ours', value });
    const refs = [refOf('A-secret'), refOf('B-secret'), refOf('C-secret')];
    expect(new Set(refs).size).toBe(3);
    expect(refs[0]).toMatch(/^agd-test0001\/nfr\.auth:ours:[a-f0-9]{12}$/u);
    expect(refs.join(' ')).not.toMatch(/secret/u);
    expect(refOf({ b: 1, a: 2 })).toBe(refOf({ a: 2, b: 1 }));
    expect(currentDecisionRef('agd-test0001', 'nfr.auth', { layer: 'none' })).toBe(
      'agd-test0001/nfr.auth:none'
    );
    expect(
      currentDecisionRef('agd-test0001', 'nfr.auth', {
        layer: 'customer',
        decision_id: 'D-0002',
        value: 'x',
      })
    ).toBe('D-0002');
  });

  it('requires_customer is sticky per item × key for the task, in either order and across results', () => {
    const ask = (requires: boolean) => ({
      question: 'Ship it?',
      item: 'RELEASE',
      key: 'release.go',
      requires_customer: requires,
      ...(requires ? {} : { proposed_value: 'yes' }),
    });
    for (const order of [
      [ask(true), ask(false)],
      [ask(false), ask(true)],
    ]) {
      const merged = mergeTaskProposals({ lock: empty, requests: order, agendas: [], now: NOW });
      expect(taskProposalsOf(merged)).toHaveLength(1);
      expect(taskProposalsOf(merged)[0].proposal.requires_customer).toBe(true);
      expect(taskProposalsOf(merged)[0]).not.toHaveProperty('value');
    }
    const first = mergeTaskProposals({ lock: empty, requests: [ask(true)], agendas: [], now: NOW });
    const later = mergeTaskProposals({
      lock: { consumer, decisions: first.decisions },
      requests: [ask(false)],
      agendas: [],
      now: LATER,
    });
    expect(taskProposalsOf(later)[0].proposal.requires_customer).toBe(true);
    expect(taskProposalsOf(later)[0]).not.toHaveProperty('value');
  });
});

describe('resolvedTaskProposalDecisions (CD-09 values for resumed tasks)', () => {
  const consumer = 'mission-MSN-CD09.impl';
  const empty = { consumer, decisions: [] };
  const choiceEntry = {
    entry_id: 'release',
    item: 'RELEASE',
    key: 'release.date',
    kind: 'choice' as const,
    question: 'Which release date?',
    options: [
      { value: 'date-alpha-sentinel', label: 'Alpha date' },
      { value: 'date-beta-sentinel', label: 'Beta date' },
    ],
    requires_customer: true,
  };
  const askRelease = {
    question: 'Which release date?',
    item: 'RELEASE',
    key: 'release.date',
    requires_customer: true,
  };
  // An agent proposal on an entry of the same agenda (not requires_customer).
  const proposeAuth = {
    question: 'Which sign-in method?',
    item: 'NFR',
    key: 'auth.method',
    proposed_value: 'sso',
    requires_customer: false,
  };
  const confirmations = (...ids: string[]) =>
    ids.map((id) => ({ entry_id: 'release', decision_id: id, by: 'user:boss', at: NOW }));
  const withRelease = (confirmed: string[]) =>
    agenda({
      entries: [...agenda().entries, choiceEntry],
      ...(confirmed.length ? { operator_confirmations: confirmations(...confirmed) } : {}),
    });
  const lockFor = (agendas: DecisionAgenda[]) => ({
    decisions: mergeTaskProposals({
      lock: empty,
      requests: [askRelease, proposeAuth],
      agendas,
      now: NOW,
    }).decisions,
  });

  it("returns only the task's own resolved requires_customer proposals", () => {
    const agendas = [withRelease(['D-0001'])];
    const ledger = [
      customerDecision('D-0001', 'release.date', 'RELEASE', 'date-alpha-sentinel'),
      // The customer also decided the agent-proposed entry: never delivered.
      customerDecision('D-0002', 'auth.method', 'NFR', 'password'),
    ];
    const resolved = resolvedTaskProposalDecisions(lockFor(agendas), agendas, ledger, NOW);
    expect(resolved).toEqual([
      {
        proposal_id: taskProposalId(consumer, 'RELEASE', 'release.date'),
        agenda_id: 'agd-test0001',
        entry_id: 'release',
        item: 'RELEASE',
        key: 'release.date',
        question: 'Which release date?',
        decision_id: 'D-0001',
        value: 'date-alpha-sentinel',
        option_label: 'Alpha date',
      },
    ]);
    // Another task's lock (a different consumer, no proposals of its own) gets nothing.
    expect(resolvedTaskProposalDecisions({ decisions: [] }, agendas, ledger, NOW)).toEqual([]);
    // An uncollected proposal (no agenda entry yet) gets nothing.
    const uncollected = {
      decisions: mergeTaskProposals({ lock: empty, requests: [askRelease], agendas: [], now: NOW })
        .decisions,
    };
    expect(resolvedTaskProposalDecisions(uncollected, agendas, ledger, NOW)).toEqual([]);
  });

  it('a superseded decision yields the one in force; one awaiting confirmation is excluded', () => {
    const first = customerDecision('D-0001', 'release.date', 'RELEASE', 'date-alpha-sentinel');
    const second = customerDecision('D-0002', 'release.date', 'RELEASE', 'date-beta-sentinel');
    const superseded = [{ ...first, status: 'superseded' as const }, second];
    const confirmedBoth = [withRelease(['D-0001', 'D-0002'])];
    expect(
      resolvedTaskProposalDecisions(lockFor(confirmedBoth), confirmedBoth, superseded, NOW)
    ).toEqual([
      expect.objectContaining({
        decision_id: 'D-0002',
        value: 'date-beta-sentinel',
        option_label: 'Beta date',
      }),
    ]);
    // The newer customer decision is not confirmed yet: nothing, not the old value.
    const confirmedFirst = [withRelease(['D-0001'])];
    expect(
      resolvedTaskProposalDecisions(lockFor(confirmedFirst), confirmedFirst, superseded, NOW)
    ).toEqual([]);
    // Decided but never confirmed: nothing.
    const unconfirmed = [withRelease([])];
    expect(resolvedTaskProposalDecisions(lockFor(unconfirmed), unconfirmed, [first], NOW)).toEqual(
      []
    );
  });

  it('a released hold re-opens once the decision in force is no longer confirmed', () => {
    const agendas = [withRelease(['D-0001'])];
    const first = customerDecision('D-0001', 'release.date', 'RELEASE', 'date-alpha-sentinel');
    const id = taskProposalId(consumer, 'RELEASE', 'release.date');
    // Released on D-0001: the proposal carries the stamp.
    const stamped = {
      decisions: lockFor(agendas).decisions.map((entry) =>
        entry.proposal?.proposal_id === id
          ? {
              ...entry,
              proposal: { ...entry.proposal, resolved: { decision_id: 'D-0001', at: NOW } },
            }
          : entry
      ),
    };
    expect(taskProposalHolds(stamped, agendas, [first], NOW)).toEqual([
      { proposal_id: id, collected: true, resolved_decision_id: 'D-0001' },
    ]);
    // The customer changed the answer: D-0002 awaits the operator's confirmation.
    const changed = [
      { ...first, status: 'superseded' as const },
      customerDecision('D-0002', 'release.date', 'RELEASE', 'date-beta-sentinel'),
    ];
    expect(taskProposalHolds(stamped, agendas, changed, NOW)).toEqual([
      { proposal_id: id, collected: true },
    ]);
    expect(resolvedTaskProposalDecisions(stamped, agendas, changed, NOW)).toEqual([]);
    // The agenda is closed (or withdrawn, or gone) before the operator
    // confirmed D-0002: D-0001 was superseded, so it is never delivered as
    // confirmed — unresolvable.
    for (const agendasNow of [
      [{ ...agendas[0], status: 'closed' as const }],
      [{ ...agendas[0], status: 'withdrawn' as const }],
      [],
    ]) {
      expect(taskProposalHolds(stamped, agendasNow, changed, NOW)).toEqual([
        { proposal_id: id, collected: true, unresolvable: true },
      ]);
      expect(resolvedTaskProposalDecisions(stamped, agendasNow, changed, NOW)).toEqual([]);
    }
    // Superseded by a later record but still marked active (a ledger written
    // before the mark): the supersedes link alone is enough.
    const linked = [
      first,
      {
        ...customerDecision('D-0002', 'release.date', 'RELEASE', 'date-beta-sentinel'),
        supersedes: 'D-0001',
      },
    ];
    expect(taskProposalHolds(stamped, [], linked, NOW)).toEqual([
      { proposal_id: id, collected: true, unresolvable: true },
    ]);
    // The agenda is gone and the released decision still stands: delivered.
    expect(taskProposalHolds(stamped, [], [first], NOW)).toEqual([
      { proposal_id: id, collected: true, resolved_decision_id: 'D-0001' },
    ]);
    expect(resolvedTaskProposalDecisions(stamped, [], [first], NOW)).toMatchObject([
      { decision_id: 'D-0001', value: 'date-alpha-sentinel' },
    ]);
    // No confirmed decision is left (never released, or the ledger lost it):
    // unresolvable — held for good, never released.
    const closed = [{ ...agendas[0], status: 'closed' as const }];
    const unstamped = lockFor(agendas);
    expect(taskProposalHolds(unstamped, closed, changed, NOW)).toEqual([
      { proposal_id: id, collected: true, unresolvable: true },
    ]);
    expect(taskProposalHolds(stamped, [], [], NOW)).toEqual([
      { proposal_id: id, collected: true, unresolvable: true },
    ]);
    expect(resolvedTaskProposalDecisions(stamped, [], [], NOW)).toEqual([]);
  });

  it('a lock that completed once trusts its release: a later change is not a new hold', () => {
    const agendas = [withRelease(['D-0001'])];
    const id = taskProposalId(consumer, 'RELEASE', 'release.date');
    const first = customerDecision('D-0001', 'release.date', 'RELEASE', 'date-alpha-sentinel');
    const stamped = lockFor(agendas).decisions.map((entry) =>
      entry.proposal?.proposal_id === id
        ? {
            ...entry,
            proposal: { ...entry.proposal, resolved: { decision_id: 'D-0001', at: NOW } },
          }
        : entry
    );
    const changed = [
      { ...first, status: 'superseded' as const },
      customerDecision('D-0002', 'release.date', 'RELEASE', 'date-beta-sentinel'),
    ];
    for (const lock of [
      { decisions: stamped, status: 'completed' as const, completed_at: NOW },
      // Re-pinned for a new run after completion: still completed once.
      { decisions: stamped, status: 'in_progress' as const, completed_at: NOW },
    ]) {
      expect(taskProposalHolds(lock, agendas, changed, NOW)).toEqual([
        { proposal_id: id, collected: true, resolved_decision_id: 'D-0001' },
      ]);
      // Not re-held, but the superseded value is never delivered: the task is told.
      expect(resolvedTaskProposalDecisions(lock, agendas, changed, NOW)).toEqual([]);
      expect(unconfirmedTaskProposals(lock, agendas, changed, NOW)).toEqual([
        { proposal_id: id, reason: 'changed_after_completion' },
      ]);
      // The ledger lost the released decision: the same, with its own reason.
      expect(unconfirmedTaskProposals(lock, agendas, [], NOW)).toEqual([
        { proposal_id: id, reason: 'decision_not_recorded' },
      ]);
      // Still standing: delivered, nothing to say.
      expect(resolvedTaskProposalDecisions(lock, agendas, [first], NOW)).toMatchObject([
        { decision_id: 'D-0001', value: 'date-alpha-sentinel' },
      ]);
      expect(unconfirmedTaskProposals(lock, agendas, [first], NOW)).toEqual([]);
    }
    // Never completed: the change re-opens the hold.
    expect(
      taskProposalHolds({ decisions: stamped, status: 'in_progress' }, agendas, changed, NOW)
    ).toEqual([{ proposal_id: id, collected: true }]);
  });

  it('holds and the resolver read the same entry when the lock has no entry id', () => {
    const agendas = [withRelease(['D-0001'])].map((item) => ({
      ...item,
      entries: item.entries.map((entry) =>
        entry.entry_id === 'release'
          ? { ...entry, entry_id: taskProposalId(consumer, 'RELEASE', 'release.date') }
          : entry
      ),
      operator_confirmations: [
        {
          entry_id: taskProposalId(consumer, 'RELEASE', 'release.date'),
          decision_id: 'D-0001',
          by: 'user:boss',
          at: NOW,
        },
      ],
    }));
    const lock = {
      decisions: lockFor(agendas).decisions.map((entry) => {
        if (entry.layer !== 'task_proposal' || !entry.proposal?.requires_customer) return entry;
        const { entry_id: _dropped, ...rest } = entry;
        return rest;
      }),
    };
    const ledger = [customerDecision('D-0001', 'release.date', 'RELEASE', 'date-alpha-sentinel')];
    expect(taskProposalHolds(lock, agendas, ledger, NOW)[0]).toMatchObject({
      resolved_decision_id: 'D-0001',
    });
    expect(resolvedTaskProposalDecisions(lock, agendas, ledger, NOW)).toMatchObject([
      { decision_id: 'D-0001' },
    ]);
  });
});
