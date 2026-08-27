import type { IntentContract, IntentDeliveryDecision } from './intent-contract-types.js';

export function deriveIntentDeliveryDecision(contract: IntentContract): IntentDeliveryDecision {
  const durableShape =
    contract.resolution.execution_shape === 'project_bootstrap' ||
    contract.resolution.execution_shape === 'mission';
  const managedProgram = contract.delivery_mode === 'managed_program';
  const askHumanToConfirm =
    managedProgram &&
    contract.resolution.execution_shape === 'task_session' &&
    !contract.clarification_needed;
  const decisionRules: Array<{
    when: () => boolean;
    rationale: string;
    decision: Omit<IntentDeliveryDecision, 'mode' | 'rationale'>;
  }> = [
    {
      when: () => askHumanToConfirm,
      rationale:
        'The request implies durable program management, but the current execution shape still needs a human confirmation before bootstrap.',
      decision: {
        shouldBootstrapProject: true,
        shouldStartMission: true,
        shouldDeliverDirectOutcome: false,
        askHumanToConfirm: true,
      },
    },
    {
      when: () => managedProgram,
      rationale:
        'The request appears to require durable governance across revisions, work items, or staged outcomes.',
      decision: {
        shouldBootstrapProject: contract.resolution.execution_shape === 'project_bootstrap',
        shouldStartMission: true,
        shouldDeliverDirectOutcome: false,
        askHumanToConfirm: false,
      },
    },
    {
      when: () => true,
      rationale:
        'The request appears satisfiable as a single direct outcome without durable project scaffolding.',
      decision: {
        shouldBootstrapProject: false,
        shouldStartMission: false,
        shouldDeliverDirectOutcome: !durableShape,
        askHumanToConfirm: false,
      },
    },
  ];
  const matchedRule = decisionRules.find((rule) => rule.when())!;
  return {
    mode: contract.delivery_mode,
    ...matchedRule.decision,
    rationale: matchedRule.rationale,
  };
}
