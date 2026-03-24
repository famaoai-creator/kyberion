import { NextRequest } from "next/server";
import { collectA2AHandoffs, collectAgentMessages } from "../../../../lib/agent-message-feed";
import { buildRuntimeTopology } from "../../../../lib/runtime-topology";
import {
  collectBrowserSessions,
  collectControlActionDetails,
  collectControlActions,
  collectOwnerSummaries,
  collectRecentEvents,
} from "../../../../lib/intelligence-observations";
import { getChronosAccessRoleOrThrow, guardRequest, roleToMissionRole } from "../../../../lib/api-guard";
import { listAgentRuntimeLeaseSummaries, listAgentRuntimeSnapshots, loadSurfaceManifest, loadSurfaceState, normalizeSurfaceDefinition } from "@agent/core";

export const runtime = "nodejs";

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function collectManagedRuntimeTopology() {
  const runtimeSupervisorClient = await import("@agent/core/agent-runtime-supervisor-client");
  const runtimeSnapshots = listAgentRuntimeSnapshots();
  const runtimeLeases = listAgentRuntimeLeaseSummaries();
  let managedRuntimes: Array<{
    agentId: string;
    provider: string;
    modelId?: string;
    status: string;
    ownerId: string;
    ownerType: string;
    requestedBy?: string;
    leaseKind?: string;
    pid?: number;
    metadata?: Record<string, unknown>;
  }> = [];

  try {
    const daemonRuntimes = await runtimeSupervisorClient.listAgentRuntimesViaDaemon();
    managedRuntimes = daemonRuntimes.map((entry) => ({
      agentId: entry.agent_id,
      provider: entry.provider || "unknown",
      modelId: entry.model_id || undefined,
      status: entry.status || "unknown",
      ownerId: entry.owner_id || "unowned",
      ownerType: entry.owner_type || "unknown",
      requestedBy: typeof entry.metadata?.requestedBy === "string" ? entry.metadata.requestedBy : undefined,
      leaseKind: typeof entry.metadata?.lease_kind === "string" ? entry.metadata.lease_kind : undefined,
      pid: entry.pid,
      metadata: entry.metadata || undefined,
    }));
  } catch {
    managedRuntimes = runtimeLeases.map((lease) => {
      const snapshot = runtimeSnapshots.find((entry) => entry.agent.agentId === lease.agent_id);
      return {
        agentId: lease.agent_id,
        provider: snapshot?.agent.provider || "unknown",
        modelId: snapshot?.agent.modelId,
        status: snapshot?.agent.status || "unknown",
        ownerId: lease.owner_id,
        ownerType: lease.owner_type,
        requestedBy: typeof lease.metadata?.requestedBy === "string" ? lease.metadata.requestedBy : undefined,
        leaseKind: typeof lease.metadata?.execution_mode === "string" ? lease.metadata.execution_mode : undefined,
        pid: snapshot?.runtime?.pid,
        metadata: lease.metadata,
      };
    });
  }

  return {
    managedRuntimes,
    surfaces: loadSurfaceManifest().surfaces
      .map(normalizeSurfaceDefinition)
      .map((surface) => {
        const record = loadSurfaceState().surfaces[surface.id];
        return {
          id: surface.id,
          kind: surface.kind,
          running: Boolean(record),
          startupMode: surface.startupMode,
          pid: record?.pid,
        };
      }),
    runtimeSummary: {
      total: runtimeSnapshots.length,
      ready: runtimeSnapshots.filter((entry) => entry.agent.status === "ready").length,
      busy: runtimeSnapshots.filter((entry) => entry.agent.status === "busy").length,
      error: runtimeSnapshots.filter((entry) => entry.agent.status === "error").length,
    },
  };
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const accessRole = getChronosAccessRoleOrThrow(req);
  process.env.MISSION_ROLE = roleToMissionRole(accessRole);

  const encoder = new TextEncoder();
  let previousPayload = "";
  let interval: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = async () => {
        const agentMessages = collectAgentMessages();
        const a2aHandoffs = collectA2AHandoffs();
        const { managedRuntimes, surfaces, runtimeSummary } = await collectManagedRuntimeTopology();
        const payload = {
          ts: new Date().toISOString(),
          accessRole,
          recentEvents: collectRecentEvents(),
          agentMessages,
          a2aHandoffs,
          controlActions: collectControlActions(),
          controlActionDetails: collectControlActionDetails(),
          ownerSummaries: collectOwnerSummaries(),
          browserSessions: collectBrowserSessions(),
          runtime: runtimeSummary,
          runtimeTopology: buildRuntimeTopology({
            surfaces,
            runtimes: managedRuntimes,
            handoffs: a2aHandoffs,
            messages: agentMessages,
          }),
        };
        const serialized = JSON.stringify(payload);
        if (serialized === previousPayload) return;
        previousPayload = serialized;
        controller.enqueue(encoder.encode(sseChunk(payload)));
      };

      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      void push();
      interval = setInterval(() => {
        void push();
      }, 2000);
    },
    cancel() {
      if (interval) clearInterval(interval);
    },
  });

  req.signal.addEventListener("abort", () => {
    if (interval) clearInterval(interval);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
