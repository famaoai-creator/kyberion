export interface ToolCallLike {
  name: string;
  arguments: string;
}

export interface ToolLoopGuardrailConfig {
  maxConsecutiveSameCalls?: number;
  maxTotalCalls?: number;
}

export interface ToolLoopGuardrailState {
  totalCalls: number;
  consecutiveSameCalls: number;
  lastSignature?: string;
}

export interface ToolLoopGuardrailDecision {
  state: ToolLoopGuardrailState;
  shouldStop: boolean;
  reason?: string;
}

const DEFAULT_GUARDRAIL_CONFIG: Required<ToolLoopGuardrailConfig> = {
  maxConsecutiveSameCalls: 3,
  maxTotalCalls: 8,
};

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeToolCallSignature(toolCall: ToolCallLike): string {
  const toolName = toolCall.name.trim();
  const rawArguments = toolCall.arguments.trim();
  if (!rawArguments) return `${toolName}()`;
  try {
    return `${toolName}:${stableSerialize(JSON.parse(rawArguments))}`;
  } catch {
    return `${toolName}:${rawArguments}`;
  }
}

export function createToolLoopGuardrailState(): ToolLoopGuardrailState {
  return {
    totalCalls: 0,
    consecutiveSameCalls: 0,
  };
}

export function advanceToolLoopGuardrail(
  state: ToolLoopGuardrailState,
  toolCall: ToolCallLike,
  config: ToolLoopGuardrailConfig = {},
): ToolLoopGuardrailDecision {
  const limits = {
    ...DEFAULT_GUARDRAIL_CONFIG,
    ...config,
  };
  const signature = normalizeToolCallSignature(toolCall);
  const sameAsLast = state.lastSignature === signature;
  const nextState: ToolLoopGuardrailState = {
    totalCalls: state.totalCalls + 1,
    consecutiveSameCalls: sameAsLast ? state.consecutiveSameCalls + 1 : 1,
    lastSignature: signature,
  };

  if (nextState.totalCalls > limits.maxTotalCalls) {
    return {
      state: nextState,
      shouldStop: true,
      reason: `stopped after ${nextState.totalCalls} tool rounds without reaching a final answer`,
    };
  }

  if (nextState.consecutiveSameCalls >= limits.maxConsecutiveSameCalls) {
    return {
      state: nextState,
      shouldStop: true,
      reason: `stopped after ${nextState.consecutiveSameCalls} repeated calls to ${toolCall.name} with the same arguments`,
    };
  }

  return {
    state: nextState,
    shouldStop: false,
  };
}
