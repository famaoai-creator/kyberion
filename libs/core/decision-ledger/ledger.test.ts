import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import {
  DecisionLedgerError,
  appendDecisions,
  applyPromotions,
  customerActorsPath,
  ledgerDir,
  nextDecisionId,
  readCustomerActors,
  readLedger,
  readObserved,
  validateAppend,
  writeConformance,
  writeCustomerActors,
  writeObserved,
  writeProductConcept,
  type DecisionAppendInput,
} from './ledger.js';
import { buildLock, checkConformance } from './conformance.js';
import { hearingAnswersToProductConcept } from './product-concept.js';

const NOW = '2026-09-14T00:00:00.000Z';
const owner = { kind: 'human' as const, id: 'user:alice', role: 'owner' as const };

function proposal(overrides: Partial<DecisionAppendInput> = {}): DecisionAppendInput {
  return {
    item: 'SCR-1#B35',
    key: 'csv.columns',
    level: 'product-fixed',
    state: 'proposed',
    value: null,
    basis: [],
    origin: 'observation',
    ...overrides,
  };
}

describe('decision ledger', () => {
  let dir: string;
  beforeEach(() => {
    // Uniquely named fixture under the shared tmp floor (dev practices §3):
    // never a fixed name, removed in teardown.
    dir = pathResolver.sharedTmp(`decision-ledger-test-${randomUUID()}`);
  });
  afterEach(() => {
    safeRmSync(dir, { recursive: true, force: true });
  });

  it('keeps tenant ledgers inside the tenant and refuses reserved or unsafe names', () => {
    expect(ledgerDir({ tenantSlug: 'acme-corp', caseId: 'case-a' })).toContain(
      'knowledge/confidential/acme-corp/decisions/case-a'
    );
    expect(() => ledgerDir({ tenantSlug: 'personal', caseId: 'case-a' })).toThrow(
      /DECISION_LEDGER_TENANT_INVALID/u
    );
    expect(() => ledgerDir({ tenantSlug: 'acme-corp', caseId: '../x' })).toThrow(
      /DECISION_LEDGER_CASE_INVALID/u
    );
    expect(customerActorsPath('acme-corp', 'bank-a')).toContain(
      'knowledge/confidential/acme-corp/customers/bank-a/actors.json'
    );
    expect(() => customerActorsPath('acme-corp', 'Bank A')).toThrow(
      /DECISION_LEDGER_CUSTOMER_INVALID/u
    );
  });

  it('appends with sequential ids and supersedes the previous active record for the same item/key', () => {
    const first = appendDecisions({ dir }, [proposal()], { caseId: 'case-a' });
    expect(first.appended[0].id).toBe('D-0001');
    expect(first.appended[0].case_id).toBe('case-a');
    const second = appendDecisions(
      { dir },
      [
        proposal({
          state: 'decided',
          value: ['a'],
          basis: [{ ref: 'QA-1', version: 'r1' }],
          decided_by: owner,
          decided_at: NOW,
          supersedes: 'D-0001',
        }),
      ],
      { caseId: 'case-a' }
    );
    expect(second.appended[0].id).toBe('D-0002');
    expect(second.superseded).toEqual(['D-0001']);
    const ledger = readLedger({ dir });
    expect(ledger.map((d) => [d.id, d.status])).toEqual([
      ['D-0001', 'superseded'],
      ['D-0002', 'active'],
    ]);
    expect(nextDecisionId(ledger)).toBe('D-0003');
  });

  it('refuses the four PoC refusals with stable codes and writes nothing', () => {
    appendDecisions({ dir }, [proposal()], { caseId: 'case-a' });
    const existing = readLedger({ dir });
    expect(validateAppend(existing, proposal())).toEqual(['supersedes_required']);
    expect(validateAppend(existing, proposal({ supersedes: 'D-0099' }))).toEqual([
      'supersedes_not_active',
    ]);
    expect(validateAppend(existing, proposal({ state: 'decided', supersedes: 'D-0001' }))).toEqual([
      'basis_required',
      'decided_by_human_required',
    ]);
    expect(
      validateAppend(existing, proposal({ level: 'bank-value' as never, key: 'other.key' }))
    ).toEqual(['level_invalid']);
    expect(() => appendDecisions({ dir }, [proposal()], { caseId: 'case-a' })).toThrow(
      DecisionLedgerError
    );
    expect(readLedger({ dir })).toHaveLength(1);
  });

  it('dry-run validates and assigns ids but leaves the file untouched', () => {
    const result = appendDecisions({ dir }, [proposal()], { caseId: 'case-a', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.appended[0].id).toBe('D-0001');
    expect(readLedger({ dir })).toEqual([]);
  });

  it('applies hearing promotions: owner decides a product value, a customer value waits for evidence', () => {
    appendDecisions(
      { dir },
      [
        proposal(),
        proposal({ item: 'SCR-2#B5', key: 'balance.kind', level: 'customer-value' }),
        proposal({ item: 'SCR-1#B9', key: 'filter.options', level: 'product-axis', options: [] }),
      ],
      { caseId: 'case-a' }
    );
    writeCustomerActors(
      { dir },
      {
        version: '1.0.0',
        tenant_slug: 'acme-corp',
        customer: 'bank-a',
        actors: [
          {
            id: 'customer:bank-a',
            name: 'Bank A',
            decides: ['customer-value'],
            confirm_target: 'CT-bank-a',
          },
        ],
      }
    );
    const basis = [{ ref: 'hearing:s-1', version: 'turn:t-1' }];
    const outcome = applyPromotions(
      { dir },
      [
        {
          promote: 'D-0001',
          value: ['a', 'b'],
          decided_by: owner,
          basis,
          origin: 'hearing',
          source_turn: 't-1',
        },
        {
          promote: 'D-0002',
          value: 'previous-day',
          decided_by: { ...owner, on_behalf_of: { actor_id: 'customer:bank-a' } },
          basis,
          origin: 'hearing',
        },
        { promote: 'D-0003', value: 'x', decided_by: owner, basis, origin: 'hearing' },
        { promote: 'D-0404', value: 'x', decided_by: owner, basis, origin: 'hearing' },
      ],
      { now: NOW, customerActors: readCustomerActors({ dir }) }
    );
    expect(outcome.results.map((r) => [r.promote, r.result.outcome])).toEqual([
      ['D-0001', 'decided'],
      ['D-0002', 'proposed'],
      ['D-0003', 'proposed'],
      ['D-0404', 'skipped'],
    ]);
    expect(outcome.results[1].result).toMatchObject({
      reason: 'customer_approval_required',
      ask: 'CT-bank-a',
    });
    expect(outcome.results[2].result).toMatchObject({ reason: 'axis_without_options' });
    const ledger = readLedger({ dir });
    const active = ledger.filter((d) => d.status === 'active');
    expect(active.map((d) => [d.key, d.state, d.supersedes])).toEqual([
      ['csv.columns', 'decided', 'D-0001'],
      ['balance.kind', 'proposed', 'D-0002'],
      ['filter.options', 'proposed', 'D-0003'],
    ]);
    expect(active[0].decided_at).toBe(NOW);
    expect(active[0].source_turn).toBe('t-1');
    expect(active[1].pending_reason).toBe('customer_approval_required');
    // a second promotion of an already decided record is skipped, not duplicated
    const again = applyPromotions(
      { dir },
      [{ promote: active[0].id, value: ['z'], decided_by: owner, basis, origin: 'hearing' }],
      { now: NOW }
    );
    expect(again.results[0].result).toEqual({ outcome: 'skipped', reason: 'already_decided' });
  });

  it('stores observations, report and lock next to the ledger', () => {
    appendDecisions(
      { dir },
      [
        proposal({
          state: 'decided',
          value: ['a'],
          basis: [{ ref: 'QA-1', version: 'r1' }],
          decided_by: owner,
          decided_at: NOW,
        }),
      ],
      { caseId: 'case-a' }
    );
    writeObserved(
      { dir },
      {
        case_id: 'case-a',
        impl: { repo: 'impl', commit: 'abc' },
        observed_at: NOW,
        observations: [{ key: 'csv.columns', value: ['a', 'b'], ref: 'csv.ts:1' }],
      }
    );
    const decisions = readLedger({ dir });
    const report = checkConformance(decisions, readObserved({ dir }), { now: NOW });
    expect(report.status).toBe('red');
    writeConformance({ dir }, report, buildLock(decisions, report));
    const lockText = String(safeReadFile(`${dir}/lock.json`, { encoding: 'utf8' }));
    expect(JSON.parse(lockText)).toMatchObject({
      version: '1.0.0',
      status: 'red',
      impl: { commit: 'abc' },
    });
  });

  it('writes a product concept under concepts/', () => {
    const concept = hearingAnswersToProductConcept(
      [
        { id: 'audience', answer: 'staff' },
        { id: 'problem', answer: 'p' },
        { id: 'success', answer: 's' },
      ],
      {
        sessionId: 'sess-9',
        scenario: 'web_app_build',
        recordedBy: { kind: 'human', id: 'user:alice' },
        now: NOW,
      }
    );
    const file = writeProductConcept({ dir }, concept);
    expect(file).toContain('/concepts/PC-sess-9.json');
  });
});
