import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runApprovedClaudeBrowserTask,
  runApprovedClaudeDocumentTask,
  updateTaskSession,
  recordTaskSessionHistory,
  safeWriteFile,
} = vi.hoisted(() => {
  const runApprovedClaudeBrowserTask = vi.fn();
  const runApprovedClaudeDocumentTask = vi.fn();
  const updateTaskSession = vi.fn((sessionId: string, patch: any) => ({
    session_id: sessionId,
    surface: 'presence',
    task_type: patch?.artifact?.kind?.includes('browser') ? 'browser' : 'report_document',
    status: patch?.status ?? 'completed',
    mode: 'interactive',
    goal: { summary: 'Goal', success_condition: 'Success' },
    control: { interruptible: true, requires_approval: false, awaiting_user_input: false },
    history: [],
    updated_at: new Date().toISOString(),
    artifact: patch?.artifact,
  }));
  const recordTaskSessionHistory = vi.fn();
  const safeWriteFile = vi.fn();
  return {
    runApprovedClaudeBrowserTask,
    runApprovedClaudeDocumentTask,
    updateTaskSession,
    recordTaskSessionHistory,
    safeWriteFile,
  };
});

vi.mock('./claude-task-runner.js', () => ({
  runApprovedClaudeBrowserTask,
  runApprovedClaudeDocumentTask,
}));

vi.mock('./task-session.js', () => ({
  updateTaskSession,
  recordTaskSessionHistory,
}));

vi.mock('./secure-io.js', () => ({
  safeWriteFile,
}));

import { executeApprovedClaudeTaskSession } from './claude-task-session-executor.js';

describe('claude-task-session-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runApprovedClaudeBrowserTask.mockResolvedValue('browser output');
    runApprovedClaudeDocumentTask.mockResolvedValue('document output');
  });

  it('runs report/document sessions through the approved Claude document runner', async () => {
    const result = await executeApprovedClaudeTaskSession({
      session: {
        session_id: 'TSK-1',
        surface: 'presence',
        task_type: 'report_document',
        status: 'planning',
        mode: 'interactive',
        goal: { summary: 'Write report', success_condition: 'Done' },
        control: { interruptible: true, requires_approval: false, awaiting_user_input: false },
        history: [],
        updated_at: new Date().toISOString(),
      },
      queryText: 'Please write the report',
      agentId: 'mission_controller',
      channel: 'presence',
    });

    expect(runApprovedClaudeDocumentTask).toHaveBeenCalledTimes(1);
    expect(runApprovedClaudeBrowserTask).not.toHaveBeenCalled();
    expect(updateTaskSession).toHaveBeenCalledWith('TSK-1', expect.objectContaining({ status: 'completed' }));
    expect(recordTaskSessionHistory).toHaveBeenCalled();
    expect(result.kind).toBe('document');
    expect(result.output).toBe('document output');
    expect(safeWriteFile).toHaveBeenCalled();
  });

  it('runs browser sessions through the approved Claude browser runner', async () => {
    const result = await executeApprovedClaudeTaskSession({
      session: {
        session_id: 'TSK-2',
        surface: 'presence',
        task_type: 'browser',
        status: 'planning',
        mode: 'interactive',
        goal: { summary: 'Inspect page', success_condition: 'Done' },
        control: { interruptible: true, requires_approval: false, awaiting_user_input: false },
        history: [],
        updated_at: new Date().toISOString(),
      },
      queryText: 'Open the page and inspect it',
      agentId: 'mission_controller',
    });

    expect(runApprovedClaudeBrowserTask).toHaveBeenCalledTimes(1);
    expect(runApprovedClaudeDocumentTask).not.toHaveBeenCalled();
    expect(result.kind).toBe('browser');
  });
});
