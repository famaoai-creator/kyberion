import { describe, expect, it } from 'vitest';
import type { WorkInventoryConsent } from '@agent/core/workforce/work-inventory-consent';
import type { WorkInventoryObservationSummary } from '@agent/core/workforce/work-inventory-observation';
import { buildObservationReview } from './observation-review';
import { parseObservationReview } from './observation-review-types';

const now = new Date('2026-10-02T00:00:00Z');
export const consent: WorkInventoryConsent = {
  schema_version: 'work-inventory-consent.v1',
  consent_id: 'WIC-20261001-123456789abc',
  member_id: 'member-a',
  tenant_slug: 'acme',
  sources: ['desktop_recording'],
  observation_kinds: ['active_window'],
  purpose: 'Review',
  granted_at: '2026-09-25T00:00:00Z',
  expires_at: '2026-10-10T00:00:00Z',
  granted_by: { kind: 'human', id: 'member-a' },
};
export const summary: WorkInventoryObservationSummary = {
  schema_version: 'work-inventory-observation-summary.v1',
  summary_id: 'WIO-20261001-123456789abc',
  member_id: 'member-a',
  tenant_slug: 'acme',
  consent_id: consent.consent_id,
  source: 'desktop_recording',
  recording_hash: 'sensitive-hash',
  window: { start: '2026-10-01T00:00:00Z', end: '2026-10-01T01:00:00Z' },
  apps: ['Private app'],
  hosts: ['private.example'],
  op_counts: { send: 1 },
  step_count: 1,
  proposed_steps: [
    {
      stage: 'act',
      verb: 'communicate',
      description: 'private text',
      effects: [],
      requires_attention: true,
    },
  ],
  status: 'pending_review',
  created_at: '2026-10-01T02:00:00Z',
};
const review = (summaries = [summary], consents = [consent]) =>
  buildObservationReview(summaries, consents, 'member-a', 'acme', now);

describe('consented personal review projection', () => {
  it('returns only count fields and no private content or actions', () => {
    expect(review()).toEqual({
      checkedAt: now.toISOString(),
      pendingCount: 1,
      attentionCount: 1,
      limited: false,
    });
    expect(JSON.stringify(review())).not.toMatch(/private|sensitive|WIO|WIC/);
  });
  it.each([
    { member_id: 'member-b' },
    { tenant_slug: 'other' },
    { tenant_slug: undefined },
    { status: 'confirmed' as const },
    { status: 'discarded' as const },
    { source: 'browser_recording' as const },
    { consent_id: 'other-consent' },
    { window: { start: '2026-09-24T00:00:00Z', end: '2026-09-24T01:00:00Z' } },
    { window: { start: '2026-10-03T00:00:00Z', end: '2026-10-03T01:00:00Z' } },
    { window: { start: 'bad', end: 'bad' } },
    { window: { start: '2026-10-01T02:00:00Z', end: '2026-10-01T01:00:00Z' } },
  ])('excludes records failing attribution, consent or time: %j', (change) => {
    expect(review([{ ...summary, ...change }]).pendingCount).toBe(0);
  });
  it.each([
    { member_id: 'member-b' },
    { tenant_slug: 'other' },
    { revoked_at: '2026-10-01T03:00:00Z' },
    { expires_at: now.toISOString() },
    { granted_at: '2026-10-01T00:30:00Z' },
  ])('rechecks the original grant, including current revocation: %j', (change) => {
    const replacement = { ...consent, consent_id: 'replacement' };
    expect(review([summary], [{ ...consent, ...change }, replacement]).pendingCount).toBe(0);
  });
  it('allows a valid subject-wide original consent but still requires exact summary tenant', () => {
    expect(review([summary], [{ ...consent, tenant_slug: undefined }]).pendingCount).toBe(1);
  });
  it('counts attention per summary, caps newest eligible records and signals the cap', () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...summary,
      summary_id: String(index),
      proposed_steps: index === 0 ? [] : summary.proposed_steps,
    }));
    const digest = review(rows);
    expect(digest.pendingCount).toBe(100);
    expect(digest.attentionCount).toBeLessThanOrEqual(100);
    expect(digest.limited).toBe(true);
  });
  it('selects newest records by instant even across timezone offsets', () => {
    const older = Array.from({ length: 100 }, (_, index) => ({
      ...summary,
      summary_id: String(index),
      window: { ...summary.window, end: '2026-10-01T23:00:00+09:00' },
      proposed_steps: [],
    }));
    const newest = { ...summary, window: { ...summary.window, end: '2026-10-01T16:00:00Z' } };
    expect(review([...older, newest]).attentionCount).toBe(1);
  });
  it('rejects invalid client responses and projects extra fields away', () => {
    expect(parseObservationReview({ ok: true, ...review(), secret: 'no' })).toEqual(review());
    for (const value of [
      null,
      {},
      { ok: true, ...review(), pendingCount: 101 },
      { ok: true, ...review(), attentionCount: 2 },
      { ok: true, ...review(), checkedAt: 'bad' },
    ]) {
      expect(() => parseObservationReview(value)).toThrow();
    }
  });
});
