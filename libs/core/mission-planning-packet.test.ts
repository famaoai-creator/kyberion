import { describe, expect, it } from 'vitest';
import type { PlanningPacket } from './channel-surface.js';
import {
  buildPlannerRetryPrompt,
  packetRequiresIndependentReview,
  parsePlanningReviewVerdict,
} from './mission-planning-packet.js';

describe('mission planning packet helpers', () => {
  it('parses the canonical fenced planning review verdict', () => {
    const verdict = parsePlanningReviewVerdict(
      '```json\n{"approve":true,"gaps":[],"rationale":"complete"}\n```'
    );

    expect(verdict).toMatchObject({
      approve: true,
      gaps: [],
      rationale: 'complete',
      parsed: { approve: true },
    });
  });

  it('fails closed when a planning review verdict is absent or malformed', () => {
    expect(parsePlanningReviewVerdict('no structured verdict')).toMatchObject({
      approve: false,
      gaps: ['planning review verdict block missing'],
    });
    expect(parsePlanningReviewVerdict('{"approve":"yes"}').approve).toBe(false);
  });

  it('requires independent review for high-risk task packets', () => {
    const packet = {
      next_tasks: [{ task_id: 'TASK-1', risk: 'high_stakes', description: 'review' }],
    } as unknown as PlanningPacket;

    expect(packetRequiresIndependentReview(packet)).toBe(true);
  });

  it('keeps planner retry prompts bounded and explicit', () => {
    const prompt = buildPlannerRetryPrompt('MSN-1', ['missing deliverable'], 'previous response');

    expect(prompt).toContain('Return exactly one ```planning_packet``` block');
    expect(prompt).toContain('- missing deliverable');
    expect(prompt).toContain('previous response');
  });
});
