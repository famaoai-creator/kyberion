import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same hermetic seams as worker-goal-driver.test.ts: no disk writes.
vi.mock('../core.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return { ...actual, safeAppendFileSync: vi.fn(), safeMkdir: vi.fn(), safeWriteFile: vi.fn() };
});
vi.mock('../governance/kill-switch.js', () => ({ recordGovernanceAction: vi.fn() }));

import type { GenerateWithToolsResult } from '../reasoning/reasoning-backend.js';
import { runGoalDrivenLoop } from './worker-goal-driver.js';
import { resetDefaultWorkerEventStream } from './worker-event-stream.js';
import {
  buildGoalToolCallAuditEntry,
  digestToolInput,
  GOAL_TOOL_CALL_AUDIT_ACTION,
  type GoalToolCallAuditEntry,
} from './goal-tool-audit.js';

function scripted(script: GenerateWithToolsResult[], name = 'shell-claude-cli') {
  let index = 0;
  return {
    name,
    async generateWithTools(): Promise<GenerateWithToolsResult> {
      const result = script[index] ?? {
        toolCalls: [{ name: 'goal_update', input: { status: 'complete' } }],
      };
      index += 1;
      return result;
    },
  };
}

describe('digestToolInput', () => {
  it('is key-order independent and never contains the raw value', () => {
    const a = digestToolInput({ secret: 'hunter2', path: 'x' });
    const b = digestToolInput({ path: 'x', secret: 'hunter2' });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toContain('hunter2');
    expect(digestToolInput({ secret: 'other' })).not.toBe(a);
  });

  it('maps statuses onto audit results', () => {
    const base = {
      actorId: 'dot:d1',
      goalId: 'g1',
      turn: 1,
      toolName: 't',
      input: {},
      backend: 'b',
    };
    expect(buildGoalToolCallAuditEntry({ ...base, status: 'ok' }).result).toBe('completed');
    expect(buildGoalToolCallAuditEntry({ ...base, status: 'error' }).result).toBe('error');
    expect(buildGoalToolCallAuditEntry({ ...base, status: 'refused' }).result).toBe('denied');
  });
});

describe('runGoalDrivenLoop — tool-call audit', () => {
  beforeEach(() => resetDefaultWorkerEventStream());

  it('writes one audit record per handled tool call with a digest, not the raw input', async () => {
    const entries: GoalToolCallAuditEntry[] = [];
    const secretInput = { query: 'customer account 4111-1111' };
    const backend = scripted(
      [
        {
          toolCalls: [
            { name: 'lookup', input: secretInput },
            { name: 'explode', input: { n: 1 } },
          ],
          servedBy: 'claude-cli',
        },
      ],
      'failover'
    );
    let thrown: unknown;
    try {
      await runGoalDrivenLoop({
        objective: 'audit me',
        goalId: 'goal-audit-1',
        missionId: 'MSN-AUDIT',
        actorId: 'dot:repo-guardian',
        backend,
        extraTools: [
          { name: 'lookup', description: 'l', inputSchema: { type: 'object', properties: {} } },
          { name: 'explode', description: 'e', inputSchema: { type: 'object', properties: {} } },
        ],
        executeTool: (call) => {
          if (call.name === 'explode') throw new Error('[TOOL_BOOM] failed for 4111-1111');
          return { resultText: 'found' };
        },
        auditToolCall: (entry) => entries.push(entry),
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('TOOL_BOOM');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      agentId: 'dot:repo-guardian',
      action: GOAL_TOOL_CALL_AUDIT_ACTION,
      operation: 'lookup',
      result: 'completed',
      metadata: {
        goal_id: 'goal-audit-1',
        mission_id: 'MSN-AUDIT',
        turn: 1,
        tool: 'lookup',
        status: 'ok',
        backend: 'claude-cli',
        input_digest: digestToolInput(secretInput),
      },
    });
    expect(entries[1]).toMatchObject({
      operation: 'explode',
      result: 'error',
      reason: 'TOOL_BOOM',
      metadata: { status: 'error' },
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('4111-1111');
    expect(serialized).not.toContain('customer account');
  });

  it('records goal_update and refused calls, falling back to the backend name', async () => {
    const entries: GoalToolCallAuditEntry[] = [];
    await runGoalDrivenLoop({
      objective: 'finish',
      goalId: 'goal-audit-2',
      backend: scripted([
        {
          toolCalls: [
            { name: 'unrouted', input: {} },
            { name: 'goal_update', input: { status: 'complete' } },
          ],
        },
      ]),
      auditToolCall: (entry) => entries.push(entry),
    });
    expect(entries.map((entry) => [entry.operation, entry.metadata?.status])).toEqual([
      ['unrouted', 'refused'],
      ['goal_update', 'ok'],
    ]);
    expect(entries[0]?.reason).toBe('no_executor');
    expect(entries[0]?.agentId).toBe('goal-driver');
    expect(entries[1]?.metadata?.backend).toBe('shell-claude-cli');
  });
});
