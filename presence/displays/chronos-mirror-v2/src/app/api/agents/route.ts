import { NextRequest, NextResponse } from "next/server";
import { agentRegistry } from "@agent/core/dist/agent-registry.js";
import { a2aBridge } from "@agent/core/dist/a2a-bridge.js";
import { loadAgentManifests } from "@agent/core/dist/agent-manifest.js";
import { discoverProviders } from "@agent/core/dist/provider-discovery.js";
import {
  ensureAgentRuntime,
  getAgentRuntimeHandle,
  getAgentRuntimeLog,
  getAgentRuntimeSnapshot,
  listAgentRuntimeSnapshots,
  refreshAgentRuntime,
  restartAgentRuntime,
  stopAgentRuntime,
} from "@agent/core/dist/agent-runtime-supervisor.js";
import { guardRequest } from "../../../lib/api-guard";

/**
 * /api/agents - Thin wrapper over Agent-Actuator
 *
 * GET    → health (list all agents with runtime snapshots)
 * POST   → spawn / ask / a2a / logs / refresh / restart (via action field)
 * DELETE → shutdown
 */

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    // ?providers=true returns installed provider info with models
    if (req.nextUrl.searchParams.get("providers") === "true") {
      const providers = discoverProviders(req.nextUrl.searchParams.get("refresh") === "true");
      return NextResponse.json({ status: "ok", providers });
    }

    // ?manifests=true returns available agent definitions
    if (req.nextUrl.searchParams.get("manifests") === "true") {
      const manifests = loadAgentManifests().map(m => ({
        agentId: m.agentId,
        provider: m.provider,
        modelId: m.modelId,
        capabilities: m.capabilities,
        trustRequired: m.trustRequired,
        requiresEnv: m.requires.env || [],
      }));
      return NextResponse.json({ status: "ok", manifests });
    }

    const snapshot = agentRegistry.getHealthSnapshot();
    const agents = listAgentRuntimeSnapshots().map((entry) => ({
      agentId: entry.agent.agentId,
      provider: entry.agent.provider,
      modelId: entry.agent.modelId,
      status: entry.agent.status,
      capabilities: entry.agent.capabilities,
      trustScore: entry.agent.trustScore,
      uptimeMs: Date.now() - entry.agent.spawnedAt,
      idleMs: Date.now() - entry.agent.lastActivity,
      runtime: entry.runtime ? {
        kind: entry.runtime.kind,
        state: entry.runtime.state,
        pid: entry.runtime.pid,
        idleForMs: entry.runtime.idleForMs,
        shutdownPolicy: entry.runtime.shutdownPolicy,
      } : null,
      metrics: entry.metrics,
      process: entry.process || null,
      supportsSoftRefresh: entry.supportsSoftRefresh,
      providerRuntime: entry.providerRuntime || {},
    }));
    return NextResponse.json({ status: "ok", ...snapshot, agents });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const action = body.action || "spawn";

    switch (action) {
      case "spawn": {
        if (!body.provider) return NextResponse.json({ error: "Missing provider" }, { status: 400 });
        const handle = await ensureAgentRuntime({
          agentId: body.agentId,
          provider: body.provider,
          modelId: body.modelId,
          systemPrompt: body.systemPrompt,
          capabilities: body.capabilities,
          requestedBy: "chronos_agents_api",
        });
        return NextResponse.json({ status: "spawned", agent: handle.getRecord() });
      }
      case "logs": {
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const logs = getAgentRuntimeLog(body.agentId, body.limit || 50);
        return NextResponse.json({ status: "ok", agentId: body.agentId, logs });
      }
      case "snapshot": {
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const snapshot = getAgentRuntimeSnapshot(body.agentId, body.logLimit || 50);
        if (!snapshot) return NextResponse.json({ error: `Agent ${body.agentId} not found` }, { status: 404 });
        return NextResponse.json({ status: "ok", snapshot });
      }
      case "ask": {
        if (!body.agentId || !body.query) return NextResponse.json({ error: "Missing agentId or query" }, { status: 400 });
        const handle = getAgentRuntimeHandle(body.agentId);
        if (!handle) return NextResponse.json({ error: `Agent ${body.agentId} not found or not ready` }, { status: 404 });
        const response = await handle.ask(body.query);
        return NextResponse.json({ status: "ok", agentId: body.agentId, response });
      }
      case "refresh": {
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const result = await refreshAgentRuntime(body.agentId, "chronos_agents_api");
        return NextResponse.json({ status: "ok", agentId: body.agentId, ...result });
      }
      case "restart": {
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const handle = await restartAgentRuntime(body.agentId, "chronos_agents_api");
        return NextResponse.json({ status: "ok", agentId: body.agentId, agent: handle.getRecord(), snapshot: getAgentRuntimeSnapshot(body.agentId) });
      }
      case "a2a": {
        if (!body.envelope?.header) return NextResponse.json({ error: "Invalid A2A envelope" }, { status: 400 });
        const response = await a2aBridge.route(body.envelope);
        return NextResponse.json({ status: "ok", response });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
    await stopAgentRuntime(body.agentId, "chronos_agents_api");
    return NextResponse.json({ status: "shutdown", agentId: body.agentId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
