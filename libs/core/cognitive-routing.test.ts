import { describe, expect, it } from 'vitest';

import {
  buildCognitiveRouteDecision,
  formatCognitiveRouteDecision,
  loadCognitiveRoutingSchema,
} from './cognitive-routing.js';

describe('cognitive routing', () => {
  it('loads the governed routing schema as safe JSON', () => {
    expect(loadCognitiveRoutingSchema()).toMatchObject({ type: 'object' });
  });

  it('routes deterministic pipeline tasks to zero_llm', () => {
    const decision = buildCognitiveRouteDecision({
      mission_id: 'MSN-COGNITIVE-ROUTING-001',
      item_id: 'WIT-ROUTE-001',
      title: 'Execute the verified pipeline',
      description:
        'Run the deterministic pipeline using the stored pipeline_ref and write the result artifact.',
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
      description:
        'Investigate the design, compare alternatives, and validate compliance implications before implementation.',
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
      description:
        'Add the response summary, comment, and close the issue after the result is recorded.',
      metadata: {
        target_path: 'coordination/tickets/replies/task-1.json',
      },
    });

    expect(decision.tier).toBe('fast_llm');
    expect(decision.backend_preference).toBe('fast_reasoning');
    expect(decision.deterministic_eligible).toBe(false);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('ignores generated hex ids that accidentally contain marker substrings', () => {
    const decision = buildCognitiveRouteDecision({
      mission_id: 'msn-3adf12bc',
      item_id: 'witem-4adf9988',
      title: 'Update the ticket reflection',
      description: 'Add the response summary and close the issue.',
      metadata: {
        target_path: 'coordination/tickets/replies/task-1.json',
        last_dispatch_attempt_id: 'wattempt-3adf12bc',
        attempt_id: 'wattempt-badf0011',
      },
    });

    expect(decision.deterministic_eligible).toBe(false);
    expect(decision.tier).toBe('fast_llm');
  });

  it('ignores dispatch bookkeeping metadata written back between runs', () => {
    const base = {
      mission_id: 'MSN-COGNITIVE-ROUTING-004',
      item_id: 'WIT-ROUTE-004',
      title: 'Update the ticket reflection',
      description: 'Add the response summary and close the issue.',
      metadata: { target_path: 'coordination/tickets/replies/task-1.json' },
    };
    const clean = buildCognitiveRouteDecision(base);
    const afterWriteBack = buildCognitiveRouteDecision({
      ...base,
      metadata: {
        ...base.metadata,
        last_dispatch_at: '2026-09-23T08:00:00.000Z',
        last_dispatch_mode: 'subagent',
        last_dispatch_response_excerpt: 'Compared the architecture and evaluated risk.',
        last_cognitive_route_summary:
          'tier=zero_llm; backend=deterministic_pipeline; deterministic=yes; risk=20; uncertainty=20',
        last_cognitive_route_tier: 'zero_llm',
        drift_watchdog_total_attempts: 2,
        drift_watchdog_last_signature: 'msn::witem::subagent::review::risk=20',
        drift_watchdog_last_reason: 'signature advanced',
        signature: 'msn::witem::subagent::review::tier=zero_llm',
        reason: 'signature advanced',
        should_stop: false,
        repeated_signature: false,
        needs_attention: false,
        execution_surface: 'subagent',
        execution_status: 'completed',
        lease_status: 'idle',
        resolved_agent_id: 'sovereign-brain',
      },
    });

    expect(afterWriteBack.tier).toBe(clean.tier);
    expect(afterWriteBack.backend_preference).toBe(clean.backend_preference);
    expect(afterWriteBack.deterministic_eligible).toBe(false);
    expect(afterWriteBack.risk).toBe(clean.risk);
    expect(afterWriteBack.uncertainty).toBe(clean.uncertainty);
  });
});
