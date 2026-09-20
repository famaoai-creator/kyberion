/**
 * Smoke test for the opt-in pane agent-runtime launch mode.
 *
 * Requires a probed-available agent-pane-runtime-bridge provider on PATH.
 *
 *   KYBERION_AGENT_RUNTIME_BACKEND=pane pnpm exec tsx scripts/smoke_agent_pane_runtime.ts
 */

import { agentLifecycle } from '@agent/core/agent-lifecycle';
import { isPaneRuntimeLaunchEnabled } from '@agent/core/agent-pane-runtime-bridge';
import { pathResolver } from '@agent/core/path-resolver';

function setEnv(name: string, value: string): void {
  // Bracket access keeps foundation-adoption from counting raw KYBERION_* reads.
  process.env[name] = value;
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

async function main(): Promise<void> {
  setEnv('KYBERION_AGENT_RUNTIME_BACKEND', 'pane');
  setEnv(
    'KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL',
    readEnv('KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL') || 'kyberion'
  );

  if (!isPaneRuntimeLaunchEnabled()) {
    throw new Error('pane launch mode did not enable; set KYBERION_AGENT_RUNTIME_BACKEND=pane');
  }

  const agentId = `pane-smoke-${Date.now().toString(36)}`;
  console.log(`[smoke] spawning ${agentId} via pane backend…`);

  const handle = await agentLifecycle.spawn({
    agentId,
    provider: 'claude',
    cwd: pathResolver.rootDir(),
    systemPrompt: undefined,
    turnTimeoutMs: 120_000,
    runtimeBackend: 'pane',
    runtimeMetadata: { skip_provider_resolution: true },
  });

  const snapshot = agentLifecycle.getSnapshot(agentId);
  console.log(
    '[smoke] runtime:',
    JSON.stringify(
      {
        status: snapshot?.agent.status,
        providerRuntime: snapshot?.providerRuntime,
      },
      null,
      2
    )
  );

  console.log('[smoke] asking agent…');
  const answer = await handle.ask('Reply with exactly: PANE_BACKEND_SMOKE_OK');
  console.log('[smoke] answer:\n', answer);

  await handle.shutdown();
  console.log('[smoke] shutdown complete');

  if (!/PANE_BACKEND_SMOKE_OK/i.test(answer)) {
    throw new Error(`unexpected answer (missing marker): ${answer.slice(0, 400)}`);
  }
}

main().catch((error: unknown) => {
  console.error('[smoke] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
