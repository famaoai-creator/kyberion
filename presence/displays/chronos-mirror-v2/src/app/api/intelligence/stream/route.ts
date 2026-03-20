import { NextRequest } from "next/server";
import { collectA2AHandoffs, collectAgentMessages } from "../../../../lib/agent-message-feed";
import {
  collectBrowserSessions,
  collectControlActionDetails,
  collectControlActions,
  collectOwnerSummaries,
  collectRecentEvents,
} from "../../../../lib/intelligence-observations";
import { getChronosAccessRoleOrThrow, guardRequest, roleToMissionRole } from "../../../../lib/api-guard";

export const runtime = "nodejs";

function sseChunk(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
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
      const push = () => {
        const payload = {
          ts: new Date().toISOString(),
          accessRole,
          recentEvents: collectRecentEvents(),
          agentMessages: collectAgentMessages(),
          a2aHandoffs: collectA2AHandoffs(),
          controlActions: collectControlActions(),
          controlActionDetails: collectControlActionDetails(),
          ownerSummaries: collectOwnerSummaries(),
          browserSessions: collectBrowserSessions(),
        };
        const serialized = JSON.stringify(payload);
        if (serialized === previousPayload) return;
        previousPayload = serialized;
        controller.enqueue(encoder.encode(sseChunk(payload)));
      };

      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      push();
      interval = setInterval(push, 2000);
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
