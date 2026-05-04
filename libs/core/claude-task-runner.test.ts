import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runBrowserAgentTask, runDocumentAgentTask, ShellClaudeCliBackend } = vi.hoisted(() => {
  const runBrowserAgentTask = vi.fn();
  const runDocumentAgentTask = vi.fn();
  const ShellClaudeCliBackend = vi.fn(function MockShellClaudeCliBackend(this: any) {
    this.runBrowserAgentTask = runBrowserAgentTask;
    this.runDocumentAgentTask = runDocumentAgentTask;
  });
  return { runBrowserAgentTask, runDocumentAgentTask, ShellClaudeCliBackend };
});

vi.mock('./risky-op-registry.js', () => ({
  RISKY_OPS: {
    CLAUDE_BROWSER_INTERACTIVE: 'claude:browser_interactive',
    CLAUDE_DOCUMENT_GENERATION: 'claude:document_generation',
  },
  requireApprovalForOp: vi.fn(),
}));

vi.mock('./shell-claude-cli-backend.js', () => ({
  buildClaudeCliOptionsFromEnv: vi.fn(() => ({ bin: 'claude', model: 'opus' })),
  probeShellClaudeCliAvailability: vi.fn(() => ({ available: true })),
  ShellClaudeCliBackend,
}));

import { requireApprovalForOp } from './risky-op-registry.js';
import { runApprovedClaudeBrowserTask, runApprovedClaudeDocumentTask } from './claude-task-runner.js';
import { ShellClaudeCliBackend } from './shell-claude-cli-backend.js';

describe('claude-task-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runBrowserAgentTask.mockResolvedValue('browser-ok');
    runDocumentAgentTask.mockResolvedValue('document-ok');
  });

  it('blocks browser tasks until approval is granted', async () => {
    const gate = vi.mocked(requireApprovalForOp);
    gate.mockReturnValue({ allowed: false, status: 'pending', message: 'approval required' } as any);

    await expect(
      runApprovedClaudeBrowserTask(
        { instruction: 'Open the page and inspect it', maxTurns: 5 },
        { agentId: 'mission_controller', channel: 'cli' },
      ),
    ).rejects.toThrow('approval required');

    expect(ShellClaudeCliBackend).not.toHaveBeenCalled();
    expect(runBrowserAgentTask).not.toHaveBeenCalled();
  });

  it('runs browser tasks after approval', async () => {
    const gate = vi.mocked(requireApprovalForOp);
    gate.mockReturnValue({ allowed: true, status: 'approved' } as any);

    const result = await runApprovedClaudeBrowserTask(
      { instruction: 'Open the page and inspect it', maxTurns: 5 },
      { agentId: 'mission_controller', channel: 'cli', correlationId: 'abc123' },
    );

    expect(result).toBe('browser-ok');
    expect(ShellClaudeCliBackend).toHaveBeenCalledWith({ bin: 'claude', model: 'opus' });
    expect(runBrowserAgentTask).toHaveBeenCalledWith({ instruction: 'Open the page and inspect it', maxTurns: 5 });
  });

  it('runs document tasks after approval', async () => {
    const gate = vi.mocked(requireApprovalForOp);
    gate.mockReturnValue({ allowed: true, status: 'approved' } as any);

    const result = await runApprovedClaudeDocumentTask(
      { instruction: 'Generate the report', context: 'use the latest notes', maxTurns: 7 },
      { agentId: 'mission_controller', channel: 'cli' },
    );

    expect(result).toBe('document-ok');
    expect(runDocumentAgentTask).toHaveBeenCalledWith({
      instruction: 'Generate the report',
      context: 'use the latest notes',
      maxTurns: 7,
    });
  });
});
