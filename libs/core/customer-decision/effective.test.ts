import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import { agendaContentHash } from './hash.js';
import {
  approvedOurDecisionIds,
  checkDecisionFreshness,
  checkLayerPrecedence,
  detectSwitches,
  isOverrideWindowOpen,
  resolveAgendaEffective,
  resolveEffectiveDecision,
} from './effective.js';
import type {
  AgendaEntry,
  ConsumedDecisionLock,
  DecisionAgenda,
  EffectiveDecision,
} from './model.js';

const NOW = '2026-10-24T00:00:00.000Z';
const ITEM = 'NFR';
const KEY = 'auth.method';

function entry(overrides: Partial<AgendaEntry> = {}): AgendaEntry {
  return {
    entry_id: 'e1',
    item: ITEM,
    key: KEY,
    kind: 'choice',
    question: 'Which sign-in method?',
    options: [
      { value: 'password', label: 'Password' },
      { value: 'sso', label: 'SSO', impact: { cost: '+10%' } },
    ],
    requires_customer: false,
    ...overrides,
  };
}

function ours(id: string, value: unknown, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    case_id: 'case-a',
    item: ITEM,
    key: KEY,
    level: 'customer-value',
    state: 'proposed',
    value,
    basis: [],
    origin: 'facade',
    status: 'active',
    proposed_by: { kind: 'human', id: 'user:alice' },
    proposed_at: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function customer(
  id: string,
  value: unknown,
  overrides: Partial<DecisionRecord> = {}
): DecisionRecord {
  return {
    id,
    case_id: 'case-a',
    item: ITEM,
    key: KEY,
    level: 'customer-value',
    state: 'decided',
    value,
    basis: [{ ref: 'rcp-0001', version: 'h' }],
    origin: 'facade',
    status: 'active',
    decided_by: {
      kind: 'human',
      id: 'user:alice',
      on_behalf_of: { actor_id: 'customer:acme-cto', evidence: 'rcp-0001' },
    },
    decided_at: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

const approvedD1 = new Set(['D-0001']);

describe('resolveEffectiveDecision', () => {
  it('is undecided when no layer has a value', () => {
    const result = resolveEffectiveDecision(entry(), [], {
      approvedOurDecisionIds: new Set(),
      now: NOW,
    });
    expect(result).toEqual({
      entry_id: 'e1',
      item: ITEM,
      key: KEY,
      layer: 'none',
      status: 'undecided',
      overridable: true,
    });
  });

  it('falls back to the organization default when ours is missing', () => {
    const result = resolveEffectiveDecision(
      entry({ org_default: { value: 'password', source: 'hearing:aidlc_inception' } }),
      [],
      { approvedOurDecisionIds: new Set(), now: NOW }
    );
    expect(result).toMatchObject({
      layer: 'org_default',
      value: 'password',
      status: 'provisional',
      decided_by: 'hearing:aidlc_inception',
    });
    expect(result.decision_id).toBeUndefined();
  });

  it('uses our approved decision over the organization default (provisional)', () => {
    const result = resolveEffectiveDecision(
      entry({ org_default: { value: 'password', source: 'tpl' } }),
      [ours('D-0001', 'sso')],
      { approvedOurDecisionIds: approvedD1, now: NOW }
    );
    expect(result).toMatchObject({
      layer: 'ours',
      value: 'sso',
      decision_id: 'D-0001',
      status: 'provisional',
      decided_by: 'user:alice',
      at: '2026-10-20T00:00:00.000Z',
    });
  });

  it('ignores a proposed record that is not pinned by an approved revision', () => {
    const result = resolveEffectiveDecision(
      entry({ org_default: { value: 'password', source: 'tpl' } }),
      [ours('D-0001', 'sso'), ours('D-0002', 'magic-link', { supersedes: 'D-0001' })],
      { approvedOurDecisionIds: new Set(), now: NOW }
    );
    expect(result).toMatchObject({ layer: 'org_default', value: 'password' });
  });

  it('keeps the pinned decision even when a later unpinned proposal superseded it', () => {
    const ledger = [
      ours('D-0001', 'sso', { status: 'superseded' }),
      ours('D-0002', 'magic-link', { supersedes: 'D-0001' }),
    ];
    const result = resolveEffectiveDecision(entry(), ledger, {
      approvedOurDecisionIds: approvedD1,
      now: NOW,
    });
    expect(result).toMatchObject({ layer: 'ours', value: 'sso', decision_id: 'D-0001' });
  });

  it('ignores pinned ids that belong to another item or key', () => {
    const result = resolveEffectiveDecision(entry(), [ours('D-0001', 'x', { key: 'other.key' })], {
      approvedOurDecisionIds: approvedD1,
      now: NOW,
    });
    expect(result.layer).toBe('none');
  });

  it('lets the customer decision supersede ours and confirms it', () => {
    const ledger = [
      ours('D-0001', 'sso', { status: 'superseded' }),
      customer('D-0002', 'password', { supersedes: 'D-0001' }),
    ];
    const result = resolveEffectiveDecision(entry(), ledger, {
      approvedOurDecisionIds: approvedD1,
      now: NOW,
    });
    expect(result).toMatchObject({
      layer: 'customer',
      value: 'password',
      decision_id: 'D-0002',
      status: 'confirmed',
      decided_by: 'customer:acme-cto',
      at: '2026-10-22T00:00:00.000Z',
    });
  });

  it('confirms our value when the customer keeps it as is', () => {
    const ledger = [
      ours('D-0001', 'sso', { status: 'superseded' }),
      customer('D-0002', 'sso', { supersedes: 'D-0001' }),
    ];
    const result = resolveEffectiveDecision(entry(), ledger, {
      approvedOurDecisionIds: approvedD1,
      now: NOW,
    });
    expect(result).toMatchObject({ layer: 'customer', value: 'sso', status: 'confirmed' });
  });

  it('does not count decided records without a customer actor, or superseded customer records', () => {
    const memberDecided = customer('D-0002', 'password', {
      decided_by: { kind: 'human', id: 'user:alice' },
    });
    expect(
      resolveEffectiveDecision(entry(), [ours('D-0001', 'sso'), memberDecided], {
        approvedOurDecisionIds: approvedD1,
        now: NOW,
      })
    ).toMatchObject({ layer: 'ours', value: 'sso' });
    const superseded = customer('D-0002', 'password', { status: 'superseded' });
    expect(
      resolveEffectiveDecision(entry(), [ours('D-0001', 'sso'), superseded], {
        approvedOurDecisionIds: approvedD1,
        now: NOW,
      })
    ).toMatchObject({ layer: 'ours', value: 'sso' });
  });

  it('does not count customer-value records that are only proposed', () => {
    const result = resolveEffectiveDecision(
      entry(),
      [customer('D-0002', 'password', { state: 'proposed' })],
      { approvedOurDecisionIds: new Set(), now: NOW }
    );
    expect(result.layer).toBe('none');
  });

  it('awaits the customer when requires_customer and lower layers would have a value', () => {
    const result = resolveEffectiveDecision(
      entry({ requires_customer: true, layers: ['customer', 'ours', 'org_default'] }),
      [ours('D-0001', 'sso')],
      { approvedOurDecisionIds: approvedD1, now: NOW }
    );
    expect(result).toMatchObject({ layer: 'none', status: 'awaiting_customer' });
    expect(result).not.toHaveProperty('value');
  });

  it('keeps a requires_customer customer decision provisional until the operator confirms it', () => {
    const result = resolveEffectiveDecision(
      entry({ requires_customer: true }),
      [customer('D-0001', 'release')],
      { approvedOurDecisionIds: new Set(), now: NOW }
    );
    expect(result).toMatchObject({
      layer: 'customer',
      status: 'provisional',
      value: 'release',
      decision_id: 'D-0001',
      awaiting_operator_confirmation: true,
    });
  });

  it('confirms a requires_customer entry once the operator confirmed that exact decision', () => {
    const ledger = [customer('D-0001', 'release')];
    const confirmed = resolveEffectiveDecision(entry({ requires_customer: true }), ledger, {
      approvedOurDecisionIds: new Set(),
      now: NOW,
      operatorConfirmedIds: new Set(['D-0001']),
    });
    expect(confirmed).toMatchObject({ layer: 'customer', status: 'confirmed', value: 'release' });
    expect(confirmed).not.toHaveProperty('awaiting_operator_confirmation');
    // A confirmation names one decision: a later customer decision needs its own.
    const later = resolveEffectiveDecision(
      entry({ requires_customer: true }),
      [
        customer('D-0001', 'release', { status: 'superseded' }),
        customer('D-0002', 'hold', { supersedes: 'D-0001' }),
      ],
      { approvedOurDecisionIds: new Set(), now: NOW, operatorConfirmedIds: new Set(['D-0001']) }
    );
    expect(later).toMatchObject({ status: 'provisional', awaiting_operator_confirmation: true });
  });

  it('never needs operator confirmation for an entry that does not require the customer', () => {
    const result = resolveEffectiveDecision(entry(), [customer('D-0001', 'password')], {
      approvedOurDecisionIds: new Set(),
      now: NOW,
    });
    expect(result).toMatchObject({ layer: 'customer', status: 'confirmed' });
    expect(result).not.toHaveProperty('awaiting_operator_confirmation');
  });

  it('reads operator confirmations from the agenda, outside the content hash', () => {
    const base = agenda({ entries: [entry({ entry_id: 'release', requires_customer: true })] });
    const ledger = [customer('D-0001', 'release')];
    expect(resolveAgendaEffective(base, ledger, { now: NOW })[0].status).toBe('provisional');
    const confirmed: DecisionAgenda = {
      ...base,
      operator_confirmations: [
        { entry_id: 'release', decision_id: 'D-0001', by: 'user:alice', at: NOW },
      ],
    };
    expect(agendaContentHash(confirmed)).toBe(agendaContentHash(base));
    expect(resolveAgendaEffective(confirmed, ledger, { now: NOW })[0].status).toBe('confirmed');
    expect(
      detectSwitches(
        resolveAgendaEffective(base, ledger, { now: NOW }),
        resolveAgendaEffective(confirmed, ledger, { now: NOW }),
        { case_id: 'c', agenda_id: 'agd-test0001', now: NOW, newId: () => 'sw-test0001' }
      ).map((item) => [item.kind, item.from.layer, item.to.layer])
    ).toEqual([['confirmed', 'customer', 'customer']]);
  });

  it('honours a custom layer order (ours before customer)', () => {
    const ledger = [
      ours('D-0001', 'sso', { status: 'superseded' }),
      customer('D-0002', 'password', { supersedes: 'D-0001' }),
    ];
    const result = resolveEffectiveDecision(entry({ layers: ['ours', 'customer'] }), ledger, {
      approvedOurDecisionIds: approvedD1,
      now: NOW,
    });
    expect(result).toMatchObject({ layer: 'ours', value: 'sso', status: 'provisional' });
  });

  it('skips layers absent from a custom order', () => {
    const result = resolveEffectiveDecision(
      entry({ layers: ['customer'], org_default: { value: 'password', source: 'tpl' } }),
      [ours('D-0001', 'sso')],
      { approvedOurDecisionIds: approvedD1, now: NOW }
    );
    expect(result).toMatchObject({ layer: 'none', status: 'undecided' });
  });

  it('treats a falsy value (null, false) as a value', () => {
    const result = resolveEffectiveDecision(entry(), [ours('D-0001', false)], {
      approvedOurDecisionIds: approvedD1,
      now: NOW,
    });
    expect(result).toMatchObject({ layer: 'ours', value: false });
  });
});

describe('override window', () => {
  it('is open without override_until', () => {
    expect(isOverrideWindowOpen(entry(), NOW)).toBe(true);
  });

  it('closes at the date deadline', () => {
    const e = entry({ override_until: { kind: 'date', at: '2026-10-24T00:00:00.000Z' } });
    expect(isOverrideWindowOpen(e, '2026-10-23T23:59:59.000Z')).toBe(true);
    expect(isOverrideWindowOpen(e, '2026-10-24T00:00:00.000Z')).toBe(false);
    expect(
      resolveEffectiveDecision(e, [], { approvedOurDecisionIds: new Set(), now: NOW }).overridable
    ).toBe(false);
  });

  it('fails closed on an unparseable date', () => {
    expect(isOverrideWindowOpen(entry({ override_until: { kind: 'date', at: 'soon' } }), NOW)).toBe(
      false
    );
  });

  it('closes once the milestone has passed', () => {
    const e = entry({ override_until: { kind: 'milestone', milestone: 'bolt-2-start' } });
    expect(isOverrideWindowOpen(e, NOW, ['bolt-1-start'])).toBe(true);
    expect(isOverrideWindowOpen(e, NOW, ['bolt-1-start', 'bolt-2-start'])).toBe(false);
  });
});

function agenda(overrides: Partial<DecisionAgenda> = {}): DecisionAgenda {
  const base: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: 'agd-test0001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    customer: 'acme',
    title: 'Inception',
    phase: 'inception',
    revision: 1,
    locale: 'ja',
    entries: [
      entry({ our_decision: { value: 'sso', decision_id: 'D-0001' } }),
      entry({
        entry_id: 'e2',
        key: 'release.go',
        requires_customer: true,
        override_until: { kind: 'milestone', milestone: 'release' },
      }),
    ],
    status: 'approved',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  return base;
}

function approve(a: DecisionAgenda): DecisionAgenda {
  return {
    ...a,
    approval: { content_hash: agendaContentHash(a), approved_at: NOW, approved_by: 'user:bob' },
  };
}

describe('resolveAgendaEffective', () => {
  const ledger = [ours('D-0001', 'sso')];

  it('pins our decisions from an approved agenda', () => {
    const result = resolveAgendaEffective(approve(agenda()), ledger, { now: NOW });
    expect(result.map((r) => [r.entry_id, r.layer, r.status])).toEqual([
      ['e1', 'ours', 'provisional'],
      ['e2', 'none', 'awaiting_customer'],
    ]);
  });

  it('pins nothing without an approval', () => {
    const result = resolveAgendaEffective(agenda({ status: 'draft' }), ledger, { now: NOW });
    expect(result[0]).toMatchObject({ layer: 'none', status: 'undecided' });
  });

  it('pins nothing when the content changed after approval (revision mismatch)', () => {
    const approved = approve(agenda());
    const edited: DecisionAgenda = {
      ...approved,
      entries: approved.entries.map((e) =>
        e.entry_id === 'e1' ? { ...e, question: 'Changed question?' } : e
      ),
    };
    expect(approvedOurDecisionIds(edited).size).toBe(0);
    expect(resolveAgendaEffective(edited, ledger, { now: NOW })[0].layer).toBe('none');
  });

  it('keeps the last approved pins in force after an unapproved edit, without a switch', () => {
    const approved = approve(agenda());
    const inForce = {
      content_hash: approved.approval!.content_hash,
      approved_at: NOW,
      pinned_ids: ['D-0001'],
    };
    // The facade's edit drops `approval` and the entry pins, and keeps `in_force`.
    const { approval: _approval, ...rest } = approved;
    void _approval;
    const edited: DecisionAgenda = {
      ...rest,
      status: 'draft',
      in_force: inForce,
      entries: approved.entries.map((e) =>
        e.entry_id === 'e1' ? { ...e, our_decision: { value: 'password' } } : e
      ),
    };
    expect([...approvedOurDecisionIds(edited)]).toEqual(['D-0001']);
    const before = resolveAgendaEffective(approved, ledger, { now: NOW });
    const after = resolveAgendaEffective(edited, ledger, { now: NOW });
    expect(after[0]).toMatchObject({ layer: 'ours', value: 'sso', decision_id: 'D-0001' });
    expect(
      detectSwitches(before, after, {
        case_id: 'case-a',
        agenda_id: edited.agenda_id,
        now: NOW,
        newId: () => 'sw-test0001',
      })
    ).toEqual([]);
    // A current approval's own pins win over a stale in_force.
    const reapproved = approve({
      ...edited,
      in_force: inForce,
      entries: edited.entries.map((e) =>
        e.entry_id === 'e1'
          ? { ...e, our_decision: { value: 'password', decision_id: 'D-0002' } }
          : e
      ),
    });
    expect([...approvedOurDecisionIds(reapproved)]).toEqual(['D-0002']);
  });

  it('uses the agenda milestones unless the caller overrides them', () => {
    const a = approve(agenda({ milestones_passed: ['release'] }));
    expect(resolveAgendaEffective(a, ledger, { now: NOW })[1].overridable).toBe(false);
    expect(
      resolveAgendaEffective(a, ledger, { now: NOW, milestonesPassed: [] })[1].overridable
    ).toBe(true);
  });
});

describe('agendaContentHash', () => {
  it('is a sha256 hex digest', () => {
    expect(agendaContentHash(agenda())).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('does not depend on key order', () => {
    const a = agenda();
    const reordered = {
      entries: a.entries.map((e) => Object.fromEntries(Object.entries(e).reverse()) as AgendaEntry),
      customer: a.customer,
      locale: a.locale,
      phase: a.phase,
      title: a.title,
    };
    expect(agendaContentHash(reordered)).toBe(agendaContentHash(a));
  });

  it('excludes the pinned decision id, status, approval, revision and timestamps', () => {
    const a = agenda();
    const unpinned: DecisionAgenda = {
      ...a,
      entries: a.entries.map((e) =>
        e.our_decision ? { ...e, our_decision: { value: e.our_decision.value } } : e
      ),
      status: 'draft',
      revision: 7,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-02T00:00:00.000Z',
      approval: { content_hash: 'f'.repeat(64), approved_at: NOW, approved_by: 'user:bob' },
    };
    expect(agendaContentHash(unpinned)).toBe(agendaContentHash(a));
  });

  it('changes when our decision value, options or the requires_customer flag change', () => {
    const a = agenda();
    const base = agendaContentHash(a);
    const withEntry = (patch: Partial<AgendaEntry>) =>
      agendaContentHash({ ...a, entries: [{ ...a.entries[0], ...patch }, a.entries[1]] });
    expect(withEntry({ our_decision: { value: 'password', decision_id: 'D-0001' } })).not.toBe(
      base
    );
    expect(withEntry({ options: [] })).not.toBe(base);
    expect(withEntry({ requires_customer: true })).not.toBe(base);
    expect(agendaContentHash({ ...a, title: 'Other' })).not.toBe(base);
  });
});

function eff(overrides: Partial<EffectiveDecision>): EffectiveDecision {
  return {
    entry_id: 'e1',
    item: ITEM,
    key: KEY,
    layer: 'ours',
    value: 'sso',
    decision_id: 'D-0001',
    status: 'provisional',
    overridable: true,
    ...overrides,
  };
}

describe('detectSwitches', () => {
  let counter = 0;
  const ctx = () => ({
    case_id: 'case-a',
    agenda_id: 'agd-test0001',
    now: NOW,
    cause_receipt_id: 'rcp-test0001',
    newId: () => `sw-test${String(++counter).padStart(4, '0')}`,
  });

  it('emits value_changed when the customer picks a different value', () => {
    const switches = detectSwitches(
      [eff({})],
      [eff({ layer: 'customer', value: 'password', decision_id: 'D-0002', status: 'confirmed' })],
      ctx()
    );
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({
      version: '1.0.0',
      kind: 'value_changed',
      case_id: 'case-a',
      agenda_id: 'agd-test0001',
      entry_id: 'e1',
      from: { layer: 'ours', value: 'sso', decision_id: 'D-0001' },
      to: { layer: 'customer', value: 'password', decision_id: 'D-0002' },
      at: NOW,
      cause_receipt_id: 'rcp-test0001',
    });
    expect(switches[0].switch_id).toMatch(/^sw-test\d{4}$/u);
  });

  it('emits confirmed when the customer keeps the provisional value', () => {
    const switches = detectSwitches(
      [eff({})],
      [eff({ layer: 'customer', decision_id: 'D-0002', status: 'confirmed' })],
      ctx()
    );
    expect(switches.map((s) => s.kind)).toEqual(['confirmed']);
  });

  it('ignores equal values regardless of key order and layer-only changes', () => {
    expect(
      detectSwitches(
        [eff({ value: { a: 1, b: 2 } })],
        [eff({ value: { b: 2, a: 1 }, layer: 'org_default', decision_id: undefined })],
        ctx()
      )
    ).toEqual([]);
    expect(detectSwitches([eff({})], [eff({})], ctx())).toEqual([]);
  });

  it('emits value_changed from nothing to a value, including entries new to the resolution', () => {
    const none = eff({
      layer: 'none',
      value: undefined,
      decision_id: undefined,
      status: 'undecided',
    });
    const [s1] = detectSwitches([none], [eff({})], ctx());
    expect(s1).toMatchObject({ kind: 'value_changed', from: { layer: 'none' } });
    expect(s1.from).not.toHaveProperty('value');
    const [s2] = detectSwitches([], [eff({})], ctx());
    expect(s2).toMatchObject({ kind: 'value_changed', from: { layer: 'none' } });
  });

  it('distinguishes null from no value', () => {
    const none = eff({ layer: 'none', value: undefined, status: 'undecided' });
    expect(detectSwitches([none], [eff({ value: null })], ctx())).toHaveLength(1);
  });

  it('does not emit for confirmed → confirmed with the same value', () => {
    const confirmed = eff({ layer: 'customer', status: 'confirmed' });
    expect(detectSwitches([confirmed], [confirmed], ctx())).toEqual([]);
  });

  it('omits cause_receipt_id when not given', () => {
    const { cause_receipt_id: _c, ...rest } = ctx();
    void _c;
    const [s] = detectSwitches([eff({})], [eff({ value: 'x' })], rest);
    expect(s).not.toHaveProperty('cause_receipt_id');
  });
});

describe('checkDecisionFreshness', () => {
  const lock: ConsumedDecisionLock = {
    case_id: 'case-a',
    consumer: 'MSN-X/task-1',
    locked_at: NOW,
    decisions: [{ item: ITEM, key: KEY, decision_id: 'D-0001', value: 'sso', layer: 'ours' }],
  };

  it('is fresh when the value is unchanged, even if the layer changed', () => {
    expect(
      checkDecisionFreshness(lock, [
        eff({ layer: 'customer', decision_id: 'D-0002', status: 'confirmed' }),
      ])
    ).toEqual({ fresh: true, stale: [] });
  });

  it('is stale when the value changed', () => {
    const current = eff({ layer: 'customer', value: 'password', status: 'confirmed' });
    const result = checkDecisionFreshness(lock, [current]);
    expect(result.fresh).toBe(false);
    expect(result.stale).toEqual([{ item: ITEM, key: KEY, locked: lock.decisions[0], current }]);
  });

  it('is stale when the decision disappeared from the resolution', () => {
    const result = checkDecisionFreshness(lock, []);
    expect(result.fresh).toBe(false);
    expect(result.stale[0].current).toBeUndefined();
  });

  it('compares values canonically', () => {
    const objectLock: ConsumedDecisionLock = {
      ...lock,
      decisions: [{ item: ITEM, key: KEY, value: { x: 1, y: [1, 2] }, layer: 'ours' }],
    };
    expect(checkDecisionFreshness(objectLock, [eff({ value: { y: [1, 2], x: 1 } })]).fresh).toBe(
      true
    );
  });
});

describe('checkLayerPrecedence', () => {
  it('never lets ours or org_default replace a customer decision', () => {
    const current = eff({ layer: 'customer', status: 'confirmed' });
    expect(checkLayerPrecedence(current, 'ours')).toEqual({
      ok: false,
      reason: 'customer_decision_locked',
    });
    expect(checkLayerPrecedence(current, 'org_default')).toEqual({
      ok: false,
      reason: 'customer_decision_locked',
    });
  });

  it('lets ours replace ours or org_default', () => {
    expect(checkLayerPrecedence(eff({}), 'ours')).toEqual({ ok: true });
    expect(checkLayerPrecedence(eff({ layer: 'org_default' }), 'ours')).toEqual({ ok: true });
  });

  it('lets the customer replace anything while the window is open', () => {
    expect(checkLayerPrecedence(eff({}), 'customer')).toEqual({ ok: true });
    expect(
      checkLayerPrecedence(eff({ layer: 'customer', status: 'confirmed' }), 'customer')
    ).toEqual({ ok: true });
  });

  it('turns a customer change after the window into override_window_closed', () => {
    expect(checkLayerPrecedence(eff({ overridable: false }), 'customer')).toEqual({
      ok: false,
      reason: 'override_window_closed',
    });
    expect(
      checkLayerPrecedence(
        eff({ layer: 'customer', status: 'confirmed', overridable: false }),
        'customer'
      )
    ).toEqual({ ok: false, reason: 'override_window_closed' });
  });

  it('lets the customer make the first decision even after the window closed', () => {
    expect(
      checkLayerPrecedence(
        eff({ layer: 'none', value: undefined, status: 'awaiting_customer', overridable: false }),
        'customer'
      )
    ).toEqual({ ok: true });
  });
});
