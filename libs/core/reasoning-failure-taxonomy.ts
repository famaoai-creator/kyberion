export type ReasoningFailureClass =
  | 'transient'
  | 'capacity'
  | 'capability'
  | 'auth'
  | 'policy'
  | 'request'
  | 'cancelled'
  | 'unknown';

export interface ReasoningFailureClassification {
  class: ReasoningFailureClass;
  retryable: boolean;
  allowFailover: boolean;
  demoteProvider: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

export function classifyReasoningFailure(error: unknown): ReasoningFailureClassification {
  const message = messageOf(error);
  if (/abort|cancel|user.?stop|operator.?cancel/i.test(message)) {
    return { class: 'cancelled', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (
    /egress|tier.?mismatch|spend.?cap|policy|approval.?required|forbidden|denied by/i.test(message)
  ) {
    return { class: 'policy', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (
    /authenticat|unauthorized|invalid api key|login required|credential|permission denied|ineligible tier/i.test(
      message
    )
  ) {
    return { class: 'auth', retryable: false, allowFailover: false, demoteProvider: false };
  }
  if (
    /context.?limit|context.?window|max[_ -]?tokens|too many tokens|prompt too long/i.test(message)
  ) {
    return { class: 'capacity', retryable: false, allowFailover: true, demoteProvider: false };
  }
  if (
    /unsupported|not implemented|tool.?use.*not|vision.*not|structured.?output.*not/i.test(message)
  ) {
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
    return { class: 'transient', retryable: true, allowFailover: true, demoteProvider: true };
  }
  return { class: 'unknown', retryable: false, allowFailover: true, demoteProvider: true };
}

export function reasoningFailureMessage(error: unknown): string {
  return messageOf(error);
}
