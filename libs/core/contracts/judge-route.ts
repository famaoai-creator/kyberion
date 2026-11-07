/**
 * Small, provider-neutral routing contract for TAKT-style judge stages.
 *
 * The LLM is only allowed to produce a structured verdict. Route matching is
 * deterministic and fail-closed so a provider cannot invent the next step.
 */

export type JudgeRouteTerminal = 'COMPLETE' | 'ABORT';

export interface JudgeRouteCondition {
  /** Match the top-level verdict label. */
  label?: string;
  /** Match a nested verdict field (for example `decision.status`). */
  field?: string;
  eq?: unknown;
  in?: unknown[];
  matches?: string;
}
export interface JudgeRouteDefinition {
  when?: JudgeRouteCondition;
  next: string;
  reason?: string;
}

export interface JudgeRouteSelection {
  matched: boolean;
  route_index?: number;
  next: string | 'CONTINUE';
  reason: string;
}

export interface JudgeRouteDecision {
  verdict: Record<string, unknown>;
  selection: JudgeRouteSelection;
}

export type JudgeRouteNoMatch = 'abort' | 'complete' | 'continue';

function getPathValue(value: unknown, path: string): unknown {
  return path
    .split('.')
    .map((part) => part.trim())
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      if (!Object.hasOwn(current, part)) return undefined;
      return (current as Record<string, unknown>)[part];
    }, value);
}

/** A field selects a value; it is never a predicate or an implicit fallback. */
export function isJudgeRouteCondition(condition: unknown): condition is JudgeRouteCondition {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
  const candidate = condition as JudgeRouteCondition;
  if (candidate.label !== undefined && typeof candidate.label !== 'string') return false;
  if (
    candidate.field !== undefined &&
    (typeof candidate.field !== 'string' || candidate.field.split('.').some((part) => !part.trim()))
  )
    return false;
  if (candidate.in !== undefined && !Array.isArray(candidate.in)) return false;
  if (candidate.matches !== undefined) {
    if (typeof candidate.matches !== 'string') return false;
    try {
      new RegExp(candidate.matches);
    } catch {
      return false;
    }
  }
  const hasValuePredicate =
    candidate.eq !== undefined || candidate.in !== undefined || candidate.matches !== undefined;
  if (candidate.field !== undefined && !hasValuePredicate) return false;
  return candidate.label !== undefined || hasValuePredicate;
}

function matchesCondition(
  verdict: Record<string, unknown>,
  condition: JudgeRouteCondition
): boolean {
  if (!isJudgeRouteCondition(condition)) return false;
  const label = getPathValue(verdict, 'label');
  const value = condition.field ? getPathValue(verdict, condition.field) : label;
  if (value === undefined) return false;
  if (condition.label !== undefined && label !== condition.label) return false;
  if (condition.eq !== undefined && value !== condition.eq) return false;
  if (condition.in !== undefined && !condition.in.some((candidate) => candidate === value)) {
    return false;
  }
  if (condition.matches !== undefined) {
    let expression: RegExp;
    try {
      expression = new RegExp(condition.matches);
    } catch {
      return false;
    }
    if (!expression.test(String(value ?? ''))) return false;
  }
  return true;
}

/** Select the first matching route. No implicit fallback is permitted. */
export function selectJudgeRoute(
  verdict: Record<string, unknown>,
  routes: JudgeRouteDefinition[],
  onNoMatch: JudgeRouteNoMatch = 'abort'
): JudgeRouteDecision {
  for (const [routeIndex, route] of routes.entries()) {
    if (!route || typeof route.next !== 'string' || !route.next.trim()) continue;
    if (matchesCondition(verdict, route.when || {})) {
      return {
        verdict,
        selection: {
          matched: true,
          route_index: routeIndex,
          next: route.next.trim(),
          reason: route.reason || `route ${routeIndex + 1} matched`,
        },
      };
    }
  }

  if (onNoMatch === 'abort') {
    return {
      verdict,
      selection: {
        matched: false,
        next: 'ABORT',
        reason: 'no judge_route condition matched; default is abort',
      },
    };
  }
  return {
    verdict,
    selection: {
      matched: false,
      next: onNoMatch === 'complete' ? 'COMPLETE' : 'CONTINUE',
      reason: `no judge_route condition matched; on_no_match=${onNoMatch}`,
    },
  };
}

export function resolveMaxRouteHops(stepCount: number, configured?: unknown): number {
  const explicit = Number(configured);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return Math.max(1, Math.floor(stepCount) * 3);
}

/** Detect consecutive repetition and periodic route cycles. */
export function detectRouteCycle(
  history: string[],
  maxRouteHops: number
): { detected: boolean; reason?: string } {
  if (history.length > maxRouteHops) {
    return {
      detected: true,
      reason: `route hop limit exceeded (${history.length}/${maxRouteHops})`,
    };
  }
  if (history.length >= 2 && history[history.length - 1] === history[history.length - 2]) {
    return { detected: true, reason: `same-step repetition detected at ${history.at(-1)}` };
  }
  for (let period = 1; period <= Math.floor(history.length / 2); period += 1) {
    const suffix = history.slice(-period);
    const previous = history.slice(-period * 2, -period);
    if (suffix.length === period && suffix.every((step, index) => step === previous[index])) {
      return { detected: true, reason: `periodic route cycle detected (period=${period})` };
    }
  }
  return { detected: false };
}
