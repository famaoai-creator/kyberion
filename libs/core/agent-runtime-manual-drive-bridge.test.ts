import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  enqueueManualDriverCommand,
  resumeManualDriverCommand,
  cancelManualDriverCommand,
  readManualDriverCommandStatus,
  readManualDriverDescriptor,
  startManualDriverBridge,
} from './agent-runtime-manual-drive-bridge.js';
import { AgentRuntimeManualDriver } from './agent-runtime-manual-drive.js';
import { readJsonLines } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { withExecutionContext, withExecutionContextAsync } from './authority.js';

function bridgeFiles(agentId: string): string[] {
  const key = createHash('sha256').update(agentId).digest('hex');
  const root = pathResolver.shared('coordination/agent-runtime/manual-drive');
  return [
    path.join(root, `${key}.descriptor.json`),
    path.join(root, `${key}.commands.jsonl`),
    path.join(root, `${key}.cancellations.jsonl`),
    path.join(root, `${key}.results.jsonl`),
  ];
}

describe('durable manual-drive bridge', () => {
  it('rejects schema-invalid descriptors before bridge state projection', () => {
    withExecutionContext('mission_controller', () => {
      const agentId = `bridge-invalid-${process.pid}-${Date.now()}`;
      const descriptorPath = bridgeFiles(agentId)[0];
      safeMkdir(path.dirname(descriptorPath), { recursive: true });
      safeWriteFile(
        descriptorPath,
        JSON.stringify({
          version: 1,
          agent_id: agentId,
          owner_id: 'owner-invalid',
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
          status: 'online',
          updated_at: '2026-09-04T00:00:00.000Z',
          expires_at: '2099-09-04T00:00:00.000Z',
          action: null,
          unexpected: true,
        })
      );
      try {
        expect(() => readManualDriverDescriptor(agentId)).toThrow('[MANUAL_DRIVE_BRIDGE_CORRUPT]');
      } finally {
        safeRmSync(descriptorPath, { force: true });
      }
    });
  });

  it('publishes only safe action data and completes a queued command', async () => {
    return withExecutionContextAsync('mission_controller', async () => {
      const agentId = `bridge-test-${process.pid}-${Date.now()}`;
      const action = {
        action_id: 'step-1',
        kind: 'execute_tool' as const,
        title: 'Run a tool',
        description: 'operator-safe description',
        status: 'ready' as const,
        requires_approval: true,
        approval: { status: 'pending' as const, request_id: 'approval-1' },
      };
      const driver = {
        peekAction: vi.fn(async () => action),
        executeAction: vi.fn(async () => ({
          status: 'executed' as const,
          action,
          result: 'secret executor result',
          approval: { status: 'approved' as const, request_id: 'approval-1' },
        })),
      };
      let stop: (() => void) | undefined;
      try {
        stop = withExecutionContext('mission_controller', () =>
          startManualDriverBridge({
            agentId,
            driver,
            scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
            pollIntervalMs: 10,
          })
        );

        await vi.waitFor(() => {
          expect(readManualDriverDescriptor(agentId)?.action).toEqual(action);
        });
        const descriptor = readManualDriverDescriptor(agentId);
        expect(JSON.stringify(descriptor)).not.toContain('secret');

        const command = await withExecutionContext('mission_controller', () =>
          enqueueManualDriverCommand({
            agentId,
            actionId: action.action_id,
            requestedBy: 'chronos_agents_api',
          })
        );
        await vi.waitFor(() => {
          expect(readManualDriverCommandStatus(agentId, command.commandId)).toMatchObject({
            state: 'completed',
            status: 'executed',
            action,
            approval: { status: 'approved', request_id: 'approval-1' },
          });
        });
        expect(driver.executeAction).toHaveBeenCalledWith(action.action_id);
        expect(
          JSON.stringify(readManualDriverCommandStatus(agentId, command.commandId))
        ).not.toContain('secret executor result');

        expect(() =>
          withExecutionContext('mission_controller', () =>
            startManualDriverBridge({
              agentId,
              driver,
              scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
              pollIntervalMs: 10,
            })
          )
        ).toThrow('[MANUAL_DRIVE_BRIDGE_ACTIVE]');
      } finally {
        stop?.();
        withExecutionContext('mission_controller', () => {
          for (const file of bridgeFiles(agentId)) safeRmSync(file, { force: true });
        });
      }
    });
  });

  it('records a started command before execution and does not persist executor output', async () => {
    return withExecutionContextAsync('mission_controller', async () => {
      const agentId = `bridge-running-${process.pid}-${Date.now()}`;
      const action = {
        action_id: 'step-running',
        kind: 'hook' as const,
        title: 'Run hook',
        status: 'ready' as const,
      };
      let releaseExecution: (() => void) | undefined;
      const executionPaused = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      const driver = {
        peekAction: vi.fn(async () => action),
        executeAction: vi.fn(async () => {
          await executionPaused;
          return { status: 'executed' as const, action, result: { secret: true } };
        }),
      };
      let stop: (() => void) | undefined;
      try {
        stop = withExecutionContext('mission_controller', () =>
          startManualDriverBridge({
            agentId,
            driver,
            scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
            pollIntervalMs: 10,
          })
        );
        await vi.waitFor(() => expect(readManualDriverDescriptor(agentId)?.action).toEqual(action));
        const command = await withExecutionContext('mission_controller', () =>
          enqueueManualDriverCommand({
            agentId,
            actionId: action.action_id,
            requestedBy: 'test',
          })
        );
        expect(readManualDriverCommandStatus(agentId, command.commandId)).toMatchObject({
          state: 'queued',
          actionId: 'step-running',
        });
        await vi.waitFor(() => {
          expect(readManualDriverCommandStatus(agentId, command.commandId)).toMatchObject({
            state: 'running',
          });
        });
        await vi.waitFor(() => {
          expect(readJsonLines<Record<string, unknown>>(bridgeFiles(agentId)[3])).toEqual([
            expect.objectContaining({ phase: 'started', command_id: command.commandId }),
          ]);
        });
        releaseExecution?.();
        await vi.waitFor(() => {
          expect(readManualDriverCommandStatus(agentId, command.commandId)).toMatchObject({
            state: 'completed',
            status: 'executed',
          });
        });
        expect(JSON.stringify(readJsonLines(bridgeFiles(agentId)[3]))).not.toContain('secret');
      } finally {
        releaseExecution?.();
        stop?.();
        withExecutionContext('mission_controller', () => {
          for (const file of bridgeFiles(agentId)) safeRmSync(file, { force: true });
        });
      }
    });
  });

  it('cancels a pending command atomically before a worker can claim it', async () => {
    const agentId = `bridge-cancel-${process.pid}-${Date.now()}`;
    let stop: (() => void) | undefined;
    try {
      const command = await withExecutionContextAsync('mission_controller', () =>
        enqueueManualDriverCommand({
          agentId,
          actionId: 'step-cancel',
          requestedBy: 'test',
        })
      );
      await expect(
        withExecutionContextAsync('mission_controller', () =>
          cancelManualDriverCommand({
            agentId,
            commandId: command.commandId,
            cancelledBy: 'chronos_agents_api',
          })
        )
      ).resolves.toBe('cancelled');
      expect(readManualDriverCommandStatus(agentId, command.commandId)).toMatchObject({
        state: 'cancelled',
        actionId: 'step-cancel',
      });

      const executeAction = vi.fn(async () => ({ status: 'executed' as const }));
      stop = withExecutionContext('mission_controller', () =>
        startManualDriverBridge({
          agentId,
          driver: {
            peekAction: vi.fn(async () => null),
            executeAction,
          },
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
          pollIntervalMs: 10,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(executeAction).not.toHaveBeenCalled();
    } finally {
      stop?.();
      withExecutionContext('mission_controller', () => {
        for (const file of bridgeFiles(agentId)) safeRmSync(file, { force: true });
      });
    }
  });

  it('resumes an approval-waiting command only through a new linked command', async () => {
    return withExecutionContextAsync('mission_controller', async () => {
      const agentId = `bridge-resume-${process.pid}-${Date.now()}`;
      let approved = false;
      const action = {
        action_id: 'step-approval-resume',
        kind: 'execute_tool' as const,
        title: 'Approve then run',
        status: 'ready' as const,
        requires_approval: true,
      };
      const executeAction = vi.fn(async () => ({ status: 'executed' as const, action }));
      let stop: (() => void) | undefined;
      try {
        const driver = new AgentRuntimeManualDriver({
          nextAction: () => ({
            ...action,
            execute: executeAction,
          }),
          approvalGate: () =>
            approved
              ? { status: 'approved' as const, request_id: 'approval-resume' }
              : { status: 'pending' as const, request_id: 'approval-resume' },
        });
        stop = withExecutionContext('mission_controller', () =>
          startManualDriverBridge({
            agentId,
            driver,
            scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
            pollIntervalMs: 10,
          })
        );
        await vi.waitFor(() =>
          expect(readManualDriverDescriptor(agentId)?.action?.status).toBe('awaiting_approval')
        );
        const command = await enqueueManualDriverCommand({
          agentId,
          actionId: action.action_id,
          requestedBy: 'chronos',
        });
        await vi.waitFor(() =>
          expect(readManualDriverCommandStatus(agentId, command.commandId)).toMatchObject({
            state: 'completed',
            status: 'awaiting_approval',
          })
        );
        approved = true;
        const resumed = await resumeManualDriverCommand({
          agentId,
          commandId: command.commandId,
          resumedBy: 'chronos',
        });
        expect(resumed).toMatchObject({
          actionId: action.action_id,
          resumesCommandId: command.commandId,
        });
        await vi.waitFor(() =>
          expect(readManualDriverCommandStatus(agentId, resumed.commandId)).toMatchObject({
            state: 'completed',
            status: 'executed',
            resumesCommandId: command.commandId,
          })
        );
        expect(executeAction).toHaveBeenCalledOnce();
        await expect(
          resumeManualDriverCommand({
            agentId,
            commandId: command.commandId,
            resumedBy: 'chronos',
          })
        ).rejects.toThrow('[MANUAL_DRIVE_COMMAND_ALREADY_RESUMED]');
      } finally {
        stop?.();
        withExecutionContext('mission_controller', () => {
          for (const file of bridgeFiles(agentId)) safeRmSync(file, { force: true });
        });
      }
    });
  });
});
