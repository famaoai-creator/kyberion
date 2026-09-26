/**
 * Cross-tenant organization digest for the sovereign operator.
 *
 * `buildOrganizationDigest` / `renderOrganizationDigestText` are pure: they take
 * already-loaded records so the aggregation is testable in memory.
 * `runOrganizationDigest` is the governed entry point: it requires the
 * sovereign persona, loads every organization under the requested tiers
 * across all tenants, and records one audit-chain entry per run.
 */
import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import {
  calendarDateInZone,
  isJapaneseBankBusinessDay,
  type CalendarDate,
} from './business-calendar.js';
import { isValidTenantSlug } from './entity-scope.js';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  listOrganizationDecisions,
  listOrganizationIncidents,
  listOrganizationOperationalStates,
  listOrganizationServiceStates,
  listOrganizationServices,
} from './organization-operating-model-management.js';
import {
  listOrganizationOperationRuns,
  listOrganizationOperationStates,
  listOrganizationOperations,
} from './organization-operating-model-operations.js';
import {
  organizationOperationDeadlineProjection,
  organizationOperationDueProjection,
} from './organization-operation-runtime.js';
import type {
  OrganizationDecisionRecord,
  OrganizationIncidentRecord,
  OrganizationOperationalState,
  OrganizationOperationRecord,
  OrganizationOperationRun,
  OrganizationOperationState,
  OrganizationServiceRecord,
  OrganizationServiceState,
  OrganizationTier,
} from './organization-operating-model.js';
import type { SupportedLocale } from './locale-normalize.js';
import type { MessageParams } from './message-format.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeStat } from './secure-io.js';
import { t } from './t.js';
import type { VocabularyKey } from './vocabulary-keys.generated.js';

export const ORGANIZATION_DIGEST_DEFAULT_TIMEZONE = 'Asia/Tokyo';
export const ORGANIZATION_DIGEST_DEFAULT_LOCALE: SupportedLocale = 'ja';
const DAY_MS = 86_400_000;
const SERVICE_EXPIRY_WINDOW_MS = 7 * DAY_MS;
const DEADLINE_WINDOW_BUSINESS_DAYS = 2;
const MAX_DECISIONS_PER_ORGANIZATION = 5;
const MAX_TITLE_CHARS = 40;
const OPEN_INCIDENT_STATUSES = new Set(['detected', 'triaging', 'mitigating']);
const PENDING_DECISION_STATUSES = new Set(['proposed', 'pending_approval']);
const OBSERVED_SERVICE_STATUSES = new Set(['active', 'degraded']);
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/** Loaded records for one organization — the pure digest input. */
export interface OrganizationDigestSource {
  state: OrganizationOperationalState;
  operations: OrganizationOperationRecord[];
  operationStates: OrganizationOperationState[];
  /** Run history; deadlines are judged from it (absent = no recorded runs). */
  runs?: OrganizationOperationRun[];
  services: OrganizationServiceRecord[];
  serviceStates: OrganizationServiceState[];
  decisions: OrganizationDecisionRecord[];
  incidents: OrganizationIncidentRecord[];
}

export interface OrganizationDigestDueOperation {
  operation_id: string;
  name: string;
  kind: 'overdue' | 'failed' | 'due_today';
  next_due_at?: string;
  timezone: string;
}

export interface OrganizationDigestDeadline {
  operation_id: string;
  name: string;
  status: 'missed' | 'upcoming';
  deadline_at: string;
  /** Business days after today up to and including the deadline day (0 = today). */
  business_days_remaining: number;
  timezone: string;
  /** On `missed`: a successful run landed after the deadline in this period. */
  completed_late?: true;
}

/** A tenant directory the digest could not read; its organizations are excluded. */
export interface OrganizationDigestSkippedTenant {
  tier: OrganizationTier;
  tenant_slug: string;
}

export interface OrganizationDigestDecision {
  decision_id: string;
  title: string;
  status: OrganizationDecisionRecord['status'];
  due_at: string;
}

export interface OrganizationDigestService {
  service_id: string;
  name: string;
  /** Observation validity end (source_timestamp + freshness window); absent when unobserved. */
  expires_at?: string;
}

export interface OrganizationDigestIncident {
  incident_id: string;
  title: string;
  severity: OrganizationIncidentRecord['severity'];
  status: OrganizationIncidentRecord['status'];
}

