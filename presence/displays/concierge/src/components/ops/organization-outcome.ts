/**
 * Pure view model for the organization dashboard: which tenant to show, the
 * aggregate across several tenants, and how a key result reads (progress vs
 * target, status, trend). No I/O, no vocabulary — the component renders.
 */

export type KrDirection = 'increase' | 'decrease' | 'maintain';
export type KrStatus = 'met' | 'on_track' | 'at_risk' | 'off_track' | 'unmeasured';
export type KrTrend = 'up' | 'down' | 'flat';

export interface KrInput {
  progress?: number;
  value?: number;
  target?: number;
  baseline?: number;
  direction?: KrDirection;
  measured_at?: string;
  history?: Array<{ value: number; progress: number; measured_at: string }>;
}

export interface KrView {
  /** 0..100, rounded; undefined when unmeasured. */
  percent?: number;
  status: KrStatus;
  /** Direction-aware: `up` always means closer to the target. */
  trend?: KrTrend;
}

/** Thresholds on progress toward the target (progress is already direction-aware, 0..1). */
const ON_TRACK = 0.7;
const AT_RISK = 0.4;
const TREND_EPSILON = 0.005;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function krStatus(progress: number | undefined): KrStatus {
  if (progress === undefined || !Number.isFinite(progress)) return 'unmeasured';
  if (progress >= 1) return 'met';
  if (progress >= ON_TRACK) return 'on_track';
  if (progress >= AT_RISK) return 'at_risk';
  return 'off_track';
}

/** Compare the last two measurements; progress already encodes the direction. */
export function krTrend(history: KrInput['history']): KrTrend | undefined {
  if (!history || history.length < 2) return undefined;
  const last = history[history.length - 1]!;
  const previous = history[history.length - 2]!;
  const delta = last.progress - previous.progress;
  if (Math.abs(delta) < TREND_EPSILON) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

export function krView(kr: KrInput): KrView {
  const progress =
    kr.progress !== undefined && Number.isFinite(kr.progress) ? clamp01(kr.progress) : undefined;
  const trend = krTrend(kr.history);
  return {
    ...(progress !== undefined ? { percent: Math.round(progress * 100) } : {}),
    status: krStatus(progress),
    ...(trend ? { trend } : {}),
  };
}

/** Which tenant the organization view shows. The server still authorizes the read. */
export type OrganizationTenantChoice =
  { mode: 'single'; tenant: string } | { mode: 'multiple'; tenants: string[] } | { mode: 'none' };

export function resolveOrganizationTenant(
  selected: string | undefined,
  available: readonly string[]
): OrganizationTenantChoice {
  if (selected) return { mode: 'single', tenant: selected };
  const unique = [...new Set(available.filter(Boolean))];
  if (unique.length === 1) return { mode: 'single', tenant: unique[0]! };
  if (unique.length > 1) return { mode: 'multiple', tenants: unique };
  return { mode: 'none' };
}

export interface OrganizationAccountingTotals {
  active_projects: number;
  active_services: number;
  healthy_services: number;
  degraded_or_critical_services: number;
  active_operations: number;
  overdue_operations: number;
  open_incidents: number;
  pending_decisions: number;
}

const ACCOUNTING_KEYS: Array<keyof OrganizationAccountingTotals> = [
  'active_projects',
  'active_services',
  'healthy_services',
  'degraded_or_critical_services',
  'active_operations',
  'overdue_operations',
  'open_incidents',
  'pending_decisions',
];

export function sumAccounting(
  entries: ReadonlyArray<OrganizationAccountingTotals>
): OrganizationAccountingTotals {
  const total = Object.fromEntries(
    ACCOUNTING_KEYS.map((key) => [key, 0])
  ) as unknown as OrganizationAccountingTotals;
  for (const entry of entries) {
    for (const key of ACCOUNTING_KEYS) {
      const value = entry[key];
      if (Number.isFinite(value)) total[key] += value;
    }
  }
  return total;
}
