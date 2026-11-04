/**
 * Pure, client-safe helpers for the ホーム dashboard (`app/page.tsx`): parsing
 * the two reads the page makes, telling "couldn't load" apart from "empty",
 * and the drill-down links. No I/O, no vocabulary.
 */
import type { HomeAgentState, HomeDashboard } from './home-dashboard';

export type { HomeDashboard, HomeAgentState };

/** Contract §2 reasons, in the order the bar lists them. */
export const NEEDS_YOU_REASONS = [
  'approval',
  'decision',
  'review',
  'clarification',
  'failure',
  'knowledge',
] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

export interface NeedsYouSummary {
  total: number;
  overdue: number;
  oldestWaitingSince?: string;
  byReason: Record<NeedsYouReason, number>;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * `GET /api/v1/needs-you/summary` (contract §2). Accepts the flat contract
 * shape and the surface-operation envelope (`{ ok, data }`); anything else is
 * a failed read, never a zero.
 */
export function parseNeedsYouSummary(body: unknown): NeedsYouSummary | null {
  if (!body || typeof body !== 'object') return null;
  const outer = body as Record<string, unknown>;
  if (outer.ok !== true) return null;
  const inner =
    outer.data && typeof outer.data === 'object' ? (outer.data as Record<string, unknown>) : outer;
  if (typeof inner.total !== 'number' || !inner.byReason || typeof inner.byReason !== 'object') {
    return null;
  }
  const reasons = inner.byReason as Record<string, unknown>;
  const byReason = Object.fromEntries(
    NEEDS_YOU_REASONS.map((reason) => [reason, count(reasons[reason])])
  ) as Record<NeedsYouReason, number>;
  const since = inner.oldestWaitingSince;
  return {
    total: count(inner.total),
    overdue: count(inner.overdue),
    ...(typeof since === 'string' && !Number.isNaN(Date.parse(since))
      ? { oldestWaitingSince: since }
      : {}),
    byReason,
  };
}

export function parseHomeDashboard(body: unknown): HomeDashboard | null {
  if (!body || typeof body !== 'object') return null;
  const outer = body as { ok?: unknown; data?: unknown };
  if (outer.ok !== true || !outer.data || typeof outer.data !== 'object') return null;
  const data = outer.data as Partial<HomeDashboard>;
  if (
    !data.agents ||
    !data.missions ||
    !data.health ||
    !data.krs ||
    !Array.isArray(data.unavailable)
  )
    return null;
  return data as HomeDashboard;
}

/** Why a read failed: a busy server (429) reads differently from a broken one. */
export type HomeLoadFailure = 'busy' | 'signin' | 'forbidden' | 'failed';

export function loadFailureFromStatus(status: number): HomeLoadFailure {
  if (status === 429) return 'busy';
  if (status === 401) return 'signin';
  if (status === 403) return 'forbidden';
  return 'failed';
}

export function inboxHref(filter?: { reason?: NeedsYouReason; overdue?: boolean }): string {
  const query = new URLSearchParams();
  if (filter?.reason) query.set('reason', filter.reason);
  if (filter?.overdue) query.set('overdue', '1');
  const search = query.toString();
  return `/inbox${search ? `?${search}` : ''}`;
}

export type MissionOpenState = keyof HomeDashboard['missions']['open'];

export function workHref(state?: MissionOpenState): string {
  return state ? `/work?tab=missions&status=${state}&view=list` : '/work';
}

export function missionHref(missionId: string): string {
  return `/w/mission/${encodeURIComponent(missionId)}`;
}

/** `/settings` + the readiness step's own anchor (`#settings-members`, ...). */
export function settingsHref(anchor: string): string {
  return anchor.startsWith('#') ? `/settings${anchor}` : '/settings';
}

/** Share of `value` in `max` as a CSS percentage, never below a visible sliver for non-zero values. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(2, Math.min(100, (value / max) * 100));
}

export type DeltaDirection = 'up' | 'down' | 'flat';

/**
 * Change against the previous window. `unit: 'pt'` compares rates (0..1) in
 * percentage points; otherwise the raw difference. Null when either side is
 * missing — "nothing to compare" is said, not shown as 0.
 */
export function windowDelta(
  current: number | null,
  previous: number | null,
  unit: 'pt' | 'h'
): { direction: DeltaDirection; text: string } | null {
  if (current === null || previous === null) return null;
  const raw = unit === 'pt' ? (current - previous) * 100 : current - previous;
  const rounded = Math.round(raw * 10) / 10;
  if (rounded === 0) return { direction: 'flat', text: `±0${unit === 'pt' ? ' pt' : ' h'}` };
  const sign = rounded > 0 ? '+' : '−';
  return {
    direction: rounded > 0 ? 'up' : 'down',
    text: `${sign}${Math.abs(rounded)}${unit === 'pt' ? ' pt' : ' h'}`,
  };
}

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

/** "3 days ago" in the viewer's language; browser-only primitive. */
export function relativeTime(value: string, bcp47: string, now = Date.now()): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return '';
  const diff = at - now;
  const formatter = new Intl.RelativeTimeFormat(bcp47, { numeric: 'auto' });
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (Math.abs(diff) >= ms) return formatter.format(Math.round(diff / ms), unit);
  }
  return formatter.format(0, 'minute');
}
