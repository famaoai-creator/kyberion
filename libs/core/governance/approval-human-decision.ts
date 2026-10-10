/**
 * The human-only final-decision contract (`accountability.finalDecision:
 * 'human_only'`), shared by the approval store and the consumers that re-check
 * a decision before applying it.
 */
import type {
  ApprovalAccountability,
  ApprovalRecord,
  ApprovalRequestRecord,
} from './approval-store.js';
import { auditChain } from './audit-chain.js';
import { notifyOperator } from '../surface/operator-notifications.js';
import { detectAgentExecutionContext } from '../agent-execution-context.js';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import {
  approvalPresentedDigestMatches,
  computeApprovalPresentedDigest,
} from './approval-presentation.js';
import {
  assuranceMeets,
  assuranceOfAuthMethod,
  DEFAULT_HUMAN_ONLY_MIN_ASSURANCE,
  isApprovalAssuranceLevel,
  NON_HUMAN_PROOF_AUTH_METHODS,
  resolveApprovalAssuranceMode,
  type ApprovalAssuranceMode,
  type ApprovalAssuranceShortfall,
} from './approval-assurance.js';

/**
 * HA-02: agent-facing decision paths (MCP `kyberion.approval.decide`, the
 * approval-actuator `decide` op) cannot prove a human decider, so they never
 * settle a human-only request — approve or reject — in any rollout mode.
 */
export function refuseHumanOnlyDecisionOnAgentPath(
  record: { id: string; accountability?: ApprovalAccountability },
  path: string
): void {
  if (record.accountability?.finalDecision !== 'human_only') return;
  throw new Error(
    `[APPROVAL_HUMAN_PROOF_REQUIRED] ${path} cannot decide human-only approval ${record.id} — an agent-facing path cannot prove a human decider ` +
      '| next: decide it in a signed-in Concierge or Chronos session, or answer the terminal challenge from your own terminal outside the agent session ' +
      `| evidence: accountability.finalDecision=human_only on ${record.id}`
  );
}

/**
 * `SYSTEM_ROLE` of the surface servers that decide for a person they
 * authenticated themselves (surface_runtime sets it, `buildSurfaceLaunchEnv`).
 * Such a server inherits the environment of whoever launched it — an agent
 * session that ran `pnpm surfaces start` included — so its environment says
 * nothing about the decider; the principal the route resolved does. Agent-facing
 * surfaces (MCP, terminal-bridge, nexus-daemon, …) are deliberately absent.
 */
export const HUMAN_DECISION_SURFACE_SYSTEM_ROLES: ReadonlySet<string> = new Set([
  'chronos_mirror_v2',
  'concierge',
  'presence_studio',
  'operator_surface',
  'slack_bridge',
  'telegram_bridge',
  'discord_bridge',
  'imessage_bridge',
]);

export type ApprovalDeciderPrincipal = Pick<
  ResolvedPrincipal,
  'actor' | 'source' | 'provider' | 'principalId'
>;

/**
 * Store-level refusal: a human-only request is never settled by a process
 * acting for an agent, whatever the caller declares. A human-decision surface
 * server is exempt from its inherited environment markers, but not from an
 * agent principal its route resolved. Environment markers are advisory (an
 * agent can clear them); this stops the agent that does not.
 */
export function refuseHumanOnlyDecisionByAgentProcess(
  record: { id: string; accountability?: ApprovalAccountability },
  options: {
    principal?: ApprovalDeciderPrincipal | null;
    env?: Record<string, string | undefined>;
  } = {}
): void {
  if (record.accountability?.finalDecision !== 'human_only') return;
  const env = options.env ?? process.env;
  const context = detectAgentExecutionContext({ env, principal: options.principal ?? null });
  if (!context.isAgent) return;
  const agentPrincipal = context.signals.some((signal) => signal.kind === 'agent_principal');
  const systemRole = getRegisteredEnvText('SYSTEM_ROLE', { env })?.trim() ?? '';
  if (!agentPrincipal && HUMAN_DECISION_SURFACE_SYSTEM_ROLES.has(systemRole)) return;
  const evidence = context.signals
    .map((signal) => ('env' in signal ? signal.env : `principal:${signal.provider}`))
    .join(', ');
  throw new Error(
    `[APPROVAL_HUMAN_PROOF_REQUIRED] approval store refused human-only request ${record.id} — the deciding process acts for an agent (${context.principal}) ` +
      '| next: decide it in a signed-in Concierge or Chronos session, or answer the terminal challenge from your own terminal outside the agent session ' +
      `| evidence: ${evidence}${systemRole ? `, SYSTEM_ROLE=${systemRole}` : ''}`
  );
}

