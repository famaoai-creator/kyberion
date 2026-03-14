import { NextRequest, NextResponse } from "next/server";
import { agentRegistry } from "@agent/core/agent-registry";
import { agentLifecycle } from "@agent/core/agent-lifecycle";
import { a2aBridge } from "@agent/core/a2a-bridge";
import { loadAgentManifests } from "@agent/core/agent-manifest";
import { discoverProviders } from "@agent/core/provider-discovery";
import { guardRequest } from "../../../lib/api-guard";

/**
 * /api/agents - Thin wrapper over Agent-Actuator
 *
 * GET    → health (list all agents with status)
 * POST   → spawn / ask / a2a (via action field)
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
    const agents = agentRegistry.list().map(a => ({
      agentId: a.agentId,
      provider: a.provider,
      modelId: a.modelId,
      status: a.status,
      capabilities: a.capabilities,
      trustScore: a.trustScore,
      uptimeMs: Date.now() - a.spawnedAt,
      idleMs: Date.now() - a.lastActivity,
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
        const handle = await agentLifecycle.spawn({
          agentId: body.agentId,
          provider: body.provider,
          modelId: body.modelId,
          systemPrompt: body.systemPrompt,
          capabilities: body.capabilities,
        });
        return NextResponse.json({ status: "spawned", agent: handle.getRecord() });
      }
      case "logs": {
        if (!body.agentId) return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
        const logs = agentLifecycle.getLog(body.agentId, body.limit || 50);
        return NextResponse.json({ status: "ok", agentId: body.agentId, logs });
      }
      case "ask": {
        if (!body.agentId || !body.query) return NextResponse.json({ error: "Missing agentId or query" }, { status: 400 });
        const handle = agentLifecycle.getHandle(body.agentId);
        if (!handle) return NextResponse.json({ error: `Agent ${body.agentId} not found or not ready` }, { status: 404 });
        const response = await handle.ask(body.query);
        return NextResponse.json({ status: "ok", agentId: body.agentId, response });
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
    await agentLifecycle.shutdown(body.agentId);
    return NextResponse.json({ status: "shutdown", agentId: body.agentId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
