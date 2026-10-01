import * as path from 'node:path';
import { getAgentManifest } from '../agent/agent-manifest.js';
import { ensureAgentRuntime, getAgentRuntimeHandle } from '../agent/agent-runtime-supervisor.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import type { SurfaceTenantIsolation } from './channel-surface-types.js';

/**
 * Team Channel E: the surface agent of an isolated (shared team channel) turn.
 *
 * One runtime per (agent, tenant, tier), so a lease is never shared across
 * tenants or disclosure tiers. It is launched in-process (the supervisor
 * daemon cannot carry the lockdown) with every tool, MCP server, setting
 * source and slash command disabled, from an empty working directory, so the
 * model answers only from what the turn hands it — never from the owner's
 * CLAUDE.md, auto-memory, hooks or files. Fails closed when the provider
 * cannot disable tools.
 */

const ISOLATED_SURFACE_ADDENDUM = [
  '## Shared team channel mode',
  '',
  'You are answering in a shared team channel, not to your owner. You have no tools and cannot delegate:',
  'never emit `a2a` blocks. Answer directly from the conversation and the reference data you are given.',
  'If the request needs real work, propose it with a `mission_proposal` block for a team member to confirm.',
  'Never reveal or guess at information that was not given to you in this turn.',
].join('\n');

export function isolatedSurfaceRuntimeId(
  agentId: string,
  isolation: SurfaceTenantIsolation
): string {
  return `${agentId}--tenant-${isolation.tenantSlug}--${isolation.maxTier}`;
}

export async function ensureIsolatedSurfaceAgent(
  agentId: string,
  isolation: SurfaceTenantIsolation
) {
  const runtimeId = isolatedSurfaceRuntimeId(agentId, isolation);
  const existing = getAgentRuntimeHandle(runtimeId);
  const record = existing?.getRecord?.();
  if (existing && record?.status !== 'shutdown' && record?.status !== 'error') {
    // Only a runtime this module launched (tool-less) may serve the turn.
    if (record?.metadata?.tool_access !== 'none') {
      throw new Error(
        `[TOOL_LOCKDOWN_MISMATCH] runtime ${runtimeId} exists without tool lockdown — shut it down before serving a team channel`
      );
    }
    return existing;
  }
  const manifest = getAgentManifest(agentId, pathResolver.rootDir());
  if (!manifest) throw new Error(`Surface agent manifest not found: ${agentId}`);
  const cwd = pathResolver.sharedTmp(
    path.join('isolated-surface', `${isolation.tenantSlug}-${isolation.maxTier}`)
  );
  safeMkdir(cwd, { recursive: true });
  return ensureAgentRuntime({
    agentId: runtimeId,
    provider: 'claude',
    systemPrompt: [manifest.systemPrompt, ISOLATED_SURFACE_ADDENDUM].filter(Boolean).join('\n\n'),
    capabilities: manifest.capabilities,
    cwd,
    requestedBy: 'surface_agent',
    runtimeOwnerId: runtimeId,
    runtimeOwnerType: 'surface',
    runtimeBackend: 'pipe',
    toolAccess: 'none',
    scope: { tenant_slug: isolation.tenantSlug, tier: isolation.maxTier },
    runtimeMetadata: {
      lease_kind: 'surface',
      surface_agent_id: agentId,
      tenant_slug: isolation.tenantSlug,
      tool_access: 'none',
    },
  });
}
