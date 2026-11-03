/**
 * Process-wide state the operations console routes (`/api/ops`, the former
 * Chronos surface) keep on `globalThis` so every route bundle shares it:
 *   - the console's in-process agent runtime handle + its idle timer
 *     (`/api/ops/agent`),
 *   - the discussion engine registry (`/api/ops/discussions`),
 *   - the console plugin host (surface key `chronos`),
 *   - the SSE poll loops (`/api/ops/*\/stream`).
 * Chronos stopped these with its process. Inside Concierge the local server
 * calls `stopOpsConsoleRuntime()` on close so nothing outlives the listener.
 *
 * Executed directly by Node from server/local-server.ts as well as bundled,
 * so only erasable TypeScript and package imports are used here.
 */
import { createLogger } from '@agent/core/logger';

const logger = createLogger('concierge-ops-shutdown');

/** Same keys as app/api/ops/agent/route.ts and libs/core discussion-engine. */
const AGENT_HANDLE_KEY = '__kyberionChronosHandle';
const AGENT_READY_KEY = '__kyberionChronosReady';
const AGENT_IDLE_TIMER_KEY = '__kyberionChronosIdleTimer';
const DISCUSSION_REGISTRY_KEY = '__kyberionDiscussionEngines';
export const OPS_CONSOLE_AGENT_ID = 'chronos-mirror';
export const OPS_CONSOLE_PLUGIN_SURFACE = 'chronos';

export interface OpsConsoleShutdownDeps {
  stopAgentRuntime?: (agentId: string, requestedBy: string) => Promise<void>;
  stopDiscussionGeneration?: (roomId: string) => boolean;
  disposePluginHost?: (surface: string) => void;
  stopAllBridgePollLoops?: () => string[];
}

export interface OpsConsoleShutdownReport {
  agentRuntimeStopped: boolean;
  discussionsStopped: string[];
  pollLoopsStopped: string[];
}

async function loadDefaults(): Promise<Required<OpsConsoleShutdownDeps>> {
  const [supervisor, dialogue, pluginHost, pollLoop] = await Promise.all([
    import('@agent/core/agent/agent-runtime-supervisor'),
    import('@agent/core/discussion/discussion-dialogue-actions'),
    import('@agent/core/plugin/plugin-host'),
    import('@agent/core/bridge-poll-loop'),
  ]);
  return {
    stopAgentRuntime: supervisor.stopAgentRuntime,
    stopDiscussionGeneration: dialogue.stopDiscussionGeneration,
    disposePluginHost: pluginHost.disposePluginHost,
    stopAllBridgePollLoops: pollLoop.stopAllBridgePollLoops,
  };
}

/** Best-effort: every step runs even when an earlier one fails. Never throws. */
export async function stopOpsConsoleRuntime(
  deps: OpsConsoleShutdownDeps = {}
): Promise<OpsConsoleShutdownReport> {
  const report: OpsConsoleShutdownReport = {
    agentRuntimeStopped: false,
    discussionsStopped: [],
    pollLoopsStopped: [],
  };
  let defaults: Required<OpsConsoleShutdownDeps> | undefined;
  const resolve = async <K extends keyof OpsConsoleShutdownDeps>(
    key: K
  ): Promise<Required<OpsConsoleShutdownDeps>[K]> => {
    const injected = deps[key];
    if (injected) return injected as Required<OpsConsoleShutdownDeps>[K];
    defaults ??= await loadDefaults();
    return defaults[key];
  };
  const holder = globalThis as unknown as Record<string, unknown>;
  const step = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (error) {
      logger.warn(
        `Ops console shutdown step failed — ${name}: ${error instanceof Error ? error.message : String(error)} | continuing shutdown`
      );
    }
  };

  await step('agent runtime', async () => {
    const timer = holder[AGENT_IDLE_TIMER_KEY] as ReturnType<typeof setTimeout> | null | undefined;
    if (timer) clearTimeout(timer);
    holder[AGENT_IDLE_TIMER_KEY] = null;
    const hadHandle = Boolean(holder[AGENT_HANDLE_KEY]);
    holder[AGENT_HANDLE_KEY] = null;
    holder[AGENT_READY_KEY] = null;
    if (!hadHandle) return;
    await (
      await resolve('stopAgentRuntime')
    )(OPS_CONSOLE_AGENT_ID, 'concierge_shutdown');
    report.agentRuntimeStopped = true;
  });

  await step('discussions', async () => {
    const registry = holder[DISCUSSION_REGISTRY_KEY];
    if (!(registry instanceof Map) || registry.size === 0) return;
    const stop = await resolve('stopDiscussionGeneration');
    for (const roomId of [...registry.keys()].map(String)) {
      if (stop(roomId)) report.discussionsStopped.push(roomId);
    }
  });

  await step('plugin host', async () => {
    (await resolve('disposePluginHost'))(OPS_CONSOLE_PLUGIN_SURFACE);
  });

  await step('poll loops', async () => {
    report.pollLoopsStopped = (await resolve('stopAllBridgePollLoops'))();
  });

  return report;
}
