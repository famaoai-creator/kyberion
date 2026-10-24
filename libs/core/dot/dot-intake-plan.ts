/**
 * Intake activation table — one read-only answer to "what is watching what,
 * what wakes this dot, and what may it do about it?".
 *
 * This is deliberately derived, never a second registry: the charter's own
 * `attention.triggers`, the governed intake policy and the durable feed/coverage
 * state are the sources of truth. A binding table that duplicated them would
 * drift the first time a charter changed.
 *
 * A row is `pull` when the charter declares a `feed` trigger (Kyberion fetches)
 * and `push` when it declares an `event` trigger (the source delivers). The
 * table reports what the runtime can actually prove: declaration, tenant
 * binding, host enablement, last successful poll. It never claims a backlog.
 */

import type { DotCharter, DotCharterStatus, DotFeedTrigger } from './dot-charter.js';
import type { EventIntakePolicy } from './dot-event-intake.js';
import { readDotFeedCoverage, feedSpecId, type DotFeedCoverage } from './dot-feed-source.js';
import type { DotRuntimeDeps } from './dot-runtime.js';

export type IntakeEnabledBy = 'policy' | 'host_opt_in' | 'tenant_overlay' | 'disabled';

export interface DotIntakeRow {
  dot_id: string;
  charter_status: DotCharterStatus;
  tier: string;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mode: 'push' | 'pull';
  source: string;
  source_declared: boolean;
  source_enabled: boolean;
  enabled_by: IntakeEnabledBy;
  source_tenant?: string;
  tenant_ok: boolean;
  /** Event types accepted (push) or emitted by the feed (pull). */
  types: string[];
  feed?: {
    spec_id: string;
    service_id: string;
    action: string;
    every_s: number;
    coverage: DotFeedCoverage;
  };
  authority_role: string;
  work_shapes: string[];
  decision: string;
  goal: string;
  /** True when a new item can actually produce a wake right now. */
  armed: boolean;
  warnings: string[];
}

export interface DotIntakePlan {
  rows: DotIntakeRow[];
  declared_sources: Array<{
    id: string;
    enabled: boolean;
    local_only: boolean;
    tenant_slug?: string;
  }>;
  warnings: string[];
  notes: string[];
}

