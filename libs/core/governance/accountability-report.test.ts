import { describe, expect, it } from 'vitest';
import type { Charter } from './accountability-charter.js';
import type { LedgerEntry } from './accountability-charter-registry.js';
import {
  buildAccountabilityReport,
  renderAccountabilityReportText,
} from './accountability-report.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const charter = (expires = '2026-12-31T00:00:00.000Z'): Charter =>
  ({
    charter_id: 'chr-acme-1',
    scope: { kind: 'organization', tenant_slug: 'acme' },
    accountable: { actor: 'user:owner', expires_at: expires, deputies: [] },
    envelope: {
      money: { currency: 'JPY', per_action: 100_000, per_day: 200_000, per_month: 1_000_000 },
    },
    appetite: { tripwires: ['audit-chain-gap'] },
  }) as unknown as Charter;

const spend = (ts: string, money: number): LedgerEntry => ({
  kind: 'consumption',
  ts,
  actor: 'a',
  action_class: 'payment',
  money,
  loss: 0,
  decision: 'allow',
});
const denied = (ts: string, field?: string): LedgerEntry => ({
  kind: 'denied',
  ts,
  actor: 'a',
  action_class: 'payment',
  reasons: ['x'],
  ...(field ? { amendment_field: field } : {}),
});

describe('buildAccountabilityReport', () => {
  it('is all clear when only quiet, in-budget work happened', () => {
    const r = buildAccountabilityReport({
      charter: charter(),
      ledger: [spend('2026-10-01T01:00:00.000Z', 10_000)],
      now: NOW,
    });
    expect(r).toMatchObject({
      executed: 1,
      denied: 0,
      all_clear: true,
      near_limit: [],
      tripwires_standing: [],
    });
    expect(r.money).toMatchObject({ spent_today: 10_000, spent_this_month: 10_000 });
  });

  it('counts only the window for activity, but day/month for money', () => {
    const r = buildAccountabilityReport({
      charter: charter(),
      ledger: [spend('2026-09-20T00:00:00.000Z', 5_000), spend('2026-10-01T01:00:00.000Z', 7_000)],
      now: NOW,
      hours: 24,
    });
    expect(r.executed).toBe(1);
    expect(r.money.spent_this_month).toBe(7_000); // Sept spend is a different month
    const sept = buildAccountabilityReport({
      charter: charter(),
      ledger: [spend('2026-10-01T01:00:00.000Z', 1)],
      now: NOW,
      hours: 0.001,
    });
    expect(sept.executed).toBe(0);
  });

  it('flags budgets at 80%+, held decisions, and ranks amendment requests', () => {
    const r = buildAccountabilityReport({
      charter: charter(),
      ledger: [
        spend('2026-10-01T01:00:00.000Z', 170_000),
        denied('2026-10-01T02:00:00.000Z', 'envelope.money.per_action'),
        denied('2026-10-01T03:00:00.000Z', 'envelope.money.per_action'),
        denied('2026-10-01T04:00:00.000Z', 'envelope.irreversible'),
      ],
      now: NOW,
    });
    expect(r.near_limit).toEqual(['per_day']);
    expect(r.denied).toBe(3);
    expect(r.amendments).toEqual([
      { field: 'envelope.money.per_action', count: 2 },
      { field: 'envelope.irreversible', count: 1 },
    ]);
    expect(r.all_clear).toBe(false);
  });

  it('proposes the smallest widening that admits every denial, per field', () => {
    const ask = (ts: string, requested: number, cls = 'payment'): LedgerEntry => ({
      kind: 'denied',
      ts,
      actor: 'a',
      action_class: cls,
      reasons: ['x'],
      amendment_field: 'envelope.money.per_action',
      amendment_current: 100_000,
      amendment_requested: requested,
    });
    const r = buildAccountabilityReport({
      charter: charter(),
      ledger: [
        ask('2026-10-01T02:00:00.000Z', 150_000),
        ask('2026-10-01T03:00:00.000Z', 220_000, 'vendor_payment'),
        ask('2026-09-20T03:00:00.000Z', 900_000),
      ],
      now: NOW,
    });
    expect(r.amendment_proposals).toEqual([
      {
        field: 'envelope.money.per_action',
        count: 2,
        current: 100_000,
        requested: 220_000,
        action_classes: ['payment', 'vendor_payment'],
        last_seen: '2026-10-01T03:00:00.000Z',
      },
    ]);
  });

  it('a tripwire stands until cleared, and puts the stop first in the text', () => {
    const stop: LedgerEntry = {
      kind: 'tripwire',
      ts: '2026-10-01T05:00:00.000Z',
      tripwire: 'audit-chain-gap',
    };
    const r = buildAccountabilityReport({ charter: charter(), ledger: [stop], now: NOW });
    expect(r.tripwires_standing).toEqual(['audit-chain-gap']);
    const text = renderAccountabilityReportText(r, { locale: 'en' });
    expect(text.split('\n')[1]).toContain('audit-chain-gap');
    const cleared = buildAccountabilityReport({
      charter: charter(),
      ledger: [
        stop,
        {
          kind: 'tripwire_clear',
          ts: '2026-10-01T06:00:00.000Z',
          tripwire: 'audit-chain-gap',
          cleared_by: 'user:owner',
        },
      ],
      now: NOW,
    });
    expect(cleared.tripwires_standing).toEqual([]);
  });

  it('warns when the charter is about to expire', () => {
    const r = buildAccountabilityReport({
      charter: charter('2026-10-08T09:00:00.000Z'),
      ledger: [],
      now: NOW,
    });
    expect(r.expires_in_days).toBe(7);
    expect(r.all_clear).toBe(false);
    expect(renderAccountabilityReportText(r, { locale: 'en' })).toContain('7 days');
  });
});

describe('renderAccountabilityReportText', () => {
  it('renders Japanese and English, with the all-clear line on a quiet day', () => {
    const r = buildAccountabilityReport({ charter: charter(), ledger: [], now: NOW });
    expect(renderAccountabilityReportText(r, { locale: 'ja' })).toContain('説明責任レポート');
    expect(renderAccountabilityReportText(r, { locale: 'en' })).toContain('Nothing needed you');
  });
});
