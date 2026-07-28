import { describe, expect, it } from 'vitest';
import {
  attentionActionForKind,
  buildCollaborationQuery,
  collaborationActionLabel,
  collaborationKindLabel,
} from './AgentCollaborationBoard';

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

  it('keeps collaboration labels aligned with the selected Chronos locale', () => {
    expect(collaborationKindLabel('handoff', 'ja')).toBe('引き継ぎ');
    expect(collaborationKindLabel('handoff', 'en')).toBe('handoff');
    expect(collaborationKindLabel('vendor_specific_event', 'en')).toBe('vendor_specific_event');
    expect(collaborationActionLabel('approval', 'ja')).toBe('承認キューを開く');
    expect(collaborationActionLabel('approval', 'en')).toBe('Open approval queue');
    expect(collaborationActionLabel('completion', 'en')).toBeNull();
  });

  it('builds a scoped collaboration query without leaking empty filters', () => {
    expect(buildCollaborationQuery('client a', 'MSN-42')).toBe('?tenant=client+a&mission=MSN-42');
    expect(buildCollaborationQuery('', '')).toBe('');
  });
});