function parseHostOptIn(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function enabledBy(
  id: string,
  source: { enabled: boolean; local_only?: true },
  hostOptIn: readonly string[]
): IntakeEnabledBy {
  if (source.local_only) return 'tenant_overlay';
  if (hostOptIn.includes(id)) return 'host_opt_in';
  return source.enabled ? 'policy' : 'disabled';
}

function mergeTypes(into: string[], add: readonly string[]): void {
  for (const type of add) if (!into.includes(type)) into.push(type);
}

/**
 * Build the intake plan. `hostOptIn` is the raw `KYBERION_EVENT_INTAKE_SOURCES`
 * value (already applied to `policy`), so the table can name the enablement
 * path instead of only saying "enabled".
 */
export function describeDotIntakePlan(input: {
  charters: readonly DotCharter[];
  policy: EventIntakePolicy;
  hostOptIn?: string;
  rootDir?: string;
  now?: Date;
}): DotIntakePlan {
  const hostOptIn = parseHostOptIn(input.hostOptIn);
  const deps: DotRuntimeDeps = { rootDir: input.rootDir, now: () => input.now ?? new Date() };
  const now = input.now ?? new Date();
  const rows: DotIntakeRow[] = [];
  const planWarnings: string[] = [];

  for (const charter of input.charters) {
    const coverages = new Map<string, DotFeedCoverage>(
      readDotFeedCoverage(charter, deps, now).map((coverage) => [coverage.spec_id, coverage])
    );
    // One row per (mode, source); duplicate triggers only extend the type list.
    const byKey = new Map<string, DotIntakeRow>();

    const base = {
      dot_id: charter.dot_id,
      charter_status: charter.status,
      tier: charter.scope.tier,
      ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
      ...(charter.scope.organization_id ? { organization_id: charter.scope.organization_id } : {}),
      ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
      authority_role: charter.authority.authority_role,
      work_shapes: [...(charter.authority.allowed_work_shapes ?? ['direct_reply'])],
      decision: charter.decisions?.default_decision ?? 'notify',
      goal: charter.goal.statement,
    };

    const addRow = (
      mode: 'push' | 'pull',
      source: string,
      types: string[],
      feed?: DotIntakeRow['feed']
    ): DotIntakeRow => {
      const key = `${mode}:${source}`;
      const existing = byKey.get(key);
      if (existing) {
        mergeTypes(existing.types, types);
        return existing;
      }
      const sourcePolicy = Object.prototype.hasOwnProperty.call(input.policy.sources, source)
        ? input.policy.sources[source]
        : undefined;
      const sourceTenant = sourcePolicy?.tenant_slug ?? undefined;
      const charterTenant = charter.scope.tenant_slug ?? undefined;
      const tenantOk = Boolean(sourcePolicy) && sourceTenant === charterTenant;
      const enabledByValue = sourcePolicy
        ? enabledBy(source, sourcePolicy, hostOptIn)
        : ('disabled' as const);
      // A pull feed ingests locally and does not need the webhook enabled; a
      // push source cannot deliver unless this host accepts it.
      const sourceEnabled = Boolean(sourcePolicy) && (mode === 'pull' || sourcePolicy.enabled);
      const warnings: string[] = [];
      if (!sourcePolicy) {
        warnings.push(`source '${source}' is not declared in the intake policy`);
      } else if (!tenantOk) {
        warnings.push(
          `source is bound to tenant '${sourceTenant ?? '(system)'}' but the charter is '${charterTenant ?? '(system)'}'`
        );
      }
      if (mode === 'push' && sourcePolicy && !sourcePolicy.enabled) {
        warnings.push(
          'source is disabled on this host — enable it in event-intake-policy.json or KYBERION_EVENT_INTAKE_SOURCES'
        );
      }
      if (charter.status !== 'active') {
        warnings.push(`charter is ${charter.status}; nothing wakes until it is activated`);
      }
      if (feed && (feed.coverage.state === 'stalled' || feed.coverage.state === 'failing')) {
        warnings.push(`feed ${feed.coverage.state}: ${feed.coverage.detail}`);
      }
      const armed =
        charter.status === 'active' &&
        Boolean(sourcePolicy) &&
        tenantOk &&
        (mode === 'pull' || sourcePolicy.enabled);
      const row: DotIntakeRow = {
        ...base,
        mode,
        source,
        source_declared: Boolean(sourcePolicy),
        source_enabled: sourceEnabled,
        enabled_by: enabledByValue,
        ...(sourceTenant ? { source_tenant: sourceTenant } : {}),
        tenant_ok: tenantOk,
        types,
        ...(feed ? { feed } : {}),
        armed,
        warnings,
      };
      byKey.set(key, row);
      rows.push(row);
      return row;
    };

    for (const trigger of charter.attention.triggers) {
      if (trigger.kind === 'event') {
        addRow('push', trigger.sources[0] ?? '(invalid)', trigger.types ?? []);
        // A multi-source trigger still gets one row per source.
        for (const source of trigger.sources.slice(1)) {
          addRow('push', source, trigger.types ?? []);
        }
      } else if (trigger.kind === 'feed') {
        const specId = feedSpecId(trigger as DotFeedTrigger);
        const coverage = coverages.get(specId);
        addRow('pull', trigger.source, [trigger.event_type ?? 'feed'], {
          spec_id: specId,
          service_id: trigger.service_id,
          action: trigger.action,
          every_s: trigger.every_s ?? 300,
          coverage: coverage ?? {
            spec_id: specId,
            source: trigger.source,
            service_id: trigger.service_id,
            action: trigger.action,
            event_type: trigger.event_type ?? 'feed',
            state: 'never_polled',
            consecutive_failures: 0,
            ingested: 0,
            duplicates: 0,
            capped_polls: 0,
            detail: 'no feed state recorded yet',
          },
        });
      }
    }

    // A push trigger for a source no feed/event row covers is already visible
    // above; the cross-check that matters is pull-without-push, which the
    // charter validator rejects. Keep a defensive plan warning for charters
    // loaded from older runtimes.
    const pullSources = new Set(
      charter.attention.triggers.filter((t) => t.kind === 'feed').map((t) => t.source)
    );
    const pushSources = new Set(
      charter.attention.triggers.filter((t) => t.kind === 'event').flatMap((t) => t.sources)
    );
    for (const source of pullSources) {
      if (!pushSources.has(source)) {
        planWarnings.push(
          `${charter.dot_id}: feed source '${source}' has no event trigger — items would be ingested without waking anything`
        );
      }
    }
  }

  const declared = Object.entries(input.policy.sources).map(([id, source]) => ({
    id,
    enabled: source.enabled,
    local_only: source.local_only === true,
    ...(source.tenant_slug ? { tenant_slug: source.tenant_slug } : {}),
  }));

  return {
    rows,
    declared_sources: declared.sort((a, b) => a.id.localeCompare(b.id)),
    warnings: planWarnings,
    notes: [
      'A feed never wakes a dot by itself: fetched items are ingested as normal intake events, and the matching event trigger wakes the dot.',
      'Coverage is an observation, not a backlog count — it proves the last successful poll, not what the provider did not return.',
      'Push sources need the HMAC secret in the secret store; pull feeds need the service binding the preset uses.',
    ],
  };
}
