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

import { getInstalledReasoningMode } from '../reasoning/reasoning-bootstrap.js';
import { loadSpendPolicy, resolveSpendPolicyForTenant } from '../spend-guard.js';
import { loadNotificationPreferences } from './operator-notifications.js';
import { findActiveCharter } from '../governance/accountability-charter-registry.js';
import type { WorkspaceGraph } from './workspace-graph.js';

export const SETUP_CHECKLIST_ORDER = [
  'identity',
  'reasoning',
  'autonomy',
  'notifications',
  'first_project',
  'budget',
  'trial_mission',
] as const;
export type SetupChecklistStepId = (typeof SETUP_CHECKLIST_ORDER)[number];

/**
 * The `/settings#<anchor>` card that completes each step. These ids are a
 * stable contract: the Home dashboard and the command palette link to them.
 */
export const SETUP_CHECKLIST_ANCHORS: Record<SetupChecklistStepId, string> = {
  identity: 'settings-members',
  reasoning: 'settings-reasoning',
  autonomy: 'settings-authority',
  notifications: 'setup-notifications',
  first_project: 'settings-projects',
  budget: 'settings-budget',
  trial_mission: 'settings-trial-mission',
};

/** A rough, honest estimate shown next to each step. */
export const SETUP_CHECKLIST_MINUTES: Record<SetupChecklistStepId, number> = {
  identity: 3,
  reasoning: 5,
  autonomy: 5,
  notifications: 2,
  first_project: 5,
  budget: 2,
  trial_mission: 10,
};

export type SetupChecklistStatus = 'done' | 'todo' | 'unknown';

export interface SetupChecklistStep {
  id: SetupChecklistStepId;
  status: SetupChecklistStatus;
  /** Settings card id (without `#`). */
  anchor: string;
  estimate_minutes: number;
}

export interface SetupBudgetSummary {
  posture: 'warn' | 'block';
  daily_cap_usd: number;
  mission_cap_usd: number;
  /** True when the caps come from the shipped defaults, not a tenant override. */
  uses_default: boolean;
}

export interface SetupChecklist {
  steps: SetupChecklistStep[];
  done: number;
  total: number;
  complete: boolean;
  /** The first step that is not done, in the required order. */
  next?: SetupChecklistStepId;
  budget?: SetupBudgetSummary;
}

/** `null` means the signal could not be read. */
export interface SetupChecklistSignals {
  visibleTenants: number | null;
  reasoningMode: string | null;
  charterInForce: boolean | null;
  notificationChannel: boolean | null;
  projects: number | null;
  missions: number | null;
  budget: SetupBudgetSummary | null;
}

const NOT_READY_REASONING = new Set(['', 'not-installed', 'stub', 'unknown']);

function statusOf(value: boolean | null): SetupChecklistStatus {
  return value === null ? 'unknown' : value ? 'done' : 'todo';
}

export function buildSetupChecklist(signals: SetupChecklistSignals): SetupChecklist {
  const done: Record<SetupChecklistStepId, boolean | null> = {
    identity: signals.visibleTenants === null ? null : signals.visibleTenants > 0,
    reasoning:
      signals.reasoningMode === null ? null : !NOT_READY_REASONING.has(signals.reasoningMode),
    autonomy: signals.charterInForce,
    notifications: signals.notificationChannel,
    first_project: signals.projects === null ? null : signals.projects > 0,
    // Caps always exist (shipped defaults), so the step is done once a budget
    // is in force; the summary says whether it is still the default.
    budget: signals.budget === null ? null : signals.budget.daily_cap_usd > 0,
    trial_mission: signals.missions === null ? null : signals.missions > 0,
  };
  const steps = SETUP_CHECKLIST_ORDER.map((id) => ({
    id,
    status: statusOf(done[id]),
    anchor: SETUP_CHECKLIST_ANCHORS[id],
    estimate_minutes: SETUP_CHECKLIST_MINUTES[id],
  }));
  const doneCount = steps.filter((step) => step.status === 'done').length;
  const next = steps.find((step) => step.status !== 'done')?.id;
  return {
    steps,
    done: doneCount,
    total: steps.length,
    complete: doneCount === steps.length,
    ...(next ? { next } : {}),
    ...(signals.budget ? { budget: signals.budget } : {}),
  };
}

export interface SetupChecklistReaders {
  reasoningMode(): string | null;
  charterInForce(tenantSlug: string, now: Date): boolean;
  notificationChannel(): boolean;
  budget(tenantSlug: string | undefined): SetupBudgetSummary;
}

export const defaultSetupChecklistReaders: SetupChecklistReaders = {
  reasoningMode: () => getInstalledReasoningMode() ?? 'not-installed',
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
