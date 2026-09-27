import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import {
  effectiveInterventionLevel,
  formatDecisionInstant,
  type InterventionLevel,
} from './approval-decision-card.js';
import { approvalStoreRoots, type ApprovalRequestRecord } from './approval-store.js';
import { readJsonLines } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { resolveLocale } from './locale.js';
import type { SupportedLocale } from './locale-normalize.js';
import { pathResolver } from './path-resolver.js';
import { t } from './t.js';

/**
 * Autonomous-operation P1-8: the operator's twice-daily view of the decision
 * loop. The headline answers "how many things need me?" before anything else;
 * the sections below explain what the agents did on their own, what will
 * proceed unless objected to, and which waits have gone quiet.
 *
 * `none` / `fyi` actions never create approval requests, so they are recorded
 * here as notices — otherwise "report only" would mean "reported nowhere".
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_DIGEST_STALE_AFTER_MS = 3 * DAY_MS;
const SECTION_LIMIT = 5;

export interface AutonomousActionNotice {
  ts: string;
  actionId: string;
  level: Extract<InterventionLevel, 'none' | 'fyi'>;
  title: string;
  summary?: string;
  ref?: string;
  missionId?: string;
}

export interface DigestMissionWait {
  missionId: string;
  status: string;
  updatedAt: string;
}

export interface DigestItem {
  id: string;
  title: string;
  detail?: string;
  level?: InterventionLevel;
  ageMs?: number;
  deadlineAt?: string;
  timezone?: string;
}

export interface DecisionDigest {
  generatedAt: string;
  since: string;
  counts: { decide: number; veto: number; done: number; stale: number; expired: number };
  needsDecision: DigestItem[];
  vetoPending: DigestItem[];
  stale: DigestItem[];
  done: DigestItem[];
  expired: DigestItem[];
}

export function autonomousActionNoticeLogicalPath(): string {
  return `${approvalStoreRoots().observability}/autonomy/actions.jsonl`;
}

export function recordAutonomousActionNotice(
  role: GovernedArtifactRole,
  notice: Omit<AutonomousActionNotice, 'ts'> & { ts?: string }
): AutonomousActionNotice {
  const entry: AutonomousActionNotice = { ...notice, ts: notice.ts ?? nowIso() };
  appendGovernedArtifactJsonl(role, autonomousActionNoticeLogicalPath(), entry);
  return entry;
}

export function listAutonomousActionNotices(sinceMs = 0): AutonomousActionNotice[] {
  return readJsonLines<AutonomousActionNotice>(
    pathResolver.resolve(autonomousActionNoticeLogicalPath()),
    {
      onMalformed: 'skip',
    }
  ).filter((notice) => {
    const ts = Date.parse(notice.ts);
    return Number.isFinite(ts) && ts >= sinceMs;
  });
}

function ageOf(iso: string | undefined, now: number): number | undefined {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? Math.max(0, now - ms) : undefined;
}

function byOldest(left: DigestItem, right: DigestItem): number {
  return (right.ageMs ?? 0) - (left.ageMs ?? 0);
}

function byDeadline(left: DigestItem, right: DigestItem): number {
  const leftMs = left.deadlineAt ? Date.parse(left.deadlineAt) : Number.POSITIVE_INFINITY;
  const rightMs = right.deadlineAt ? Date.parse(right.deadlineAt) : Number.POSITIVE_INFINITY;
  return leftMs === rightMs ? 0 : leftMs < rightMs ? -1 : 1;
}

function isAutonomousDecision(record: ApprovalRequestRecord): boolean {
  return (
    (record.status === 'approved' || record.status === 'applied') &&
    (record.decidedByType === 'service' || record.decidedByType === 'ai_agent')
  );
}

export function buildDecisionDigest(input: {
  approvals: ApprovalRequestRecord[];
  notices?: AutonomousActionNotice[];
  missions?: DigestMissionWait[];
  now?: number;
  since: string;
  staleAfterMs?: number;
}): DecisionDigest {
  const now = input.now ?? Date.now();
  const sinceMs = Date.parse(input.since);
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_DIGEST_STALE_AFTER_MS;
  const inWindow = (iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) && ms >= sinceMs;
  };

  const needsDecision: DigestItem[] = [];
  const vetoPending: DigestItem[] = [];
  const done: DigestItem[] = [];
  const expired: DigestItem[] = [];

  for (const record of input.approvals) {
    if (record.status === 'pending') {
      const level = effectiveInterventionLevel(record, now);
      const item: DigestItem = {
        id: record.id,
        title: record.title,
        detail: record.decisionCard?.ask ?? record.summary,
        level,
        ageMs: ageOf(record.requestedAt, now),
        ...(record.veto?.activeHours ? { timezone: record.veto.activeHours.timezone } : {}),
      };
      if (level === 'veto') {
        vetoPending.push({
          ...item,
          ...(record.veto?.proceedsAt && !record.veto.shadow
            ? { deadlineAt: record.veto.proceedsAt }
            : {}),
        });
      } else if (level === 'decide') {
        needsDecision.push({
          ...item,
          ...(record.expiresAt ? { deadlineAt: record.expiresAt } : {}),
        });
      }
    } else if (isAutonomousDecision(record) && inWindow(record.decidedAt)) {
      done.push({ id: record.id, title: record.title, detail: record.decidedBy });
    } else if (record.status === 'expired' && inWindow(record.expiresAt ?? record.requestedAt)) {
      expired.push({ id: record.id, title: record.title });
    }
  }

  for (const notice of input.notices ?? []) {
    if (!inWindow(notice.ts)) continue;
    done.push({
      id: notice.ref ?? notice.actionId,
      title: notice.title,
      ...(notice.summary ? { detail: notice.summary } : {}),
      level: notice.level,
    });
  }

  const stale: DigestItem[] = [];
  for (const mission of input.missions ?? []) {
    const ageMs = ageOf(mission.updatedAt, now);
    if (ageMs === undefined || ageMs < staleAfterMs) continue;
    stale.push({ id: mission.missionId, title: mission.missionId, detail: mission.status, ageMs });
  }

  needsDecision.sort(byOldest);
  vetoPending.sort(byDeadline);
  stale.sort(byOldest);

  return {
    generatedAt: new Date(now).toISOString(),
    since: input.since,
    counts: {
      decide: needsDecision.length,
      veto: vetoPending.length,
      done: done.length,
      stale: stale.length,
      expired: expired.length,
    },
    needsDecision,
    vetoPending,
    stale,
    done,
    expired,
  };
}

export function formatDigestAge(ms: number, locale: SupportedLocale = resolveLocale()): string {
  if (ms >= DAY_MS) return t('decision:age_days', { n: String(Math.floor(ms / DAY_MS)) }, locale);
  if (ms >= HOUR_MS) {
    return t('decision:age_hours', { n: String(Math.floor(ms / HOUR_MS)) }, locale);
  }
  return t('decision:age_minutes', { n: String(Math.max(1, Math.floor(ms / 60_000))) }, locale);
}

function renderSection(
  heading: string,
  items: DigestItem[],
  line: (item: DigestItem) => string,
  locale: SupportedLocale
): string[] {
  if (items.length === 0) return [];
  const lines = ['', heading, ...items.slice(0, SECTION_LIMIT).map((item) => `- ${line(item)}`)];
  if (items.length > SECTION_LIMIT) {
    lines.push(
      `  ${t('decision:digest_more', { count: String(items.length - SECTION_LIMIT) }, locale)}`
    );
  }
  return lines;
}

export function renderDecisionDigestText(
  digest: DecisionDigest,
  options: { locale?: SupportedLocale; timezone?: string } = {}
): string {
  const locale = options.locale ?? resolveLocale();
  const lines = [
    t(
      'decision:digest_title',
      { time: formatDecisionInstant(digest.generatedAt, locale, options.timezone) },
      locale
    ),
    t(
      'decision:digest_headline',
      {
        decide: String(digest.counts.decide),
        veto: String(digest.counts.veto),
        done: String(digest.counts.done),
      },
      locale
    ),
  ];
  if (digest.counts.decide === 0 && digest.counts.veto === 0 && digest.counts.stale === 0) {
    lines.push(t('decision:digest_all_clear', undefined, locale));
  }

  const withDetail = (item: DigestItem) =>
    item.detail && item.detail !== item.title ? `${item.title} — ${item.detail}` : item.title;

  lines.push(
    ...renderSection(
      t('decision:digest_section_decide', undefined, locale),
      digest.needsDecision,
      (item) =>
        [
          withDetail(item),
          item.ageMs !== undefined
            ? `(${t('decision:digest_waiting_since', { age: formatDigestAge(item.ageMs, locale) }, locale)})`
            : '',
          `appr:${item.id}`,
        ]
          .filter(Boolean)
          .join(' '),
      locale
    ),
    ...renderSection(
      t('decision:digest_section_veto', undefined, locale),
      digest.vetoPending,
      (item) =>
        `${withDetail(item)} (${
          item.deadlineAt
            ? t(
                'decision:digest_proceeds_at',
                {
                  deadline: formatDecisionInstant(
                    item.deadlineAt,
                    locale,
                    item.timezone ?? options.timezone
                  ),
                },
                locale
              )
            : t('decision:digest_awaiting_delivery', undefined, locale)
        }) appr:${item.id}`,
      locale
    ),
    ...renderSection(
      t('decision:digest_section_stale', undefined, locale),
      digest.stale,
      (item) =>
        `${t('decision:digest_mission_waiting', { missionId: item.id, status: item.detail ?? '' }, locale)}${
          item.ageMs !== undefined
            ? ` (${t('decision:digest_waiting_since', { age: formatDigestAge(item.ageMs, locale) }, locale)})`
            : ''
        }`,
      locale
    ),
    ...renderSection(
      t('decision:digest_section_done', undefined, locale),
      digest.done,
      withDetail,
      locale
    ),
    ...renderSection(
      t('decision:digest_section_expired', undefined, locale),
      digest.expired,
      (item) => item.title,
      locale
    )
  );
  return lines.join('\n');
}
