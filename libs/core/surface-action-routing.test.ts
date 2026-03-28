import { describe, expect, it } from 'vitest';
import {
  parseSurfaceActionRoutingDecision,
  validateSurfaceActionRoutingDecision,
} from './surface-action-routing.js';

describe('surface action routing', () => {
  it('parses fenced router json', () => {
    const parsed = parseSurfaceActionRoutingDecision([
      '```json',
      '{"kind":"surface_action_routing","intent":"browser_open_site","confidence":0.92,"target_operator":"browser-operator","browser":{"site_query":"日経新聞"}}',
      '```',
    ].join('\n'));

    expect(parsed?.intent).toBe('browser_open_site');
    expect(parsed?.browser?.site_query).toBe('日経新聞');
  });

  it('validates surface query decisions', () => {
    expect(validateSurfaceActionRoutingDecision({
      kind: 'surface_action_routing',
      intent: 'surface_query',
      confidence: 0.88,
      target_operator: 'surface-query',
      query: {
        query_type: 'weather',
        text: '今日の天気',
      },
    })).toBe(true);
  });

  it('rejects invalid delegate decisions', () => {
    expect(parseSurfaceActionRoutingDecision(
      '{"kind":"surface_action_routing","intent":"async_delegate","confidence":0.8,"delegate":{"receiver":"browser-operator"}}',
    )).toBeNull();
  });
});