export interface OrganizationDigestEntry {
  organization_id: string;
  name: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  due_operations: OrganizationDigestDueOperation[];
  deadlines: OrganizationDigestDeadline[];
  pending_decisions: OrganizationDigestDecision[];
  expiring_services: OrganizationDigestService[];
  stale_services: OrganizationDigestService[];
  unobserved_services: OrganizationDigestService[];
  open_incidents: OrganizationDigestIncident[];
}

export interface OrganizationDigest {
  kind: 'organization_digest';
  generated_at: string;
  timezone: string;
  status: 'clean' | 'attention';
  organization_count: number;
  tenants: string[];
  totals: {
    due_operations: number;
    deadlines: number;
    pending_decisions: number;
    expiring_services: number;
    stale_services: number;
    unobserved_services: number;
    open_incidents: number;
  };
  /** Every aggregated organization, sorted by display name. */
  organizations: OrganizationDigestEntry[];
  /** Tenants whose records could not be read (excluded from the totals). */
  skipped_tenants: OrganizationDigestSkippedTenant[];
}

function dayIndex(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
}

function calendarDateFromIndex(index: number): CalendarDate {
  const date = new Date(index * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Business days strictly after `from` up to and including `to` (0 when `to` is not later). */
export function businessDaysBetween(from: CalendarDate, to: CalendarDate): number {
  let count = 0;
  for (let index = dayIndex(from) + 1; index <= dayIndex(to); index += 1) {
    if (isJapaneseBankBusinessDay(calendarDateFromIndex(index))) count += 1;
  }
  return count;
}

function sameCalendarDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function serviceObservationExpiry(state: OrganizationServiceState): number {
  const source = Date.parse(state.source_timestamp);
  return Number.isFinite(source) ? source + state.freshness_seconds * 1000 : Number.NaN;
}

function digestEntry(source: OrganizationDigestSource, now: Date): OrganizationDigestEntry {
  const nowMs = now.getTime();
  const operationStateById = new Map(
    source.operationStates.map((entry) => [entry.operation_id, entry])
  );
  const dueOperations: OrganizationDigestDueOperation[] = [];
  const deadlines: OrganizationDigestDeadline[] = [];
  const runs = source.runs || [];
  for (const operation of source.operations) {
    if (operation.status !== 'active') continue;
    const state = operationStateById.get(operation.operation_id) || null;
    const deadline = organizationOperationDeadlineProjection(operation, runs, now);
    const timezone = operation.trigger.timezone || ORGANIZATION_DIGEST_DEFAULT_TIMEZONE;
    const due = organizationOperationDueProjection(operation, state, now);
    const dueToday =
      due.next_due_at !== undefined &&
      sameCalendarDate(
        calendarDateInZone(new Date(due.next_due_at), timezone),
        calendarDateInZone(now, timezone)
      );
    // An operation whose business-day deadline projects is judged by that
    // deadline (the 営業日期限 section); its cron slot alone would double-report
    // it. Without a projection the cron slot is the only signal, so keep it.
    const kind: OrganizationDigestDueOperation['kind'] | undefined =
      state?.status === 'failed'
        ? 'failed'
        : deadline
          ? undefined
          : due.due_status === 'overdue'
            ? 'overdue'
            : due.due_status === 'due' || (due.due_status === 'current' && dueToday)
              ? 'due_today'
              : undefined;
    if (kind) {
      dueOperations.push({
        operation_id: operation.operation_id,
        name: operation.name,
        kind,
        ...(due.next_due_at ? { next_due_at: due.next_due_at } : {}),
        timezone,
      });
    }
    if (!deadline || deadline.status === 'met' || deadline.status === 'untracked') continue;
    const remaining = businessDaysBetween(
      calendarDateInZone(now, timezone),
      calendarDateInZone(new Date(deadline.deadline_at), timezone)
    );
    if (deadline.status === 'upcoming' && remaining > DEADLINE_WINDOW_BUSINESS_DAYS) continue;
    deadlines.push({
      operation_id: operation.operation_id,
      name: operation.name,
      status: deadline.status,
      deadline_at: deadline.deadline_at,
      business_days_remaining: deadline.status === 'missed' ? 0 : remaining,
      timezone,
      ...(deadline.completed_late ? { completed_late: true as const } : {}),
    });
  }

  const serviceStateById = new Map(source.serviceStates.map((entry) => [entry.service_id, entry]));
  const expiringServices: OrganizationDigestService[] = [];
  const staleServices: OrganizationDigestService[] = [];
  const unobservedServices: OrganizationDigestService[] = [];
  for (const service of source.services) {
    if (!OBSERVED_SERVICE_STATUSES.has(service.status)) continue;
    const state = serviceStateById.get(service.service_id);
    if (!state) {
      unobservedServices.push({ service_id: service.service_id, name: service.name });
      continue;
    }
    const expiry = serviceObservationExpiry(state);
    const entry: OrganizationDigestService = {
      service_id: service.service_id,
      name: service.name,
      ...(Number.isFinite(expiry) ? { expires_at: new Date(expiry).toISOString() } : {}),
    };
    const fresh =
      state.reconcile_status === 'current' &&
      state.freshness_seconds > 0 &&
      Number.isFinite(expiry) &&
      Date.parse(state.source_timestamp) <= nowMs &&
      expiry >= nowMs;
    if (!fresh) staleServices.push(entry);
    else if (expiry - nowMs <= SERVICE_EXPIRY_WINDOW_MS) expiringServices.push(entry);
  }

  return {
    organization_id: source.state.organization_id,
    name: source.state.name,
    tier: source.state.tier,
    ...(source.state.tenant_slug ? { tenant_slug: source.state.tenant_slug } : {}),
    due_operations: dueOperations.sort((a, b) =>
      (a.next_due_at || '').localeCompare(b.next_due_at || '')
    ),
    deadlines: deadlines.sort((a, b) => a.deadline_at.localeCompare(b.deadline_at)),
    pending_decisions: source.decisions
      .filter((entry) => PENDING_DECISION_STATUSES.has(entry.status))
      .map((entry) => ({
        decision_id: entry.decision_id,
        title: entry.title,
        status: entry.status,
        due_at: entry.due_at,
      }))
      .sort((a, b) => a.due_at.localeCompare(b.due_at)),
    expiring_services: expiringServices.sort((a, b) =>
      (a.expires_at || '').localeCompare(b.expires_at || '')
    ),
    stale_services: staleServices.sort((a, b) => a.service_id.localeCompare(b.service_id)),
    unobserved_services: unobservedServices.sort((a, b) =>
      a.service_id.localeCompare(b.service_id)
    ),
    open_incidents: source.incidents
      .filter((entry) => OPEN_INCIDENT_STATUSES.has(entry.status))
      .map((entry) => ({
        incident_id: entry.incident_id,
        title: entry.title,
        severity: entry.severity,
        status: entry.status,
      }))
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          a.incident_id.localeCompare(b.incident_id)
      ),
  };
}

/** Aggregate loaded organization records into one structured digest. */
export function buildOrganizationDigest(
  sources: OrganizationDigestSource[],
  options: {
    now?: Date;
    timezone?: string;
    skippedTenants?: OrganizationDigestSkippedTenant[];
  } = {}
): OrganizationDigest {
  const skippedTenants = options.skippedTenants || [];
  const now = options.now || new Date();
  const organizations = sources
    .filter((source) => source.state.status !== 'archived')
    .map((source) => digestEntry(source, now))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'ja') || a.organization_id.localeCompare(b.organization_id)
    );
  const sum = (pick: (entry: OrganizationDigestEntry) => unknown[]) =>
    organizations.reduce((total, entry) => total + pick(entry).length, 0);
  const totals = {
    due_operations: sum((entry) => entry.due_operations),
    deadlines: sum((entry) => entry.deadlines),
    pending_decisions: sum((entry) => entry.pending_decisions),
    expiring_services: sum((entry) => entry.expiring_services),
    stale_services: sum((entry) => entry.stale_services),
    unobserved_services: sum((entry) => entry.unobserved_services),
    open_incidents: sum((entry) => entry.open_incidents),
  };
  return {
    kind: 'organization_digest',
    generated_at: now.toISOString(),
    timezone: options.timezone || ORGANIZATION_DIGEST_DEFAULT_TIMEZONE,
    status:
      skippedTenants.length > 0 || Object.values(totals).some((count) => count > 0)
        ? 'attention'
        : 'clean',
    organization_count: organizations.length,
    tenants: [...new Set(organizations.map((entry) => entry.tenant_slug || 'shared'))].sort(),
    totals,
    organizations,
    skipped_tenants: skippedTenants,
  };
}

