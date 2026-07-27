import { describe, expect, it } from 'vitest';
import { attentionActionForKind } from './AgentCollaborationBoard';

describe('AgentCollaborationBoard attention actions (UX-07)', () => {
  it('routes human approval and mission stop/resume actions', () => {
    expect(attentionActionForKind('approval')).toEqual({
      mode: 'view',
      viewId: 'secret-approval-queue',
      label: '承認キューを開く',
    });
    expect(attentionActionForKind('blocked')).toEqual({
      mode: 'mission',
      label: '停止・再開操作を開く',
    });
    expect(attentionActionForKind('waiting')).toEqual({
      mode: 'mission',
      label: '停止・再開操作を開く',
    });
  });

  it('routes operational recovery and handoff inspection', () => {
    expect(attentionActionForKind('retry')).toMatchObject({
      mode: 'view',
      viewId: 'runtime-lease-doctor',
    });
    expect(attentionActionForKind('handoff')).toMatchObject({
      mode: 'view',
      viewId: 'trace-viewer',
    });
    expect(attentionActionForKind('completion')).toBeNull();
  });
});