export interface PresentedDecisionBinding {
  /** The effect hash / binding the decision is recorded against. */
  payloadHash?: string;
  effectBinding?: string;
  /** True when the surface's presented digest matched the stored request. */
  presentedDigestVerified: boolean;
}

/**
 * HA-06: a presented digest that matches binds the decision to the record's
 * own effect hash and binding (the digest covers both). A mismatch is refused
 * for every request. Without a digest, the caller's values are used as before.
 */
export function bindPresentedDecision(
  record: ApprovalRequestRecord,
  params: { presentedDigest?: string; payloadHash?: string; effectBinding?: string }
): PresentedDecisionBinding {
  if (params.presentedDigest === undefined) {
    return {
      payloadHash: params.payloadHash,
      effectBinding: params.effectBinding,
      presentedDigestVerified: false,
    };
  }
  if (!approvalPresentedDigestMatches(record, params.presentedDigest)) {
    throw new Error(
      `[POLICY_VIOLATION] approval decision refused — request ${record.id} changed since it was shown to the decider ` +
        '| next: reload the request and decide on what it says now ' +
        `| evidence: presented digest ${params.presentedDigest.slice(0, 16)}…, current ${computeApprovalPresentedDigest(record).slice(0, 16)}…`
    );
  }
  return {
    payloadHash: params.payloadHash ?? record.accountability?.payloadHash,
    effectBinding: params.effectBinding ?? record.accountability?.effectBinding,
    presentedDigestVerified: true,
  };
}

/**
 * HA-06 rollout: a human-only decision without a presented digest falls back
 * to the caller's own hash (self-matching). `warn` lets it through with an
 * audit entry; `enforce` refuses it.
 */
export function settleUnpresentedHumanDecision(
  record: ApprovalRequestRecord,
  binding: PresentedDecisionBinding,
  decidedBy: string,
  mode: ApprovalAssuranceMode = resolveApprovalAssuranceMode()
): void {
  if (binding.presentedDigestVerified) return;
  if (record.accountability?.finalDecision !== 'human_only') return;
  if (mode === 'enforce') {
    throw new Error(
      `[POLICY_VIOLATION] approval decision refused — human-only request ${record.id} was decided without the digest of what the decider was shown ` +
        '| next: decide it on a surface that sends the presented digest (a signed-in Concierge or Chronos session, or the terminal challenge) ' +
        '| evidence: KYBERION_APPROVAL_ASSURANCE=enforce, no presentedDigest'
    );
  }
  auditChain.record({
    agentId: decidedBy,
    action: 'approval_decision',
    operation: 'presented_digest_missing',
    result: 'allowed',
    reason: `human-only decision accepted without a presented digest — KYBERION_APPROVAL_ASSURANCE=${mode}`,
    correlationId: record.correlationId,
    metadata: { requestId: record.id, channel: record.channel },
  });
}

/**
 * Throws when the decision cannot settle a human-only request. Returns the
 * assurance shortfall a `warn`-mode decision is let through with, so the
 * caller can record it; undefined when there is none.
 *
 * `phase: 'recheck'` is for consumers re-validating an already-decided
 * record: the assurance level was judged when the decision was recorded and
 * is not re-judged (decided records are not retroactively re-graded), while
 * every other rule still applies.
 */
