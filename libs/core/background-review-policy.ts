/**
 * HA-01 background-review guardrails.
 *
 * Review forks may suggest reusable memory, but an incident-specific failure
 * or an unverified provider judgment must never become durable knowledge.
 * This module is intentionally deterministic and side-effect free so it can
 * be used both before queueing a candidate and immediately before promotion.
 */

export const BACKGROUND_REVIEW_ALLOWED_OPERATIONS = [
  'knowledge:read',
  'memory:enqueue',
  'memory:archive',
  'memory:promote',
  'pipeline:promote',
  'skill:read',
  'skill:patch',
] as const;

export type BackgroundReviewAllowedOperation =
  (typeof BACKGROUND_REVIEW_ALLOWED_OPERATIONS)[number];

export interface BackgroundReviewPolicyDecision {
  allowed: boolean;
  rule?: 'transient_incident' | 'environment_specific_failure' | 'provider_assertion';
  reason?: string;
}

const PROHIBITED_RULES: Array<{
  rule: NonNullable<BackgroundReviewPolicyDecision['rule']>;
  pattern: RegExp;
  reason: string;
}> = [
  {
    rule: 'transient_incident',
    pattern:
      /(?:one[- ]off|temporary|transient|一過性|一時的)[^\n.!。！]{0,80}(?:error|failure|outage|network|timeout|障害|エラー|失敗|タイムアウト)/iu,
    reason: '一過性・一時的な障害は durable knowledge に記録しない',
  },
  {
    rule: 'environment_specific_failure',
    pattern:
      /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|localhost:\d+|\/Users\/|\/private\/tmp\/|[A-Z]:\\)/u,
    reason: '環境固有の失敗やローカルパスは durable knowledge に記録しない',
  },
  {
    rule: 'provider_assertion',
    pattern:
      /\b(?:provider|backend|model)\b[^\n.!。！]{0,80}\b(?:always|never|broken|unreliable|bad|useless|壊れている|信用できない|常に失敗)/iu,
    reason: '単一事例から provider/backend/model を断定しない',
  },
];

export function evaluateBackgroundReviewText(text: string): BackgroundReviewPolicyDecision {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return {
      allowed: false,
      reason: 'レビュー結果が空です',
    };
  }
  for (const prohibited of PROHIBITED_RULES) {
    if (prohibited.pattern.test(normalized)) {
      return {
        allowed: false,
        rule: prohibited.rule,
        reason: prohibited.reason,
      };
    }
  }
  return { allowed: true };
}

export function isBackgroundReviewOperationAllowed(
  operation: string
): operation is BackgroundReviewAllowedOperation {
  return (BACKGROUND_REVIEW_ALLOWED_OPERATIONS as readonly string[]).includes(
    String(operation || '')
      .trim()
      .toLowerCase()
  );
}

export function assertBackgroundReviewOperationAllowed(operation: string): void {
  if (!isBackgroundReviewOperationAllowed(operation)) {
    throw new Error(
      `[POLICY_VIOLATION] Background review operation is not allowlisted: ${String(operation || '')}`
    );
  }
}

export function buildBackgroundReviewPrompt(input: {
  snapshot: string;
  sessionId: string;
}): string {
  return [
    "You are Kyberion's asynchronous background review fork.",
    'Review the snapshot for reusable, evidence-backed improvements only.',
    'You may propose memory candidates or patches to an existing skill/pipeline.',
    'You must not mutate mission state or perform the main task.',
    '',
    'Allowed operations:',
    ...BACKGROUND_REVIEW_ALLOWED_OPERATIONS.map((operation) => `- ${operation}`),
    '',
    'Never record:',
    '- one-off, transient, or environment-specific failures',
    '- absolute local paths, credentials, or raw tool output',
    '- blanket negative claims about a provider, backend, or model',
    '- a skill or pipeline you did not read',
    '',
    `Session: ${input.sessionId}`,
    'Snapshot:',
    input.snapshot,
    '',
    'Return a concise review proposal or NO_ACTION. Do not claim that an operation was executed.',
  ].join('\n');
}
