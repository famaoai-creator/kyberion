/**
 * Organization weekly retro (DL-06): objective trend, whether the dots' actions
 * moved their signals (outcomes), what was refused or declined, incidents, and
 * budget pressure over the window.
 *
 * Same shape as the standup: `buildOrganizationRetro` is pure over injected
 * readers; `runOrganizationRetro` is the governed (sovereign-only, audited)
 * sweep that files each retro in the organization's scope and notifies.
 */
import * as path from 'node:path';
import { auditChain } from '../governance/audit-chain.js';
import { readJsonLines } from '../foundation/json.js';
import { dotStatePath, DOT_OUTCOMES_FILE, type DotOutcomeRow } from '../dot/dot-state-paths.js';
import type { DotCharter } from '../dot/dot-charter.js';
import {
  evaluateBudgetThrottle,
  type OrgBudgetEvaluation,
} from '../governance/org-budget-governor.js';
import type { SupportedLocale } from '../locale-normalize.js';
import type { MessageParams } from '../message-format.js';
import type { VocabularyKey } from '../knowledge/vocabulary-keys.generated.js';
import { pathResolver } from '../path-resolver.js';
import { t } from '../t.js';
import { assertSovereignCadencePersona, listOrganizationScopes } from './organization-cadence.js';
import { listOrganizationIncidents } from './organization-operating-model-management.js';
import type {
  OrganizationIncidentRecord,
  OrganizationTier,
} from './organization-operating-model.js';
import type { OrganizationScopeRef } from './organization-operation-tick.js';
import {
  ORGANIZATION_CADENCE_DEFAULT_LOCALE,
  ORGANIZATION_CADENCE_DEFAULT_TIMEZONE,
  cadenceSection,
  cadenceTenant,
  objectiveProgressChanges,
  organizationActions,
  organizationDisplayName,
  organizationDotCharters,
  persistOrganizationCadenceReport,
  truncateText,
  type CadencePersistence,
  type ObjectiveProgressChange,
  type OrganizationCadenceDeps,
} from './organization-standup.js';

const DAY_MS = 86_400_000;

export interface OrganizationRetroDeps extends OrganizationCadenceDeps {
  /** Outcome rows for one dot; defaults to a tolerant read of the dot's outcomes ledger. */
  readOutcomes?: (charter: DotCharter) => DotOutcomeRow[];
  listIncidents?: (scope: OrganizationScopeRef) => OrganizationIncidentRecord[];
  evaluateBudget?: (scope: OrganizationScopeRef) => OrgBudgetEvaluation | undefined;
}

/** Reads the outcomes ledger by path so a missing module/file or bad line never fails the retro. */
function readOutcomesTolerant(charter: DotCharter, rootDir?: string): DotOutcomeRow[] {
  try {
    const file = path.join(
      rootDir ?? pathResolver.rootDir(),
      dotStatePath(charter, DOT_OUTCOMES_FILE)
    );
    return readJsonLines<DotOutcomeRow>(file, { onMalformed: 'skip' }).filter(
      (row) => row?.dot_id === charter.dot_id && typeof row.verdict === 'string'
    );
  } catch {
    return [];
  }
}

export interface OrganizationRetro {
  kind: 'organization_retro';
  generated_at: string;
  since: string;
  timezone: string;
  organization_id: string;
  tier: OrganizationTier;
  tenant_slug?: string;
  objectives: ObjectiveProgressChange[];
  outcomes: {
    improved: number;
    no_change: number;
    regressed: number;
    unmeasurable: number;
    /** improved / judged (percent, 0 when nothing was measurable). */
    success_percent: number;
  };
  rejections: Array<{
    dot_id: string;
    status: 'refused' | 'declined';
    title: string;
    reason: string;
  }>;
  incidents: Array<{ incident_id: string; severity: string; status: string; title: string }>;
  budget?: { throttle: string; tokens: number; cap: number };
  quiet: boolean;
}

