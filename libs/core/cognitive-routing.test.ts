import { describe, expect, it } from 'vitest';

import {
  buildCognitiveRouteDecision,
  formatCognitiveRouteDecision,
} from './cognitive-routing.js';

describe('cognitive routing', () => {
  it('routes deterministic pipeline tasks to zero_llm', () => {
    const decision = buildCognitiveRouteDecision({
      mission_id: 'MSN-COGNITIVE-ROUTING-001',
      item_id: 'WIT-ROUTE-001',
      title: 'Execute the verified pipeline',
      description: 'Run the deterministic pipeline using the stored pipeline_ref and write the result artifact.',
      metadata: {
        pipeline_ref: 'pipelines/verified-release.json',
      },
    });

    expect(decision).toMatchObject({
      tier: 'zero_llm',
      backend_preference: 'deterministic_pipeline',
      deterministic_eligible: true,
    });
    expect(decision.risk).toBeGreaterThanOrEqual(0);
    expect(decision.uncertainty).toBeGreaterThanOrEqual(0);
    expect(decision.reason).toContain('deterministic pipeline');
    expect(formatCognitiveRouteDecision(decision)).toContain('tier=zero_llm');
  });

  it('routes architecture and security work to heavy reasoning', () => {
    const decision = buildCognitiveRouteDecision({
      mission_id: 'MSN-COGNITIVE-ROUTING-002',
      item_id: 'WIT-ROUTE-002',
      title: 'Review the security-sensitive architecture change',
      description: 'Investigate the design, compare alternatives, and validate compliance implications before implementation.',
      metadata: {
        priority: 'urgent',
      },
    });

    expect(decision.tier).toBe('heavy_reasoning');
    expect(decision.backend_preference).toBe('heavy_reasoning');
    expect(decision.deterministic_eligible).toBe(false);
    expect(decision.risk).toBeGreaterThan(0);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('routes routine reflection and formatting work to fast_llm', () => {
    const decision = buildCognitiveRouteDecision({
      mission_id: 'MSN-COGNITIVE-ROUTING-003',
      item_id: 'WIT-ROUTE-003',
      title: 'Update the ticket reflection',
      description: 'Add the response summary, comment, and close the issue after the result is recorded.',
      metadata: {
        target_path: 'coordination/tickets/replies/task-1.json',
      },
    });

    expect(decision.tier).toBe('fast_llm');
    expect(decision.backend_preference).toBe('fast_reasoning');
    expect(decision.deterministic_eligible).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
