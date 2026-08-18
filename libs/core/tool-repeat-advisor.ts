/** DH-14: deterministic repeat-tool detection without retaining raw arguments. */

import * as crypto from 'node:crypto';

export const TOOL_REPEAT_THRESHOLDS = [3, 5, 8] as const;

export interface ToolRepeatObservation {
  op: string;
  args_hash: string;
  repeat_count: number;
  advice?: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function argsHash(op: string, params: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ op, params: stableValue(params) }))
    .digest('hex');
}

/** Counts repeats for one execution window; denied calls are intentionally included. */
export class ToolRepeatAdvisor {
  private readonly counts = new Map<string, number>();

  observe(op: string, params: Record<string, unknown>): ToolRepeatObservation {
    const hash = argsHash(op, params);
    const count = (this.counts.get(hash) ?? 0) + 1;
    this.counts.set(hash, count);
    const threshold = TOOL_REPEAT_THRESHOLDS.find((candidate) => candidate === count);
    return {
      op,
      args_hash: hash,
      repeat_count: count,
      ...(threshold
        ? {
            advice: `Tool ${op} has been requested with the same arguments ${count} times. Verify the result or choose a different next action.`,
          }
        : {}),
    };
  }

  reset(): void {
    this.counts.clear();
  }
}
