export interface ReasoningDriftWatchdogState {
  total_attempts: number;
  consecutive_same_signature: number;
  last_signature?: string;
  last_observed_at?: string;
  last_reason?: string;
}

export interface ReasoningDriftWatchdogConfig {
  maxTotalAttempts?: number;
  maxConsecutiveSameSignature?: number;
  maxPromptChars?: number;
  maxResponseChars?: number;
  maxCombinedChars?: number;
}

export interface ReasoningDriftObservation {
  mission_id: string;
  item_id: string;
  prompt?: string;
  response_text?: string;
  cognitive_route_summary?: string;
  execution_mode?: string;
  ticket_state?: string;
  notes?: string[];
}

export interface ReasoningDriftWatchdogDecision {
  state: ReasoningDriftWatchdogState;
  should_stop: boolean;
  needs_attention: boolean;
  reason: string;
  signature: string;
  budget_exceeded: boolean;
  repeated_signature: boolean;
}

const DEFAULT_CONFIG: Required<ReasoningDriftWatchdogConfig> = {
  maxTotalAttempts: 8,
  maxConsecutiveSameSignature: 2,
  maxPromptChars: 20_000,
  maxResponseChars: 8_000,
  maxCombinedChars: 24_000,
};

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function normalizeExcerpt(value: string, maxLength = 180): string {
  const normalized = normalizeText(value);
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function uniqueNotes(notes?: string[]): string[] {
  return Array.from(new Set((notes || []).map((note) => normalizeText(note)).filter(Boolean)));
}

export function createReasoningDriftWatchdogState(): ReasoningDriftWatchdogState {
  return {
    total_attempts: 0,
    consecutive_same_signature: 0,
  };
}

export function hydrateReasoningDriftWatchdogState(metadata?: Record<string, unknown> | null): ReasoningDriftWatchdogState {
  if (!metadata || typeof metadata !== 'object') return createReasoningDriftWatchdogState();
  const total = Number(metadata.drift_watchdog_total_attempts);
  const same = Number(metadata.drift_watchdog_consecutive_same_signature);
  return {
    total_attempts: Number.isFinite(total) && total >= 0 ? total : 0,
    consecutive_same_signature: Number.isFinite(same) && same >= 0 ? same : 0,
    last_signature: typeof metadata.drift_watchdog_last_signature === 'string' ? metadata.drift_watchdog_last_signature : undefined,
    last_observed_at: typeof metadata.drift_watchdog_last_observed_at === 'string' ? metadata.drift_watchdog_last_observed_at : undefined,
    last_reason: typeof metadata.drift_watchdog_last_reason === 'string' ? metadata.drift_watchdog_last_reason : undefined,
  };
}

export function buildReasoningDriftSignature(input: ReasoningDriftObservation): string {
  const parts = [
    normalizeText(input.mission_id),
    normalizeText(input.item_id),
    normalizeText(input.execution_mode),
    normalizeText(input.ticket_state),
    normalizeText(input.cognitive_route_summary),
    normalizeExcerpt(input.response_text || ''),
    uniqueNotes(input.notes).join('|'),
  ].filter(Boolean);
  return parts.join('::');
}

export function advanceReasoningDriftWatchdog(
  state: ReasoningDriftWatchdogState,
  observation: ReasoningDriftObservation,
  config: ReasoningDriftWatchdogConfig = {},
): ReasoningDriftWatchdogDecision {
  const limits = { ...DEFAULT_CONFIG, ...config };
  const signature = buildReasoningDriftSignature(observation);
  const repeatedSignature = state.last_signature === signature;
  const nextState: ReasoningDriftWatchdogState = {
    total_attempts: state.total_attempts + 1,
    consecutive_same_signature: repeatedSignature ? state.consecutive_same_signature + 1 : 1,
    last_signature: signature,
    last_observed_at: new Date().toISOString(),
    last_reason: repeatedSignature
      ? 'repeated signature detected'
      : 'signature advanced',
  };

  const promptChars = (observation.prompt || '').length;
  const responseChars = (observation.response_text || '').length;
  const combinedChars = promptChars + responseChars;
  const budgetExceeded =
    promptChars > limits.maxPromptChars ||
    responseChars > limits.maxResponseChars ||
    combinedChars > limits.maxCombinedChars;

  if (nextState.total_attempts > limits.maxTotalAttempts) {
    return {
      state: nextState,
      should_stop: true,
      needs_attention: true,
      reason: `stopped after ${nextState.total_attempts} attempts without a stable finish`,
      signature,
      budget_exceeded: budgetExceeded,
      repeated_signature: repeatedSignature,
    };
  }

  if (budgetExceeded) {
    return {
      state: nextState,
      should_stop: true,
      needs_attention: true,
      reason: `stopped because the prompt/response budget was exceeded (${combinedChars} chars)`,
      signature,
      budget_exceeded: true,
      repeated_signature: repeatedSignature,
    };
  }

  if (nextState.consecutive_same_signature >= limits.maxConsecutiveSameSignature) {
    return {
      state: nextState,
      should_stop: true,
      needs_attention: true,
      reason: `stopped after ${nextState.consecutive_same_signature} repeated results for the same work item`,
      signature,
      budget_exceeded: budgetExceeded,
      repeated_signature: true,
    };
  }

  return {
    state: nextState,
    should_stop: false,
    needs_attention: false,
    reason: repeatedSignature ? 'repeated signature observed' : 'progressing',
    signature,
    budget_exceeded: budgetExceeded,
    repeated_signature: repeatedSignature,
  };
}

export function formatReasoningDriftWatchdogDecision(decision: ReasoningDriftWatchdogDecision): string {
  const parts = [
    `attempts=${decision.state.total_attempts}`,
    `repeat=${decision.state.consecutive_same_signature}`,
    `stop=${decision.should_stop ? 'yes' : 'no'}`,
    `attention=${decision.needs_attention ? 'yes' : 'no'}`,
    `budget=${decision.budget_exceeded ? 'exceeded' : 'ok'}`,
  ];
  if (decision.reason) parts.push(`reason=${decision.reason}`);
  return parts.join('; ');
}

export function encodeReasoningDriftWatchdogState(state: ReasoningDriftWatchdogState): Record<string, unknown> {
  return {
    drift_watchdog_total_attempts: state.total_attempts,
    drift_watchdog_consecutive_same_signature: state.consecutive_same_signature,
    drift_watchdog_last_signature: state.last_signature,
    drift_watchdog_last_observed_at: state.last_observed_at,
    drift_watchdog_last_reason: state.last_reason,
  };
}