export function validateHumanFinalDecision(params: {
  accountability?: ApprovalAccountability;
  decidedByType?: ApprovalRecord['decidedByType'];
  authenticated?: boolean;
  authMethod?: ApprovalRecord['authMethod'];
  payloadHash?: string;
  effectBinding?: string;
  phase?: 'decision' | 'recheck';
  mode?: ApprovalAssuranceMode;
}): ApprovalAssuranceShortfall | undefined {
  if (params.accountability?.finalDecision !== 'human_only') return undefined;
  if (params.decidedByType !== 'human') {
    throw new Error('[POLICY_VIOLATION] Final approval requires a human decider');
  }
  if (params.authenticated !== true) {
    throw new Error('[POLICY_VIOLATION] Final approval requires an authenticated human decider');
  }
  if (params.authMethod && NON_HUMAN_PROOF_AUTH_METHODS.has(params.authMethod)) {
    throw new Error(
      `[POLICY_VIOLATION] Final approval requires a human-authenticated surface; ${params.authMethod} is not sufficient`
    );
  }
  let shortfall: ApprovalAssuranceShortfall | undefined;
  if (params.phase !== 'recheck') {
    const provided = assuranceOfAuthMethod(params.authMethod);
    if (!params.authMethod || !provided) {
      throw new Error(
        `[POLICY_VIOLATION] Final approval requires a recognised authMethod (got ${params.authMethod ?? 'none'})`
      );
    }
    const required = params.accountability.min_assurance ?? DEFAULT_HUMAN_ONLY_MIN_ASSURANCE;
    if (!assuranceMeets(provided, required)) {
      const mode = params.mode ?? resolveApprovalAssuranceMode();
      if (mode === 'enforce') {
        throw new Error(
          `[POLICY_VIOLATION] Final approval requires assurance ${required}; ${params.authMethod} provides ${provided}`
        );
      }
      shortfall = { required, provided, authMethod: params.authMethod, mode };
    }
  }
  if (
    params.accountability.payloadHash &&
    params.payloadHash !== params.accountability.payloadHash
  ) {
    throw new Error('[POLICY_VIOLATION] Approval payload hash does not match the requested effect');
  }
  if (
    params.accountability.effectBinding &&
    params.effectBinding !== params.accountability.effectBinding
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Approval effect binding does not match the requested operation'
    );
  }
  return shortfall;
}

export function withDefaultMinAssurance(
  accountability: ApprovalAccountability | undefined
): ApprovalAccountability | undefined {
  if (!accountability) return accountability;
  if (accountability.min_assurance === undefined) {
    return { ...accountability, min_assurance: DEFAULT_HUMAN_ONLY_MIN_ASSURANCE };
  }
  if (!isApprovalAssuranceLevel(accountability.min_assurance)) {
    throw new Error(
      `[POLICY_VIOLATION] Invalid approval min_assurance: ${String(accountability.min_assurance)}`
    );
  }
  // A requester may raise the bar for a human-only decision, never lower it.
  if (
    accountability.finalDecision === 'human_only' &&
    !assuranceMeets(accountability.min_assurance, DEFAULT_HUMAN_ONLY_MIN_ASSURANCE)
  ) {
    return { ...accountability, min_assurance: DEFAULT_HUMAN_ONLY_MIN_ASSURANCE };
  }
  return accountability;
}

/**
 * HA-03 warn rollout: a below-assurance human-only decision is let through,
 * but it must leave an audit trail and reach the operator (rate-limited per
 * auth method and level, so a surface that always falls short does not page
 * on every decision).
 */
export function reportAssuranceShortfall(
  record: { id: string; channel: string; correlationId?: string },
  shortfall: ApprovalAssuranceShortfall,
  decidedBy: string
): void {
  auditChain.record({
    agentId: decidedBy,
    action: 'approval_decision',
    operation: 'assurance_shortfall',
    result: 'allowed',
    reason: `human-only decision accepted below min_assurance ${shortfall.required} (${shortfall.authMethod} provides ${shortfall.provided}) — KYBERION_APPROVAL_ASSURANCE=${shortfall.mode}`,
    correlationId: record.correlationId,
    metadata: {
      requestId: record.id,
      channel: record.channel,
      required: shortfall.required,
      provided: shortfall.provided,
      authMethod: shortfall.authMethod,
      mode: shortfall.mode,
    },
  });
  void notifyOperator('ops_alert', {
    title: `Approval assurance shortfall (${shortfall.authMethod})`,
    body:
      `A human-only approval was accepted with ${shortfall.authMethod} (${shortfall.provided}) ` +
      `below the required ${shortfall.required}. It will be rejected once ` +
      'KYBERION_APPROVAL_ASSURANCE=enforce. Next: decide human-only requests on a surface ' +
      `that provides ${shortfall.required} before enabling enforce.`,
    correlation_id: `approval-assurance-shortfall:${shortfall.authMethod}:${shortfall.required}`,
  });
}
