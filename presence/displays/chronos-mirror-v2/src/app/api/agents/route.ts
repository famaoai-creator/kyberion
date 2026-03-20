import { NextRequest, NextResponse } from "next/server";
import { getChronosAccessRoleOrThrow, guardRequest, requireChronosAccess, roleToMissionRole } from "../../../lib/api-guard";

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
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const [{ discoverProviders }, { loadAgentManifests }, { agentRegistry }, runtimeSupervisor] = await Promise.all([
      import("@agent/core/provider-discovery"),
      import("@agent/core/agent-manifest"),
      import("@agent/core/agent-registry"),
      import("@agent/core/agent-runtime-supervisor"),
    ]);

    // ?providers=true returns installed provider info with models
    if (req.nextUrl.searchParams.get("providers") === "true") {
      const providers = discoverProviders(req.nextUrl.searchParams.get("refresh") === "true");
      return NextResponse.json({ status: "ok", accessRole, providers });
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
      return NextResponse.json({ status: "ok", accessRole, manifests });
    }

    const snapshot = agentRegistry.getHealthSnapshot();
    const agents = runtimeSupervisor.listAgentRuntimeSnapshots().map((entry) => ({
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
    return NextResponse.json({ status: "ok", accessRole, ...snapshot, agents });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const body = await req.json();
    const action = body.action || "spawn";
    const runtimeSupervisor = await import("@agent/core/agent-runtime-supervisor");

    switch (action) {
      case "spawn": {
        const forbidden = requireChronosAccess(req, "localadmin");
        if (forbidden) return forbidden;
        if (!body.provider) return NextResponse.json({ error: "Missing provider" }, { status: 400 });
        const handle = await runtimeSupervisor.ensureAgentRuntime({
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
        const logs = runtimeSupervisor.getAgentRuntimeLog(body.agentId, body.limit || 50);
        return NextResponse.json({ status: "ok", agentId: body.agentId, logs });
      }
      case "snapshot": {
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const snapshot = runtimeSupervisor.getAgentRuntimeSnapshot(body.agentId, body.logLimit || 50);
        if (!snapshot) return NextResponse.json({ error: `Agent ${body.agentId} not found` }, { status: 404 });
        return NextResponse.json({ status: "ok", snapshot });
      }
      case "ask": {
        const forbidden = requireChronosAccess(req, "localadmin");
        if (forbidden) return forbidden;
        if (!body.agentId || !body.query) return NextResponse.json({ error: "Missing agentId or query" }, { status: 400 });
        const handle = runtimeSupervisor.getAgentRuntimeHandle(body.agentId);
        if (!handle) return NextResponse.json({ error: `Agent ${body.agentId} not found or not ready` }, { status: 404 });
        const response = await handle.ask(body.query);
        return NextResponse.json({ status: "ok", agentId: body.agentId, response });
      }
      case "refresh": {
        const forbidden = requireChronosAccess(req, "localadmin");
        if (forbidden) return forbidden;
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const result = await runtimeSupervisor.refreshAgentRuntime(body.agentId, "chronos_agents_api");
        return NextResponse.json({ status: "ok", agentId: body.agentId, ...result });
      }
      case "restart": {
        const forbidden = requireChronosAccess(req, "localadmin");
        if (forbidden) return forbidden;
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const handle = await runtimeSupervisor.restartAgentRuntime(body.agentId, "chronos_agents_api");
        return NextResponse.json({ status: "ok", agentId: body.agentId, agent: handle.getRecord(), snapshot: runtimeSupervisor.getAgentRuntimeSnapshot(body.agentId) });
      }
      case "a2a": {
        const forbidden = requireChronosAccess(req, "localadmin");
        if (forbidden) return forbidden;
        if (!body.envelope?.header) return NextResponse.json({ error: "Invalid A2A envelope" }, { status: 400 });
        const { a2aBridge } = await import("@agent/core/a2a-bridge");
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
    const forbidden = requireChronosAccess(req, "localadmin");
    if (forbidden) return forbidden;
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const body = await req.json();
    if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
    const { stopAgentRuntime } = await import("@agent/core/agent-runtime-supervisor");
    await stopAgentRuntime(body.agentId, "chronos_agents_api");
    return NextResponse.json({ status: "shutdown", agentId: body.agentId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