function formatLocal(iso: string, timeZone: string, locale: SupportedLocale, withTime = true) {
  const parts = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
  }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const date = `${value('month')}/${value('day')}(${value('weekday')})`;
  return withTime ? `${date} ${value('hour')}:${value('minute')}` : date;
}

function truncate(value: string, max = MAX_TITLE_CHARS): string {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
}

function section(
  title: string,
  digest: OrganizationDigest,
  lines: (entry: OrganizationDigestEntry) => string[],
  headerSuffix: (entry: OrganizationDigestEntry) => string = () => ''
): string[] {
  const body = digest.organizations.flatMap((entry) => {
    const entryLines = lines(entry).map((line) => `• ${line}`);
    return entryLines.length ? [`_${entry.name}_${headerSuffix(entry)}`, ...entryLines] : [];
  });
  return body.length ? [`*${title}*`, ...body] : [];
}

const DUE_LABEL_KEYS = {
  overdue: 'organization_digest_label_overdue',
  failed: 'organization_digest_label_failed',
  due_today: 'organization_digest_label_due_today',
} as const;

/** Render the digest as a compact Slack mrkdwn message (Japanese by default). */
export function renderOrganizationDigestText(
  digest: OrganizationDigest,
  locale: SupportedLocale = ORGANIZATION_DIGEST_DEFAULT_LOCALE
): string {
  const zone = digest.timezone;
  const tr = (key: VocabularyKey, params?: MessageParams) => t(key, params, locale);
  const at = (iso: string, timeZone = zone) => formatLocal(iso, timeZone, locale);
  const day = (iso: string) => formatLocal(iso, zone, locale, false);
  const header = tr('organization_digest_header', {
    when: at(digest.generated_at),
    count: digest.organization_count,
  });
  if (digest.status === 'clean') return `${header}\n${tr('organization_digest_clean')}`;
  const blocks = [
    section(tr('organization_digest_section_due'), digest, (entry) =>
      entry.due_operations.map((item) => {
        const label = tr(DUE_LABEL_KEYS[item.kind]);
        return item.next_due_at
          ? tr('organization_digest_due_line', {
              label,
              name: item.name,
              when: at(item.next_due_at, item.timezone),
            })
          : `[${label}] ${item.name}`;
      })
    ),
    section(tr('organization_digest_section_deadlines'), digest, (entry) =>
      entry.deadlines.map((item) => {
        const params = { name: item.name, when: at(item.deadline_at, item.timezone) };
        if (item.status === 'missed') return tr('organization_digest_deadline_missed_line', params);
        return item.business_days_remaining === 0
          ? tr('organization_digest_deadline_today_line', params)
          : tr('organization_digest_deadline_upcoming_line', {
              ...params,
              count: item.business_days_remaining,
            });
      })
    ),
    section(
      tr('organization_digest_section_decisions'),
      digest,
      (entry) => {
        const items = entry.pending_decisions;
        const rest = items.length - MAX_DECISIONS_PER_ORGANIZATION;
        return [
          ...items.slice(0, MAX_DECISIONS_PER_ORGANIZATION).map((item) =>
            tr('organization_digest_decision_line', {
              title: truncate(item.title),
              when: day(item.due_at),
            })
          ),
          ...(rest > 0 ? [tr('organization_digest_more', { count: rest })] : []),
        ];
      },
      (entry) =>
        ` ${tr('organization_digest_decision_count', { count: entry.pending_decisions.length })}`
    ),
    section(tr('organization_digest_section_services'), digest, (entry) => [
      ...entry.expiring_services.map((item) =>
        tr('organization_digest_service_expiring_line', {
          name: item.name,
          when: day(item.expires_at!),
        })
      ),
      ...entry.stale_services.map((item) =>
        item.expires_at
          ? tr('organization_digest_service_stale_line', {
              name: item.name,
              when: day(item.expires_at),
            })
          : tr('organization_digest_service_stale_line_unknown', { name: item.name })
      ),
      ...entry.unobserved_services.map((item) =>
        tr('organization_digest_service_unobserved_line', { name: item.name })
      ),
    ]),
    section(tr('organization_digest_section_incidents'), digest, (entry) =>
      entry.open_incidents.map((item) =>
        tr('organization_digest_incident_line', {
          severity: item.severity,
          title: item.title,
          status: item.status,
        })
      )
    ),
    digest.skipped_tenants.length
      ? [
          tr('organization_digest_skipped_tenants_line', {
            tenants: digest.skipped_tenants
              .map((entry) => `${entry.tier}/${entry.tenant_slug}`)
              .join(', '),
          }),
        ]
      : [],
  ].filter((block) => block.length > 0);
  return [header, ...blocks.map((block) => block.join('\n'))].join('\n\n');
}

