/**
 * Setup checklist — the first-run sequence the settings page (はじめに) and the
 * Home dashboard show while setup is incomplete (MSN-SHELL-IA-20261105 §4).
 *
 * The order is fixed: identity & tenant → reasoning backend → autonomy &
 * approval policy → notification channel → first project & goal → budget →
 * trial mission. Each step's completion is derived from state that already
 * exists; nothing here writes, and a signal that could not be read reports
 * `unknown` instead of pretending the step is done or missing.
 *
 * `buildSetupChecklist` is pure. `collectSetupChecklistSignals` reads the
 * signals for a server-resolved viewer; every reader is injectable for tests.
 */

import { readInstalledReasoningMode } from '../reasoning/installed-reasoning-mode.js';
import { loadSpendPolicy, resolveSpendPolicyForTenant } from '../spend-guard.js';
import { loadNotificationPreferences } from './operator-notifications.js';
import { findActiveCharter } from '../governance/accountability-charter-registry.js';
import type { WorkspaceGraph } from './workspace-graph.js';
import type { SetupBudgetSummary, SetupChecklistSignals } from './setup-checklist-model.js';

export * from './setup-checklist-model.js';

export interface SetupChecklistReaders {
  reasoningMode(): string | null;
  charterInForce(tenantSlug: string, now: Date): boolean;
  notificationChannel(): boolean;
  budget(tenantSlug: string | undefined): SetupBudgetSummary;
}

export const defaultSetupChecklistReaders: SetupChecklistReaders = {
  reasoningMode: () => readInstalledReasoningMode() ?? 'not-installed',
  charterInForce: (tenant, now) =>
    findActiveCharter({ kind: 'organization', tenant_slug: tenant }, now) !== null,
  notificationChannel: () => Boolean(loadNotificationPreferences().default_channel),
  budget: (tenant) => {
    const base = loadSpendPolicy();
    const effective = resolveSpendPolicyForTenant(base, tenant);
    return {
      posture: effective.posture,
      daily_cap_usd: effective.daily_cap_usd,
      mission_cap_usd: effective.mission_cap_usd,
      uses_default: !(tenant && base.tenant_overrides?.[tenant]),
    };
  },
};

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * Signals for a viewer whose workspace graph is already filtered to its
 * server-resolved scope: tenants, projects and missions are counted from that
 * graph, so a client parameter can never widen what is counted.
 */
export function collectSetupChecklistSignals(
  graph: WorkspaceGraph,
  readers: SetupChecklistReaders = defaultSetupChecklistReaders,
  now: Date = new Date()
): SetupChecklistSignals {
  const count = (kind: string) => graph.nodes.filter((node) => node.kind === kind).length;
  const tenants = graph.nodes.filter((node) => node.kind === 'tenant').map((node) => node.id);
  const charter =
    tenants.length === 0
      ? false
      : attempt(() => tenants.some((tenant) => readers.charterInForce(tenant, now)));
  return {
    visibleTenants: tenants.length,
    reasoningMode: attempt(() => readers.reasoningMode()),
    charterInForce: charter,
    notificationChannel: attempt(() => readers.notificationChannel()),
    projects: count('project'),
    missions: count('mission'),
    budget: attempt(() => readers.budget(tenants.length === 1 ? tenants[0] : undefined)),
  };
}
