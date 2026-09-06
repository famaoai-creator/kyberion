import { describe, expect, it } from 'vitest';
import { parseChronosIntelligenceInput } from './intelligence-input';

describe('parseChronosIntelligenceInput', () => {
  it('accepts strict inputs for representative control actions', () => {
    expect(
      parseChronosIntelligenceInput({
        action: 'approval_decision',
        requestId: 'approval-1',
        storageChannel: 'chronos',
        channel: 'chronos',
        decision: 'approved',
      })
    ).toMatchObject({ action: 'approval_decision', requestId: 'approval-1' });
    expect(
      parseChronosIntelligenceInput({
        action: 'mission_control',
        missionId: 'MSN-1',
        operation: 'pause',
      })
    ).toMatchObject({ action: 'mission_control', operation: 'pause' });
    expect(
      parseChronosIntelligenceInput({
        action: 'surface_control',
        surfaceId: null,
        operation: 'status',
      })
    ).toMatchObject({ action: 'surface_control', surfaceId: null });
  });

  it.each([
    ['null body', null],
    ['unknown action', { action: 'delete_everything' }],
    ['unknown field', { action: 'memory_promote_pending', force: true }],
    ['object identifier', { action: 'memory_approve_candidate', candidateId: { value: 'x' } }],
    ['unsafe identifier', { action: 'memory_approve_candidate', candidateId: '../candidate' }],
    [
      'invalid approval decision',
      {
        action: 'approval_decision',
        requestId: 'approval-1',
        storageChannel: 'chronos',
        channel: 'chronos',
        decision: 'approve',
      },
    ],
    [
      'invalid mission operation',
      { action: 'mission_control', missionId: 'MSN-1', operation: 'delete' },
    ],
    ['non-boolean dry run', { action: 'memory_promote_pending', dryRun: 'true' }],
    [
      'oversized detail',
      { action: 'next_action_execute', actionId: 'next-1', detail: 'x'.repeat(20_001) },
    ],
  ])('rejects %s before control-plane side effects', (_label, value) => {
    expect(() => parseChronosIntelligenceInput(value)).toThrow();
  });

  it('requires action-specific fields and preserves optional nullable surface IDs', () => {
    expect(() => parseChronosIntelligenceInput({ action: 'mission_control' })).toThrow();
    expect(() =>
      parseChronosIntelligenceInput({
        action: 'surface_control',
        surfaceId: null,
        operation: 'start',
      })
    ).toThrow();
    expect(
      parseChronosIntelligenceInput({
        action: 'surface_control',
        surfaceId: 'chronos',
        operation: 'start',
      })
    ).toMatchObject({ surfaceId: 'chronos', operation: 'start' });
  });
});
