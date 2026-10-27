export type ReasoningFailureClass =
  | 'transient'
  | 'capacity'
  | 'capability'
  | 'auth'
  | 'entitlement'
  | 'policy'
  | 'request'
  | 'cancelled'
  | 'unknown';

export interface ReasoningFailureClassification {
  class: ReasoningFailureClass;
  retryable: boolean;
  allowFailover: boolean;
  demoteProvider: boolean;
  demoteModel?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

export function classifyReasoningFailure(error: unknown): ReasoningFailureClassification {
  const message = messageOf(error);
  // A local scope/cached-client/HOME refusal is not evidence that a provider's
  // credentials failed. Never poison global health or switch tenants on retry.
  const credentialCodes = message.match(/\[CREDENTIAL_[A-Z_]+\]/g) ?? [];
  if (credentialCodes.some((code) => code !== '[CREDENTIAL_NATIVE_UNSUPPORTED]')) {
    return { class: 'policy', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (credentialCodes.length) {
    return { class: 'capability', retryable: false, allowFailover: true, demoteProvider: false };
  }
  if (message.includes('[SUBAGENT_UNAVAILABLE]')) {
    return { class: 'capability', retryable: false, allowFailover: true, demoteProvider: false };
  }
  // A governed CLI wall-clock deadline is already the final attempt for this
  // call. Retrying the same prompt only recreates the user-visible "waiting"
  // state and multiplies the delay. Fail over, when policy allows it, but do
  // not retry in place.
  const loweredMessage = message.toLowerCase();
  const codexCliIndex = Math.min(
    ...['[codex-cli]', 'codex-cli'].map((m) => loweredMessage.indexOf(m)).filter((i) => i >= 0),
    Number.POSITIVE_INFINITY
  );
  const codexTimedOut =
    codexCliIndex !== Number.POSITIVE_INFINITY &&
    (loweredMessage.slice(codexCliIndex).includes('timed out') ||
      loweredMessage.slice(codexCliIndex).includes('timeout') ||
      /wall.?clock/i.test(loweredMessage.slice(codexCliIndex)));
  if (codexTimedOut) {
    return { class: 'transient', retryable: false, allowFailover: true, demoteProvider: true };
  }
  if (/abort|cancel|user.?stop|operator.?cancel/i.test(message)) {
    return { class: 'cancelled', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (loweredMessage.includes('claude-agent') && loweredMessage.includes('no active session')) {
    return { class: 'transient', retryable: false, allowFailover: true, demoteProvider: true };
  }
  if (
    /egress|tier.?mismatch|spend.?cap|policy|approval.?required|forbidden|denied by/i.test(message)
  ) {
    return { class: 'policy', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (
    /model.{0,100}(?:not (?:available|supported|enabled).{0,50}(?:account|subscription|plan)|not entitled|access denied)|(?:account|subscription|plan).{0,100}(?:no access|does not have access|not entitled).{0,50}model/i.test(
      message
    )
  ) {
    return {
      class: 'entitlement',
      retryable: false,
      allowFailover: true,
      demoteProvider: false,
      demoteModel: true,
    };
  }
  if (
    /authenticat|unauthorized|invalid api key|login required|credential|permission denied|ineligible tier/i.test(
      message
    )
  ) {
    // Credentials are provider-local. A failed credential must not strand the
    // governed chain when another candidate is available; policy/egress
    // denials remain hard stops below.
    return { class: 'auth', retryable: false, allowFailover: true, demoteProvider: true };
  }
  if (
    /context.?limit|context.?window|max[_ -]?tokens|too many tokens|prompt too long/i.test(message)
  ) {
    return { class: 'capacity', retryable: false, allowFailover: true, demoteProvider: false };
  }
  const capabilityMatch = /(?:tool.?use|vision|structured.?output)/i.exec(message);
  const capabilityNoted =
    capabilityMatch !== null &&
    /not/i.test(message.slice((capabilityMatch.index ?? 0) + capabilityMatch[0].length));
  if (/unsupported|not implemented/i.test(message) || capabilityNoted) {
    return { class: 'capability', retryable: false, allowFailover: true, demoteProvider: false };
  }
  if (
    /invalid (?:request|parameter)|schema validation|malformed|bad request|^4(?:00|22)\b/i.test(
      message
    )
  ) {
    return { class: 'request', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (
    /timeout|timed out|\b(?:408|429|500|502|503|504|529)\b|rate[ -]?limit|overloaded|temporarily unavailable|gateway timeout/i.test(
      message
    )
  ) {
    const scope =
      error && typeof error === 'object'
        ? ((error as { rateLimitScope?: unknown; rate_limit_scope?: unknown }).rateLimitScope ??
          (error as { rate_limit_scope?: unknown }).rate_limit_scope)
        : undefined;
    if (scope === 'model')
      return {
        class: 'transient',
        retryable: true,
        allowFailover: true,
        demoteProvider: false,
        demoteModel: true,
      };
    return { class: 'transient', retryable: true, allowFailover: true, demoteProvider: true };
  }
  return { class: 'unknown', retryable: false, allowFailover: true, demoteProvider: true };
}

export function reasoningFailureMessage(error: unknown): string {
  return messageOf(error);
}
