import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeAppendFileSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { agendaContentHash } from './hash.js';
import type { DecisionAgenda, DecisionReceipt, DecisionSwitch } from './model.js';
import { AGENDA_ID_PATTERN, RECEIPT_ID_PATTERN, SWITCH_ID_PATTERN } from './model.js';
import {
  appendSwitches,
  customerDecisionCaseLockId,
  customerDecisionPaths,
  listAgendas,
  listReceipts,
  listRespondJournals,
  removeRespondJournal,
  withCustomerActorsLock,
  withCustomerDecisionCaseLock,
  writeRespondJournal,
  type RespondJournalRecord,
  newAgendaId,
  newReceiptId,
  newSwitchId,
  readAgenda,
  readReceipt,
  readSwitches,
  writeAgenda,
  writeReceipt,
} from './store.js';

const NOW = '2026-10-24T00:00:00.000Z';

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
        options: [
          { value: 'password', label: 'Password' },
          { value: 'sso', label: 'SSO', impact: { cost: '+10%', schedule: '+3d' } },
        ],
        our_decision: { value: 'sso', rationale: 'enterprise', decision_id: 'D-0001' },
        org_default: { value: 'password', source: 'hearing:aidlc_inception' },
        requires_customer: false,
        override_until: { kind: 'milestone', milestone: 'bolt-1-start' },
      },
      {
        entry_id: 'release',
        item: 'RELEASE',
        key: 'release.go',
        kind: 'approval',
        question: 'Release to production?',
        requires_customer: true,
      },
    ],
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function receipt(overrides: Partial<DecisionReceipt> = {}): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: 'rcp-test0001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: 'agd-test0001',
    agenda_revision: 1,
    content_hash: agendaContentHash(agenda()),
    invite_id: 'inv-0123456789abcdef',
    participant: { name: 'Hanako', role: 'decider', actor_id: 'customer:acme-cto' },
    answers: [
      { entry_id: 'nfr.auth', choice: 'keep' },
      { entry_id: 'release', choice: 'approve', comment: 'ok' },
    ],
    identity_assurance: 'invite_link',
    submitted_at: NOW,
    decision_ids: ['D-0002'],
    ...overrides,
  };
}

function switchEvent(overrides: Partial<DecisionSwitch> = {}): DecisionSwitch {
  return {
    version: '1.0.0',
    switch_id: 'sw-test0001',
    case_id: 'case-a',
    agenda_id: 'agd-test0001',
    entry_id: 'nfr.auth',
    item: 'NFR',
    key: 'auth.method',
    kind: 'value_changed',
    from: { layer: 'ours', value: 'sso', decision_id: 'D-0001' },
    to: { layer: 'customer', value: 'password', decision_id: 'D-0002' },
    at: NOW,
    cause_receipt_id: 'rcp-test0001',
    ...overrides,
  };
}

