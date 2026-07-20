// AR-02: self-described op catalog — the single source the registry and
// discovery index are generated from. Keep in sync with the dispatch switch
// in agent-actuator-helpers.ts; check:op-registry fails on drift.
//
// Kind notes: ops that previously classified via the shared pools keep their
// historical kind (e.g. list -> capture) so step-type inference does not
// change; every other op previously made determineActuatorStepType throw, so
// those entries are strictly additive.

type OpSpecKind = 'capture' | 'transform' | 'apply' | 'control';

export const AGENT_ACTUATOR_CAPTURE_OPS = [
  'list',
  'list_manifests',
  'list_runtimes',
  'health',
  'snapshot',
] as const;

export const AGENT_ACTUATOR_TRANSFORM_OPS = ['team_plan', 'team_role'] as const;

export const AGENT_ACTUATOR_APPLY_OPS = [
  'spawn',
  'ask',
  'delegate',
  'shutdown',
  'shutdown_all',
  'refresh',
  'restart',
  'a2a',
  'staff_mission',
  'prewarm_mission',
] as const;

function toSpec(op: string, kind: OpSpecKind) {
  return { op, kind };
}

export function describeOps() {
  return [
    ...AGENT_ACTUATOR_CAPTURE_OPS.map((op) => toSpec(op, 'capture')),
    ...AGENT_ACTUATOR_TRANSFORM_OPS.map((op) => toSpec(op, 'transform')),
    ...AGENT_ACTUATOR_APPLY_OPS.map((op) => toSpec(op, 'apply')),
  ];
}