function listDirectories(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => safeStat(path.join(dir, entry)).isDirectory())
    .sort();
}

export interface OrganizationDigestSources {
  sources: OrganizationDigestSource[];
  skipped_tenants: OrganizationDigestSkippedTenant[];
}

/**
 * Load every organization under the given tiers, across all tenant
 * directories. One unreadable tenant is skipped (and reported) rather than
 * failing the digest for every other tenant.
 */
export function loadOrganizationDigestSources(
  options: { tiers?: OrganizationTier[]; rootDir?: string } = {}
): OrganizationDigestSources {
  const rootDir = options.rootDir || pathResolver.rootDir();
  const tiers = options.tiers || ['confidential', 'public'];
  const sources: OrganizationDigestSource[] = [];
  const skipped: OrganizationDigestSkippedTenant[] = [];
  for (const tier of tiers) {
    for (const tenantSlug of listDirectories(path.join(rootDir, 'active/organizations', tier))) {
      if (tenantSlug !== 'shared' && !isValidTenantSlug(tenantSlug)) continue;
      try {
        const tenantSources: OrganizationDigestSource[] = [];
        for (const state of listOrganizationOperationalStates({ tier, tenantSlug, rootDir })) {
          const query = { organizationId: state.organization_id, tier, tenantSlug, rootDir };
          tenantSources.push({
            state,
            operations: listOrganizationOperations(query),
            operationStates: listOrganizationOperationStates(query),
            runs: listOrganizationOperationRuns(query),
            services: listOrganizationServices(query),
            serviceStates: listOrganizationServiceStates(query),
            decisions: listOrganizationDecisions(query),
            incidents: listOrganizationIncidents(query),
          });
        }
        sources.push(...tenantSources);
      } catch {
        skipped.push({ tier, tenant_slug: tenantSlug });
      }
    }
  }
  return { sources, skipped_tenants: skipped };
}

