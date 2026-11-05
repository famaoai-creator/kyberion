/**
 * Setup checklist model — pure, browser-safe (no node imports): the step
 * order, the settings card each step opens, estimates and the builder.
 * Readers live in `setup-checklist.ts`. See that file for the contract.
 */

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
