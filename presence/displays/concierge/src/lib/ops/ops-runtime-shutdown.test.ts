import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  OPS_CONSOLE_AGENT_ID,
  OPS_CONSOLE_PLUGIN_SURFACE,
  stopOpsConsoleRuntime,
} from './ops-runtime-shutdown';

const holder = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete holder.__kyberionChronosHandle;
  delete holder.__kyberionChronosIdleTimer;
  delete holder.__kyberionDiscussionEngines;
});

describe('operations console shutdown', () => {
  it('stops the agent runtime, running discussions, the plugin host and poll loops', async () => {
    holder.__kyberionChronosHandle = { getRecord: () => ({ status: 'ready' }) };
    holder.__kyberionChronosIdleTimer = setTimeout(() => undefined, 60_000);
    holder.__kyberionDiscussionEngines = new Map([['room-a', Promise.resolve()]]);
    const deps = {
      stopAgentRuntime: vi.fn(async () => undefined),
      stopDiscussionGeneration: vi.fn(() => true),
      disposePluginHost: vi.fn(),
      stopAllBridgePollLoops: vi.fn(() => ['ops-stream']),
    };
    const report = await stopOpsConsoleRuntime(deps);
    expect(deps.stopAgentRuntime).toHaveBeenCalledWith(OPS_CONSOLE_AGENT_ID, 'concierge_shutdown');
    expect(deps.stopDiscussionGeneration).toHaveBeenCalledWith('room-a');
    expect(deps.disposePluginHost).toHaveBeenCalledWith(OPS_CONSOLE_PLUGIN_SURFACE);
    expect(report).toEqual({
      agentRuntimeStopped: true,
      discussionsStopped: ['room-a'],
      pollLoopsStopped: ['ops-stream'],
    });
    expect(holder.__kyberionChronosHandle).toBeNull();
    expect(holder.__kyberionChronosIdleTimer).toBeNull();
  });

  it('keeps going when a step fails and skips the runtime when none was started', async () => {
    const deps = {
      stopAgentRuntime: vi.fn(async () => undefined),
      stopDiscussionGeneration: vi.fn(() => true),
      disposePluginHost: vi.fn(() => {
        throw new Error('host stuck');
      }),
      stopAllBridgePollLoops: vi.fn(() => []),
    };
    const report = await stopOpsConsoleRuntime(deps);
    expect(deps.stopAgentRuntime).not.toHaveBeenCalled();
    expect(deps.stopAllBridgePollLoops).toHaveBeenCalled();
    expect(report.agentRuntimeStopped).toBe(false);
  });

  it('is called by the local server on close', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('presence/displays/concierge/server/local-server.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('await stopOpsConsoleRuntime();');
  });
});
