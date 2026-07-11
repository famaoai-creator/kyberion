import { auditChain } from './audit-chain.js';
import { recordGovernanceAction } from './kill-switch.js';
import { policyEngine, type PolicyDecision } from './policy-engine.js';

/**
 * SA-05: fire the declarative policy engine for operation types beyond
 * file_write (which secure-io gates inline). Callers pass the operation
 * name plus whatever firing context they have; ring and delegation depth
 * are picked up from the environment so rules conditioned on them
 * (ring3-read-only, delegation-depth-limit) can actually match.
 *
 * Unmatched operations keep the policy file's default (allow), so wiring a
 * new call site is behavior-neutral until a rule targets it.
 */

/** Delegation hops taken to reach this process (0 = operator-started root). */
export function currentDelegationDepth(): number {
  const depth = Number(process.env.KYBERION_DELEGATION_DEPTH);
  return Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0;
}

/** Env block for a spawned subagent: one hop deeper than this process. */
export function childDelegationEnv(): Record<string, string> {
  return { KYBERION_DELEGATION_DEPTH: String(currentDelegationDepth() + 1) };
}

export function assertOperationPolicy(input: {
  operation: string;
  message?: string;
  context?: Record<string, unknown>;
}): PolicyDecision {
  const agentId = process.env.KYBERION_PERSONA || 'unknown';
  const ring = Number(process.env.KYBERION_AGENT_RING);
  const decision = policyEngine.evaluate({
    agentId,
    operation: input.operation,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(Number.isFinite(ring) ? { agent_ring: ring } : {}),
    ...(input.context ?? {}),
  });

  if (!decision.allowed) {
    // SA-05 Task 1: policy violations feed kill-switch anomaly detection.
    recordGovernanceAction(agentId, input.operation, 'denied', true);
    auditChain.record({
      agentId,
      action: 'policy_violation',
      operation: input.operation,
      result: 'failed',
      reason: decision.message || 'policy violation',
      metadata: {
        matched_policy: decision.matchedPolicy || '',
        ...(decision.rateLimited ? { rate_limited: true } : {}),
      },
    });
    throw new Error(
      `[POLICY_BLOCKED] ${input.operation} denied: ${decision.message || 'policy violation'}`
    );
  }
  return decision;
}
