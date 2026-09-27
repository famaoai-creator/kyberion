/**
 * Select the execution surface for one mission WorkItem.
 *
 * Mission governance and WorkItem ownership stay independent from the live
 * execution surface. A short-lived WorkItem can use a CLI subagent while a
 * durable or failure-sensitive WorkItem uses agent-runtime. Hybrid keeps the
 * initial dispatch lightweight and records the conditions that justify an
 * escalation.
 */

export const MISSION_EXECUTION_SURFACES = ['cli_subagent', 'agent_runtime', 'hybrid'] as const;

export type MissionExecutionSurface = (typeof MISSION_EXECUTION_SURFACES)[number];

export const MISSION_EXECUTION_SURFACE_AXES = [
  'expected_duration',
  'write_volume',
  'recovery_requirement',
  'failure_isolation',
  'approval_kill_switch',
  'model_diversity',
] as const;

export type MissionExecutionSurfaceAxis = (typeof MISSION_EXECUTION_SURFACE_AXES)[number];
export type MissionExecutionSurfaceScore = 0 | 1 | 2 | 3;

export interface MissionExecutionSurfaceSignals {
  expected_duration?: MissionExecutionSurfaceScore;
  write_volume?: MissionExecutionSurfaceScore;
  recovery_requirement?: MissionExecutionSurfaceScore;
  failure_isolation?: MissionExecutionSurfaceScore;
  approval_kill_switch?: MissionExecutionSurfaceScore;
  model_diversity?: MissionExecutionSurfaceScore;
}

export interface MissionExecutionSurfaceDecision {
  surface: MissionExecutionSurface;
  active_surface: 'cli_subagent' | 'agent_runtime';
  selected_by: 'explicit' | 'rubric';
  max_score: MissionExecutionSurfaceScore;
  signals: MissionExecutionSurfaceSignals;
  escalation_axes: MissionExecutionSurfaceAxis[];
  rationale: string;
}

const SURFACE_ALIASES: Record<string, MissionExecutionSurface> = {
  cli_subagent: 'cli_subagent',
  'cli-subagent': 'cli_subagent',
  subagent: 'cli_subagent',
  agent_runtime: 'agent_runtime',
  'agent-runtime': 'agent_runtime',
  runtime: 'agent_runtime',
  hybrid: 'hybrid',
};

export function normalizeMissionExecutionSurface(
  value: unknown
): MissionExecutionSurface | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized && normalized !== 'auto' ? SURFACE_ALIASES[normalized] : undefined;
}

function normalizeScore(value: unknown): MissionExecutionSurfaceScore {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  if (value >= 1) return 1;
  return 0;
}

function normalizeSignals(
  input?: Partial<Record<MissionExecutionSurfaceAxis, unknown>>
): MissionExecutionSurfaceSignals {
  const signals = {} as MissionExecutionSurfaceSignals;
  for (const axis of MISSION_EXECUTION_SURFACE_AXES) {
    const score = normalizeScore(input?.[axis]);
    if (score > 0) signals[axis] = score;
  }
  return signals;
}

export function resolveMissionExecutionSurface(
  input: {
    requested?: unknown;
    signals?: Partial<Record<MissionExecutionSurfaceAxis, unknown>>;
  } = {}
): MissionExecutionSurfaceDecision {
  const explicit = normalizeMissionExecutionSurface(input.requested);
  const requestedText =
    input.requested === undefined || input.requested === null
      ? ''
      : String(input.requested).trim().toLowerCase();
  if (
    input.requested !== undefined &&
    input.requested !== null &&
    (!requestedText || (requestedText !== 'auto' && !explicit))
  ) {
    throw new Error(
      `[EXECUTION_SURFACE_INVALID] unsupported execution surface '${String(input.requested)}'`
    );
  }
  const signals = normalizeSignals(input.signals);
  const scoredAxes = MISSION_EXECUTION_SURFACE_AXES.map((axis) => ({
    axis,
    score: signals[axis] || 0,
  }));
  const maxScore = Math.max(
    ...scoredAxes.map((entry) => entry.score)
  ) as MissionExecutionSurfaceScore;
  const escalationAxes = scoredAxes.filter((entry) => entry.score >= 2).map((entry) => entry.axis);

  if (explicit) {
    return {
      surface: explicit,
      active_surface: explicit === 'agent_runtime' ? 'agent_runtime' : 'cli_subagent',
      selected_by: 'explicit',
      max_score: maxScore,
      signals,
      escalation_axes: escalationAxes,
      rationale: `explicit execution surface '${explicit}' was requested`,
    };
  }

  const surface: MissionExecutionSurface =
    maxScore >= 3 ? 'agent_runtime' : maxScore >= 2 ? 'hybrid' : 'cli_subagent';
  return {
    surface,
    active_surface: surface === 'agent_runtime' ? 'agent_runtime' : 'cli_subagent',
    selected_by: 'rubric',
    max_score: maxScore,
    signals,
    escalation_axes: escalationAxes,
    rationale:
      surface === 'agent_runtime'
        ? 'at least one execution-surface axis requires runtime isolation or durable recovery'
        : surface === 'hybrid'
          ? 'the WorkItem has escalation signals but no hard runtime-forcing axis'
          : 'all execution-surface axes remain session-bounded and do not require agent-runtime',
  };
}
