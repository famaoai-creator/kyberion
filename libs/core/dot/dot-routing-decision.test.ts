import { describe, expect, it } from 'vitest';
import { isRoutingDecision } from '../contracts/routing-decision.js';
import {
  dotRoutingDecision,
  dotRoutingRefusal,
  isDotExecutionShape,
} from './dot-routing-decision.js';
import { DOT_EXECUTION_SHAPES } from './dot-proposals.js';

describe('dot RoutingDecision adapter', () => {
  it('builds a RoutingDecision from the charter-bounded shape without reading text', () => {
    for (const shape of DOT_EXECUTION_SHAPES) {
      const decision = dotRoutingDecision(shape);
      expect(isRoutingDecision(decision)).toBe(true);
      expect(decision.execution_shape).toBe(shape);
      expect(decision).not.toHaveProperty('intent_id');
      // The current work-scope policy keeps every dot shape (mission stays mission).
      expect(decision.promotion.execution_shape).toBe(shape);
      expect(dotRoutingRefusal(shape, decision)).toBeUndefined();
    }
    expect(dotRoutingDecision('mission').promotion.required).toBe(true);
    expect(dotRoutingDecision('pipeline').promotion.required).toBe(false);
  });

  it('refuses when work-scope policy routes the dot shape elsewhere', () => {
    const decision = dotRoutingDecision('task_session');
    const routed = {
      ...decision,
      promotion: {
        ...decision.promotion,
        required: true,
        execution_shape: 'mission' as const,
        matched_rule_ids: ['catalog-floor'],
      },
    };
    expect(dotRoutingRefusal('task_session', routed)).toMatch(
      /routes execution_shape 'task_session' to 'mission' \(catalog-floor\)/
    );
  });

  it('recognizes only the dot shapes', () => {
    expect(isDotExecutionShape('pipeline')).toBe(true);
    expect(isDotExecutionShape('solution_project')).toBe(false);
    expect(isDotExecutionShape(undefined)).toBe(false);
  });
});
