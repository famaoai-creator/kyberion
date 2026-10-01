import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARTER_DRAFT,
  charterErrorKind,
  checkDraft,
  draftFromCharter,
  draftToForm,
  isManuallyStopped,
  parseAmount,
  parseCharterOverview,
  parseDeputies,
  type CharterFormDraft,
} from '../src/lib/charter-view';

const draft = (over: Partial<CharterFormDraft> = {}): CharterFormDraft => ({
  ...DEFAULT_CHARTER_DRAFT,
  per_action: '100,000',
  per_day: '200000',
  per_month: '1 000 000',
  max_loss_per_incident: '100000',
  deputies: 'user:carol, user:dave',
  ...over,
});

describe('parseAmount', () => {
  it('accepts grouped whole numbers and rejects the rest', () => {
    expect(parseAmount('1,000,000')).toBe(1_000_000);
    expect(parseAmount(' 1_000 ')).toBe(1000);
    for (const bad of ['', '1.5', '-1', '1e3', 'abc', '12345678901234']) {
      expect(parseAmount(bad), bad).toBeNaN();
    }
  });
});

describe('checkDraft', () => {
  it('accepts a coherent draft', () => expect(checkDraft(draft())).toEqual({ ok: true }));
  it.each([
    [{ per_action: 'x' }, 'number'],
    [{ per_action: '300000' }, 'order'],
    [{ per_day: '2000000' }, 'order'],
    [{ max_loss_per_incident: '2000000' }, 'loss'],
    [{ expires_in_days: '0' }, 'days'],
    [{ expires_in_days: '400' }, 'days'],
    [{ expires_in_days: '1.5' }, 'days'],
    [{ deputies: 'carol' }, 'deputy'],
  ])('rejects %j as %s', (over, reason) => {
    expect(checkDraft(draft(over as Partial<CharterFormDraft>)).ok).toBe(false);
    expect(
      (checkDraft(draft(over as Partial<CharterFormDraft>)) as { reason: string }).reason
    ).toBe(reason);
  });
});

describe('form <-> draft', () => {
  it('parses deputies from commas, spaces and 、, deduplicated', () => {
    expect(parseDeputies('user:a, user:b  user:a、user:c')).toEqual(['user:a', 'user:b', 'user:c']);
    expect(parseDeputies('')).toEqual([]);
  });
  it('draftToForm produces the API body', () => {
    expect(draftToForm('acme', draft({ allow_named_spend: true }))).toEqual({
      tenant_slug: 'acme',
      per_action: 100000,
      per_day: 200000,
      per_month: 1000000,
      max_loss_per_incident: 100000,
      allow_named_spend: true,
      supersedes_decision_rights: false,
      deputies: ['user:carol', 'user:dave'],
      expires_in_days: 90,
    });
  });
  it('an amendment starts from the charter in force', () => {
    const d = draftFromCharter({
      money: { per_action: 5, per_day: 10, per_month: 20 },
      max_loss_per_incident: 5,
      deputies: ['user:carol'],
      allows_named_spend: true,
      supersedes_decision_rights: true,
    });
    expect(d).toMatchObject({
      per_action: '5',
      deputies: 'user:carol',
      allow_named_spend: true,
      supersedes_decision_rights: true,
      expires_in_days: '90',
    });
  });
});

describe('parseCharterOverview', () => {
  const tenant = (charter: unknown = null) => ({
    tenant_slug: 'acme',
    role: 'owner',
    can_create: true,
    can_stop: true,
    charter,
  });
  it('parses tenants with and without a charter', () => {
    expect(parseCharterOverview({ ok: true, tenants: [tenant()] })).toHaveLength(1);
    expect(
      parseCharterOverview({
        ok: true,
        tenants: [tenant({ charter_id: 'chr-1', report: { tripwires_standing: [] } })],
      })
    ).toHaveLength(1);
  });
  it('rejects malformed payloads', () => {
    for (const bad of [
      null,
      {},
      { ok: false },
      { ok: true, tenants: 'x' },
      { ok: true, tenants: [{ tenant_slug: 1 }] },
      { ok: true, tenants: [tenant({ nope: 1 })] },
    ]) {
      expect(parseCharterOverview(bad)).toBeUndefined();
    }
  });
  it('detects a manual stop', () => {
    const [v] = parseCharterOverview({
      ok: true,
      tenants: [tenant({ charter_id: 'c', report: { tripwires_standing: ['manual-stop'] } })],
    })!;
    expect(isManuallyStopped(v)).toBe(true);
    const [w] = parseCharterOverview({ ok: true, tenants: [tenant()] })!;
    expect(isManuallyStopped(w)).toBe(false);
  });
});

describe('charterErrorKind', () => {
  it('maps server codes; unknown codes are shown as detail', () => {
    expect(charterErrorKind('owner_required')).toBe('owner');
    expect(charterErrorKind('member_required')).toBe('member');
    expect(charterErrorKind('statement_changed')).toBe('changed');
    expect(charterErrorKind('not_responsible')).toBe('responsible');
    expect(charterErrorKind('invalid_form: x')).toBe('generic');
  });
});

describe('amendment proposals', () => {
  it('pre-fills a limit and lifts the parents so the form stays valid', async () => {
    const { applyProposalToDraft, checkDraft, DEFAULT_CHARTER_DRAFT, proposalDraftField } =
      await import('../src/lib/charter-view');
    const base = {
      ...DEFAULT_CHARTER_DRAFT,
      per_action: '100000',
      per_day: '500000',
      per_month: '3000000',
      max_loss_per_incident: '300000',
    };
    const next = applyProposalToDraft(base, {
      field: 'envelope.money.per_action',
      count: 2,
      requested: 800_000,
    });
    expect(next.per_action).toBe('800000');
    expect(next.per_day).toBe('800000');
    expect(checkDraft(next)).toEqual({ ok: true });
    expect(
      applyProposalToDraft(base, { field: 'envelope.irreversible', count: 1, requested: 'allow' })
    ).toBe(base);
    expect(
      proposalDraftField({ field: 'appetite.max_loss_per_incident', count: 1, requested: 1 })
    ).toBe('max_loss_per_incident');
  });

  it('usage percent is clamped and a zero limit is not a full bar', async () => {
    const { usagePercent } = await import('../src/lib/charter-view');
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(900, 200)).toBe(100);
    expect(usagePercent(10, 0)).toBe(0);
  });
});