export function buildOrganizationRetro(
  scope: OrganizationScopeRef,
  since: Date,
  deps: OrganizationRetroDeps = {},
  options: { timezone?: string } = {}
): OrganizationRetro {
  const now = deps.now?.() ?? new Date();
  const inWindow = (iso: string | undefined) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(at) && at >= since.getTime() && at <= now.getTime();
  };
  const tenant = cadenceTenant(scope);
  const charters = organizationDotCharters(scope, deps);
  const dotIds = new Set(charters.map((charter) => charter.dot_id));

  const outcomes = { improved: 0, no_change: 0, regressed: 0, unmeasurable: 0, success_percent: 0 };
  for (const charter of charters) {
    const rows = deps.readOutcomes
      ? deps.readOutcomes(charter)
      : readOutcomesTolerant(charter, deps.rootDir);
    for (const row of rows) {
      if (inWindow(row.measured_at) && row.verdict in outcomes) outcomes[row.verdict] += 1;
    }
  }
  const judged = outcomes.improved + outcomes.no_change + outcomes.regressed;
  outcomes.success_percent = judged === 0 ? 0 : Math.round((outcomes.improved / judged) * 100);

  const rejections = organizationActions(dotIds, deps)
    .filter((row) => (row.status === 'refused' || row.status === 'declined') && inWindow(row.at))
    .map((row) => ({
      dot_id: row.dot_id,
      status: row.status as 'refused' | 'declined',
      title: truncateText(row.title),
      reason: truncateText(row.reason ?? row.rationale ?? ''),
    }));

  const incidents = (
    deps.listIncidents ??
    ((s: OrganizationScopeRef) =>
      listOrganizationIncidents({
        organizationId: s.organizationId,
        tier: s.tier,
        tenantSlug: s.tenantSlug,
        rootDir: deps.rootDir,
      }))
  )(scope)
    .filter((entry) => inWindow(entry.created_at))
    .map((entry) => ({
      incident_id: entry.incident_id,
      severity: entry.severity,
      status: entry.status,
      title: truncateText(entry.title),
    }));

  let budget: OrganizationRetro['budget'];
  try {
    const evaluation = (
      deps.evaluateBudget ??
      ((s: OrganizationScopeRef) =>
        evaluateBudgetThrottle(
          {
            ...(cadenceTenant(s) ? { tenant_slug: cadenceTenant(s) } : {}),
            organization_id: s.organizationId,
          },
          { rootDir: deps.rootDir, now: () => now }
        ))
    )(scope);
    if (evaluation) {
      budget = {
        throttle: evaluation.throttle,
        tokens: evaluation.usage.tokens,
        cap: evaluation.cap.daily_token_cap,
      };
    }
  } catch {
    budget = undefined;
  }

  const objectives = objectiveProgressChanges(scope, since, deps);
  const retro: OrganizationRetro = {
    kind: 'organization_retro',
    generated_at: now.toISOString(),
    since: since.toISOString(),
    timezone: options.timezone ?? ORGANIZATION_CADENCE_DEFAULT_TIMEZONE,
    organization_id: scope.organizationId,
    tier: scope.tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
    objectives,
    outcomes,
    rejections,
    incidents,
    ...(budget ? { budget } : {}),
    quiet: false,
  };
  retro.quiet =
    objectives.every((o) => o.after === undefined) &&
    judged + outcomes.unmeasurable === 0 &&
    rejections.length === 0 &&
    incidents.length === 0 &&
    (!budget || budget.throttle === 'normal');
  return retro;
}

