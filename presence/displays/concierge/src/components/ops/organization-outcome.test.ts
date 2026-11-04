import { describe, expect, it } from 'vitest';
import {
  interventionPresentation,
  krStatus,
  krTrend,
  krView,
  resolveOrganizationTenant,
  sumAccounting,
} from './organization-outcome';

describe('key result view', () => {
  it('maps progress toward the target to a status', () => {
    expect(krStatus(undefined)).toBe('unmeasured');
    expect(krStatus(Number.NaN)).toBe('unmeasured');
    expect(krStatus(1)).toBe('met');
    expect(krStatus(0.75)).toBe('on_track');
    expect(krStatus(0.5)).toBe('at_risk');
    expect(krStatus(0.1)).toBe('off_track');
  });

  it('reads the trend from the last two measurements (progress is direction-aware)', () => {
    const row = (progress: number, day: number) => ({
      value: progress * 100,
      progress,
      measured_at: `2026-10-0${day}T00:00:00Z`,
    });
    expect(krTrend(undefined)).toBeUndefined();
    expect(krTrend([row(0.4, 1)])).toBeUndefined();
    expect(krTrend([row(0.2, 1), row(0.4, 2), row(0.6, 3)])).toBe('up');
    expect(krTrend([row(0.6, 1), row(0.4, 2)])).toBe('down');
    expect(krTrend([row(0.5, 1), row(0.502, 2)])).toBe('flat');
  });

  it('rounds and clamps the percent, and omits it when unmeasured', () => {
    expect(krView({ progress: 0.756 })).toEqual({ percent: 76, status: 'on_track' });
    expect(krView({ progress: 1.4 })).toEqual({ percent: 100, status: 'met' });
    expect(krView({})).toEqual({ status: 'unmeasured' });
  });
});

describe('organization tenant choice', () => {
  it('uses the selected tenant, else the only one in scope, else asks', () => {
    expect(resolveOrganizationTenant('acme', ['a', 'b'])).toEqual({
      mode: 'single',
      tenant: 'acme',
    });
    expect(resolveOrganizationTenant('', ['solo'])).toEqual({ mode: 'single', tenant: 'solo' });
    expect(resolveOrganizationTenant(undefined, ['a', 'b', 'a'])).toEqual({
      mode: 'multiple',
      tenants: ['a', 'b'],
    });
    expect(resolveOrganizationTenant(undefined, [])).toEqual({ mode: 'none' });
  });

  it('sums accounting across tenants', () => {
    const base = {
      active_projects: 1,
      active_services: 2,
      healthy_services: 2,
      degraded_or_critical_services: 0,
      active_operations: 3,
      overdue_operations: 1,
      open_incidents: 0,
      pending_decisions: 2,
    };
    expect(sumAccounting([base, { ...base, open_incidents: 4 }])).toEqual({
      active_projects: 2,
      active_services: 4,
      healthy_services: 4,
      degraded_or_critical_services: 0,
      active_operations: 6,
      overdue_operations: 2,
      open_incidents: 4,
      pending_decisions: 4,
    });
  });
});

describe('intervention presentation', () => {
  it('turns machine reasons into a localized sentence and a place to act', () => {
    expect(
      interventionPresentation({
        kind: 'operation',
        reason: 'overdue_operations requires operator attention.',
      })
    ).toEqual({ reason: { key: 'ux_b_intervention_overdue_operations' }, action: 'operations' });
    expect(
      interventionPresentation({ kind: 'decision', reason: 'Decision is pending_approval.' })
    ).toEqual({
      reason: { key: 'ux_b_intervention_decision', params: { status: 'pending approval' } },
      action: 'decisions',
    });
    expect(interventionPresentation({ kind: 'incident', reason: 'Incident is open.' })).toEqual({
      reason: { key: 'ux_b_intervention_incident', params: { status: 'open' } },
      action: 'operations',
    });
    expect(
      interventionPresentation({
        kind: 'project',
        reason: 'unknown_code requires operator attention.',
      })
    ).toEqual({ reason: { key: 'ux_b_intervention_generic' }, action: 'project' });
  });
});