export interface RunOrganizationDigestOptions {
  now?: Date;
  timezone?: string;
  /** Rendering locale for the text (defaults to Japanese). */
  locale?: SupportedLocale;
  tiers?: OrganizationTier[];
  rootDir?: string;
  /** Environment used for the persona check (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export interface OrganizationDigestRun {
  digest: OrganizationDigest;
  text: string;
}

/**
 * Governed cross-tenant digest. Only the sovereign persona may aggregate
 * across tenants; each run leaves one audit-chain entry naming the tenants read.
 */
export function runOrganizationDigest(
  options: RunOrganizationDigestOptions = {}
): OrganizationDigestRun {
  const persona = getRegisteredEnvText('KYBERION_PERSONA', { env: options.env });
  if (persona !== 'sovereign') {
    throw new Error(
      `[POLICY_VIOLATION] The organization digest aggregates across tenants and requires KYBERION_PERSONA=sovereign (got ${persona || 'unset'}).`
    );
  }
  const tiers = options.tiers || ['confidential', 'public'];
  const loaded = loadOrganizationDigestSources({ tiers, rootDir: options.rootDir });
  const digest = buildOrganizationDigest(loaded.sources, {
    now: options.now,
    timezone: options.timezone,
    skippedTenants: loaded.skipped_tenants,
  });
  auditChain.record({
    agentId: persona,
    action: 'organization.digest',
    operation: 'digest:cross_tenant',
    result: 'completed',
    metadata: {
      tiers,
      tenants: digest.tenants,
      organization_count: digest.organization_count,
      status: digest.status,
      skipped_tenants: digest.skipped_tenants.map((entry) => `${entry.tier}/${entry.tenant_slug}`),
    },
  });
  return { digest, text: renderOrganizationDigestText(digest, options.locale) };
}
