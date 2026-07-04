import { describe, expect, it } from 'vitest';
import { buildMissionHandoffPacket, buildWorkItemHandoffPacket } from './handoff-packet.js';

describe('handoff-packet', () => {
  it('builds a work-item handoff packet with fallback context', () => {
    const packet = buildWorkItemHandoffPacket({
      itemId: 'item-1',
      itemTitle: 'Ship handoff packet',
      purpose: 'implementation',
      fromPeerId: 'peer-a',
      toPeerId: 'peer-b',
      correlationId: 'corr-1',
      metadata: {
        open_decisions: ['choose packet shape'],
        partial_artifacts: ['libs/core/work-coordination.ts'],
        remaining_acceptance_criteria: ['no symlink traversal'],
        rationale: 'Prevent lossy handoffs.',
      },
    });

    expect(packet).toMatchObject({
      kind: 'work_item',
      correlation_id: 'corr-1',
      open_decisions: ['choose packet shape'],
      partial_artifacts: ['libs/core/work-coordination.ts'],
      remaining_acceptance_criteria: ['no symlink traversal'],
      rationale: 'Prevent lossy handoffs.',
      source_ref: 'peer:peer-a',
      target_ref: 'peer:peer-b',
    });
    expect(packet.outgoing_summary).toContain('item-1');
  });

  it('builds a mission handoff packet from mission context', () => {
    const packet = buildMissionHandoffPacket({
      missionId: 'MSN-1',
      previousPersona: 'worker',
      nextPersona: 'reviewer',
      note: 'Continue from the latest checkpoint.',
      context: {
        blockers: ['awaiting review'],
        associated_projects: ['PRJ-1'],
        mission_completion_summary: {
          requested_result: 'complete the task',
          satisfied: false,
          delivered: ['checkpoint A'],
          gaps: ['missing acceptance'],
          next_step: 'review output',
          confidence: 0.7,
        },
        mission_completion_next_action: {
          title: 'review',
          request: 'please review',
          delivered: ['artifact B'],
          gaps: ['final approval'],
          next_step: 'approve',
          satisfied: false,
          confidence: 0.6,
          evidence_refs: ['trace-1'],
        },
      },
    });

    expect(packet).toMatchObject({
      kind: 'mission',
      outgoing_summary: 'Continue from the latest checkpoint.',
      open_decisions: ['awaiting review', 'missing acceptance', 'final approval'],
      partial_artifacts: ['checkpoint A', 'artifact B', 'PRJ-1'],
      remaining_acceptance_criteria: [
        'missing acceptance',
        'final approval',
        'review output',
        'approve',
      ],
      rationale: 'Continue from the latest checkpoint.',
      source_ref: 'persona:worker',
      target_ref: 'persona:reviewer',
    });
  });
});
