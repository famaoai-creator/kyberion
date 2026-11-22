import { describe, expect, it } from 'vitest';
import {
  buildPlanInteractionPacket,
  computePlanLayers,
  resolvePlanInteractionAction,
} from './plan-interaction-packet.js';

describe('computePlanLayers', () => {
  it('layers steps by depends_on depth', () => {
    const layers = computePlanLayers([
      { id: 'a' },
      { id: 'b', depends_on: ['a'] },
      { id: 'c', depends_on: ['a'] },
      { id: 'd', depends_on: ['b', 'c'] },
    ]);
    expect(layers).toEqual([
      { index: 0, stepIds: ['a'] },
      { index: 1, stepIds: ['b', 'c'] },
      { index: 2, stepIds: ['d'] },
    ]);
  });
});

describe('buildPlanInteractionPacket', () => {
  it('emits execution-preview with Start and Modify', () => {
    const packet = buildPlanInteractionPacket({
      missionId: 'm-1',
      requestText: 'Ship the deck',
      confidence: 0.8,
      goal: { summary: 'Ship deck', successCondition: 'deck published' },
      delivery: {
        mode: 'mission',
        requiresApproval: true,
        clarificationNeeded: false,
        askHumanToConfirm: false,
        rationale: 'aligned',
      },
      execution: {
        shape: 'mission',
        requiredInputs: [],
        missingInputs: [],
      },
      workflow: [
        { id: 'research', label: 'Research', description: '', actuator: 'x', phase: 'plan' },
        {
          id: 'build',
          label: 'Build',
          description: '',
          actuator: 'x',
          phase: 'exec',
          depends_on: ['research'],
          output_refs: ['deck.pptx'],
        },
      ],
      team: { orgRole: 'operator', members: [{ label: 'Planner' }] },
    });

    expect(packet.interaction_type).toBe('execution-preview');
    expect(packet.next_actions?.map((a) => a.id)).toEqual(['plan-start', 'plan-modify']);
    expect(packet.next_actions?.[0]?.next_action_type).toBe('start_mission');
    expect(packet.plan.layers).toEqual([
      { index: 0, stepIds: ['research'] },
      { index: 1, stepIds: ['build'] },
    ]);
    expect(packet.plan.deliverables).toEqual(['deck.pptx']);
    expect(packet.plan.owners[0]).toBe('operator');
    expect(resolvePlanInteractionAction('plan-start')).toBe('start_mission');
    expect(resolvePlanInteractionAction('plan-modify')).toBe('modify_plan');
  });
});
