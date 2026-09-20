/**
 * Live pane-runtime demo: spawn + ask, leave the pane open for inspection.
 *
 *   KYBERION_AGENT_RUNTIME_BACKEND=pane \
 *   KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL=kyberion-live \
 *   pnpm exec tsx scripts/demo_agent_pane_runtime_live.ts
 */

import { agentLifecycle } from '@agent/core/agent-lifecycle';
import { pathResolver } from '@agent/core/path-resolver';

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

async function main(): Promise<void> {
  setEnv('KYBERION_AGENT_RUNTIME_BACKEND', 'pane');
  const label = readEnv('KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL') || 'kyberion-live';
  setEnv('KYBERION_AGENT_PANE_RUNTIME_WORKSPACE_LABEL', label);

  const agentId = `pane-live-${Date.now().toString(36)}`;
  console.log(`[live] spawning ${agentId}`);
  console.log(`[live] open your terminal multiplexer → workspace "${label}"`);

  const handle = await agentLifecycle.spawn({
    agentId,
    provider: 'claude',
    cwd: pathResolver.rootDir(),
    turnTimeoutMs: 180_000,
    runtimeBackend: 'pane',
    runtimeMetadata: { skip_provider_resolution: true },
  });

  const snap = agentLifecycle.getSnapshot(agentId);
  console.log('[live] runtime:', JSON.stringify(snap?.providerRuntime, null, 2));

  console.log('[live] asking…');
  const answer = await handle.ask(
    'You are being demoed live in an operator-visible pane. Reply in 2 short sentences: (1) confirm you are Claude in this pane, (2) say PANE_LIVE_OK.'
  );
  console.log('[live] answer:\n' + answer);
  console.log('[live] leaving agent running (no shutdown)');
  console.log(`[live] agent id: ${agentId}`);
}

main().catch((error: unknown) => {
  console.error('[live] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