describe('customer decision store', () => {
  let dir: string;
  beforeEach(() => {
    // Uniquely named fixture under the shared tmp floor (dev practices §3).
    dir = pathResolver.sharedTmp(`customer-decision-test-${randomUUID()}`);
  });
  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('lays files out under the SSOD case directory of the tenant', () => {
    const paths = customerDecisionPaths({ tenantSlug: 'acme-corp', caseId: 'case-a' });
    expect(paths.dir).toContain('knowledge/confidential/acme-corp/decisions/case-a');
    expect(paths.agendas.endsWith(path.join('case-a', 'agendas'))).toBe(true);
    expect(paths.receipts.endsWith(path.join('case-a', 'receipts'))).toBe(true);
    expect(paths.switches.endsWith(path.join('case-a', 'switches.jsonl'))).toBe(true);
    expect(() => customerDecisionPaths({ tenantSlug: 'personal', caseId: 'case-a' })).toThrow(
      /DECISION_LEDGER_TENANT_INVALID/u
    );
    expect(() => customerDecisionPaths({ tenantSlug: 'acme-corp', caseId: '../x' })).toThrow(
      /DECISION_LEDGER_CASE_INVALID/u
    );
  });

  it('round-trips agendas and lists them', () => {
    const location = { dir };
    expect(readAgenda(location, 'agd-test0001')).toBeUndefined();
    expect(listAgendas(location)).toEqual([]);
    writeAgenda(location, agenda());
    writeAgenda(location, agenda({ agenda_id: 'agd-test0002', title: 'Bolt 1 review' }));
    expect(readAgenda(location, 'agd-test0001')).toEqual(agenda());
    expect(listAgendas(location).map((a) => a.agenda_id)).toEqual(['agd-test0001', 'agd-test0002']);
    const approved = agenda({
      status: 'approved',
      revision: 2,
      approval: {
        content_hash: agendaContentHash(agenda()),
        approved_at: NOW,
        approved_by: 'user:bob',
      },
    });
    writeAgenda(location, approved);
    expect(readAgenda(location, 'agd-test0001')).toEqual(approved);
  });

  it('refuses invalid agendas and unsafe ids', () => {
    const location = { dir };
    expect(() => writeAgenda(location, agenda({ status: 'approved' }))).toThrow(/approval/u);
    expect(() =>
      writeAgenda(
        location,
        agenda({
          entries: [
            {
              entry_id: 'contract',
              item: 'CONTRACT',
              key: 'contract.amount',
              kind: 'approval',
              question: 'Amount?',
              requires_customer: true,
              our_decision: { value: 100 },
            },
          ],
        })
      )
    ).toThrow(/Invalid catalog/u);
    expect(() => writeAgenda(location, agenda({ agenda_id: '../escape' }))).toThrow(
      /Invalid catalog|AGENDA_ID_INVALID/u
    );
    expect(() => readAgenda(location, '../escape')).toThrow(/AGENDA_ID_INVALID/u);
  });

  it('refuses records that belong to another tenant or case', () => {
    const location = { tenantSlug: 'acme-corp', caseId: 'case-b' };
    expect(() => writeAgenda(location, agenda())).toThrow(/CASE_MISMATCH/u);
    expect(() => writeAgenda({ tenantSlug: 'other-co', caseId: 'case-a' }, agenda())).toThrow(
      /TENANT_MISMATCH/u
    );
    expect(() => writeReceipt(location, receipt())).toThrow(/CASE_MISMATCH/u);
    expect(() => appendSwitches(location, [switchEvent()])).toThrow(/CASE_MISMATCH/u);
  });

  it('writes receipts once and refuses to overwrite them', () => {
    const location = { dir };
    writeReceipt(location, receipt());
    expect(readReceipt(location, 'rcp-test0001')).toEqual(receipt());
    expect(() => writeReceipt(location, receipt({ decision_ids: [] }))).toThrow(/RECEIPT_EXISTS/u);
    writeReceipt(
      location,
      receipt({
        receipt_id: 'rcp-test0002',
        agenda_id: 'agd-test0002',
        submitted_at: '2026-10-25T00:00:00.000Z',
      })
    );
    expect(listReceipts(location).map((r) => r.receipt_id)).toEqual([
      'rcp-test0001',
      'rcp-test0002',
    ]);
    expect(listReceipts(location, { agendaId: 'agd-test0002' }).map((r) => r.receipt_id)).toEqual([
      'rcp-test0002',
    ]);
  });

  it('requires a value for option answers and the invite_link assurance', () => {
    const location = { dir };
    expect(() =>
      writeReceipt(location, receipt({ answers: [{ entry_id: 'nfr.auth', choice: 'option' }] }))
    ).toThrow(/Invalid catalog/u);
    expect(() =>
      writeReceipt(
        location,
        receipt({
          identity_assurance: 'passkey' as unknown as DecisionReceipt['identity_assurance'],
        })
      )
    ).toThrow(/Invalid catalog/u);
  });

  it('appends switches and skips corrupt lines on read', () => {
    const location = { dir };
    expect(readSwitches(location)).toEqual([]);
    expect(appendSwitches(location, [])).toEqual([]);
    appendSwitches(location, [switchEvent()]);
    safeAppendFileSync(customerDecisionPaths(location).switches, '{not json\n');
    appendSwitches(location, [
      switchEvent({ switch_id: 'sw-test0002', agenda_id: 'agd-test0002', kind: 'confirmed' }),
    ]);
    expect(readSwitches(location).map((s) => s.switch_id)).toEqual(['sw-test0001', 'sw-test0002']);
    expect(readSwitches(location, { agendaId: 'agd-test0002' }).map((s) => s.kind)).toEqual([
      'confirmed',
    ]);
    expect(() => appendSwitches(location, [switchEvent({ switch_id: 'bad' })])).toThrow(
      /Invalid catalog/u
    );
  });

  it('refuses explicit layer orders without the customer layer', () => {
    const base = agenda();
    const withLayers = (layers: string[]) =>
      agenda({
        entries: [{ ...base.entries[0], layers: layers as never }, base.entries[1]],
      });
    expect(() => writeAgenda({ dir }, withLayers(['ours', 'org_default']))).toThrow(/layers/u);
    expect(writeAgenda({ dir }, withLayers(['customer', 'ours'])).entries[0].layers).toEqual([
      'customer',
      'ours',
    ]);
  });

  it('keeps operator confirmations on the agenda, outside the content hash', () => {
    const confirmed = agenda({
      operator_confirmations: [
        { entry_id: 'release', decision_id: 'D-0002', by: 'user:alice', at: NOW },
      ],
    });
    expect(writeAgenda({ dir }, confirmed).operator_confirmations).toHaveLength(1);
    expect(agendaContentHash(confirmed)).toBe(agendaContentHash(agenda()));
    expect(() =>
      writeAgenda(
        { dir },
        agenda({
          operator_confirmations: [
            { entry_id: 'release', decision_id: 'nope', by: 'user:alice', at: NOW },
          ],
        })
      )
    ).toThrow(/decision_id/u);
  });

  it('locks a case across callers: tenant + case, or a hash of the test dir', () => {
    expect(customerDecisionCaseLockId({ tenantSlug: 'acme-corp', caseId: 'case-a' })).toBe(
      'customer-decision-case-acme-corp-case-a'
    );
    expect(customerDecisionCaseLockId({ dir })).toMatch(
      /^customer-decision-case-dir-[a-f0-9]{24}$/u
    );
    expect(() => customerDecisionCaseLockId({ tenantSlug: 'acme-corp', caseId: '../x' })).toThrow(
      /CASE_INVALID/u
    );
    // While one holder runs, the same case cannot be entered (not re-entrant, no queue jumping).
    const inner = withCustomerDecisionCaseLock({ dir }, () => {
      try {
        withCustomerDecisionCaseLock({ dir }, () => 'second', 150);
        return 'entered';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(inner).toMatch(/LOCK_TIMEOUT/u);
    // Released afterwards; another case was never blocked.
    expect(withCustomerDecisionCaseLock({ dir }, () => 'again')).toBe('again');
  });

  it('serializes a customer actor registry shared by all of its cases', () => {
    const inner = withCustomerActorsLock('acme-corp', 'acme', () => {
      try {
        withCustomerActorsLock('acme-corp', 'acme', () => 'second', 150);
        return 'entered';
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(inner).toMatch(/LOCK_TIMEOUT/u);
    expect(withCustomerActorsLock('acme-corp', 'other', () => 'other customer')).toBe(
      'other customer'
    );
    expect(() => withCustomerActorsLock('acme-corp', '../x', () => 'never')).toThrow(
      /ACTORS_LOCK_INVALID/u
    );
  });

  it('writes, advances, lists and removes respond journal records', () => {
    const location = { dir };
    const record: RespondJournalRecord = {
      version: '1.0.0',
      receipt_id: 'rcp-test0001',
      tenant_slug: 'acme-corp',
      case_id: 'case-a',
      agenda_id: 'agd-test0001',
      stage: 'planned',
      receipt: receipt(),
      before: [],
      created_at: NOW,
      updated_at: NOW,
    };
    expect(listRespondJournals(location)).toEqual([]);
    writeRespondJournal(location, record);
    writeRespondJournal(location, { ...record, stage: 'ledger_written' });
    expect(listRespondJournals(location)).toEqual([{ ...record, stage: 'ledger_written' }]);
    expect(() =>
      writeRespondJournal(location, { ...record, receipt: receipt({ receipt_id: 'rcp-test0002' }) })
    ).toThrow(/JOURNAL_MISMATCH/u);
    expect(() =>
      writeRespondJournal(location, { ...record, receipt: { ...receipt(), answers: 'x' as never } })
    ).toThrow();
    // A record that cannot be read is reported, never silently dropped or deleted.
    const broken = path.join(customerDecisionPaths(location).respondJournal, 'rcp-test0009.json');
    safeMkdir(path.dirname(broken), { recursive: true });
    safeWriteFile(broken, '{"version":"1.0.0"}', { encoding: 'utf8' });
    const invalid: string[] = [];
    expect(listRespondJournals(location, (id) => invalid.push(id))).toHaveLength(1);
    expect(invalid).toEqual(['rcp-test0009']);
    removeRespondJournal(location, 'rcp-test0001');
    removeRespondJournal(location, 'rcp-test0001');
    expect(listRespondJournals(location)).toEqual([]);
  });

  it('generates ids that match the grammar', () => {
    expect(newAgendaId()).toMatch(AGENDA_ID_PATTERN);
    expect(newReceiptId()).toMatch(RECEIPT_ID_PATTERN);
    expect(newSwitchId()).toMatch(SWITCH_ID_PATTERN);
    expect(newAgendaId()).not.toBe(newAgendaId());
  });
});