export function renderOrganizationRetroText(
  retro: OrganizationRetro,
  organizationName: string,
  locale: SupportedLocale = ORGANIZATION_CADENCE_DEFAULT_LOCALE
): string {
  const tr = (key: VocabularyKey, params?: MessageParams) => t(key, params, locale);
  const more = (count: number) => tr('organization_cadence_more', { count });
  const header = tr('organization_retro_header', {
    name: organizationName,
    since: new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
      timeZone: retro.timezone,
      month: 'numeric',
      day: 'numeric',
    }).format(new Date(retro.since)),
  });
  if (retro.quiet) return `${header}\n${tr('organization_retro_quiet')}`;
  const o = retro.outcomes;
  const blocks = [
    cadenceSection(
      tr('organization_retro_section_objectives'),
      retro.objectives
        .filter((row) => row.after !== undefined)
        .map((row) =>
          row.delta === undefined
            ? tr('organization_retro_objective_line_new', { title: row.title, to: row.after ?? 0 })
            : tr('organization_retro_objective_line', {
                title: row.title,
                to: row.after ?? 0,
                delta: `${row.delta > 0 ? '+' : ''}${row.delta}`,
              })
        ),
      more
    ),
    o.improved + o.no_change + o.regressed + o.unmeasurable > 0
      ? cadenceSection(
          tr('organization_retro_section_outcomes'),
          [
            tr('organization_retro_outcome_line', {
              improved: o.improved,
              no_change: o.no_change,
              regressed: o.regressed,
              unmeasurable: o.unmeasurable,
              rate: o.success_percent,
            }),
          ],
          more
        )
      : [],
    cadenceSection(
      tr('organization_retro_section_rejections'),
      retro.rejections.map((row) =>
        tr('organization_retro_rejection_line', {
          status: row.status,
          dot: row.dot_id,
          title: row.title,
          reason: row.reason || '-',
        })
      ),
      more
    ),
    cadenceSection(
      tr('organization_retro_section_incidents'),
      retro.incidents.map((row) =>
        tr('organization_retro_incident_line', {
          severity: row.severity,
          title: row.title,
          status: row.status,
        })
      ),
      more
    ),
    retro.budget && retro.budget.throttle !== 'normal'
      ? cadenceSection(
          tr('organization_retro_section_budget'),
          [
            tr('organization_retro_budget_line', {
              throttle: retro.budget.throttle,
              tokens: retro.budget.tokens,
              cap: retro.budget.cap,
            }),
          ],
          more
        )
      : [],
  ].filter((block) => block.length > 0);
  return [header, ...blocks.map((block) => block.join('\n'))].join('\n\n');
}

export interface RunOrganizationRetroOptions {
  /** Days of history to review (default 7). */
  sinceDays?: number;
  timezone?: string;
  locale?: SupportedLocale;
  tiers?: OrganizationTier[];
  persist?: boolean;
  env?: Record<string, string | undefined>;
}

export interface OrganizationRetroRun {
  retros: Array<{ retro: OrganizationRetro; text: string; persistence?: CadencePersistence }>;
  organization_count: number;
  reported_count: number;
  text: string;
}

/** Governed retro sweep over every organization (sovereign-only, audited). */
export function runOrganizationRetro(
  options: RunOrganizationRetroOptions = {},
  deps: OrganizationRetroDeps & {
    listOrganizations?: (tier: OrganizationTier) => OrganizationScopeRef[];
  } = {}
): OrganizationRetroRun {
  const persona = assertSovereignCadencePersona('retro', options.env);
  const now = deps.now?.() ?? new Date();
  const timezone = options.timezone ?? ORGANIZATION_CADENCE_DEFAULT_TIMEZONE;
  const locale = options.locale ?? ORGANIZATION_CADENCE_DEFAULT_LOCALE;
  const days = options.sinceDays && options.sinceDays > 0 ? options.sinceDays : 7;
  const since = new Date(now.getTime() - days * DAY_MS);
  const tiers = options.tiers ?? ['confidential', 'public'];
  const retros: OrganizationRetroRun['retros'] = [];
  let organizationCount = 0;
  for (const tier of tiers) {
    const scopes = deps.listOrganizations?.(tier) ?? listOrganizationScopes({ tier }, deps.rootDir);
    for (const scope of scopes) {
      organizationCount += 1;
      const retro = buildOrganizationRetro(scope, since, { ...deps, now: () => now }, { timezone });
      if (retro.quiet) continue;
      const name = organizationDisplayName(scope);
      const text = renderOrganizationRetroText(retro, name, locale);
      const persistence =
        options.persist === false
          ? undefined
          : persistOrganizationCadenceReport({
              scope,
              kind: 'retro',
              content: retro as unknown as Record<string, unknown>,
              text,
              organizationName: name,
              now,
              timezone,
              deps,
            });
      retros.push({ retro, text, ...(persistence ? { persistence } : {}) });
    }
  }
  (deps.audit ?? ((entry) => auditChain.record(entry)))({
    agentId: persona,
    action: 'organization.retro',
    operation: 'retro:cross_tenant',
    result: 'completed',
    metadata: { tiers, organization_count: organizationCount, reported_count: retros.length },
  });
  return {
    retros,
    organization_count: organizationCount,
    reported_count: retros.length,
    text: retros.map((entry) => entry.text).join('\n\n'),
  };
}
