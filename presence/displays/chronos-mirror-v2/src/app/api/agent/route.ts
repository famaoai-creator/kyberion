import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { agentLifecycle } from "@agent/core/agent-lifecycle";
import { a2aBridge } from "@agent/core/a2a-bridge";
import { safeExistsSync } from "@agent/core";
import { guardRequest } from "../../../lib/api-guard";
import { getAgentManifest } from "@agent/core/agent-manifest";

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    try {
      if (safeExistsSync(path.join(dir, "AGENTS.md"))) return dir;
    } catch (_) {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const PROJECT_ROOT = findProjectRoot();

const CHRONOS_AGENT_ID = "chronos-mirror";
const CHRONOS_IDLE_TIMEOUT_MS = Number(process.env.KYBERION_CHRONOS_IDLE_TIMEOUT_MS || 10 * 60 * 1000);

const g = globalThis as any;

function clearChronosCache() {
  if (g.__kyberionChronosIdleTimer) {
    clearTimeout(g.__kyberionChronosIdleTimer);
    g.__kyberionChronosIdleTimer = null;
  }
  g.__kyberionChronosReady = null;
  g.__kyberionChronosHandle = null;
}

function scheduleChronosShutdown() {
  if (g.__kyberionChronosIdleTimer) {
    clearTimeout(g.__kyberionChronosIdleTimer);
  }
  g.__kyberionChronosIdleTimer = setTimeout(async () => {
    try {
      await agentLifecycle.shutdown(CHRONOS_AGENT_ID);
    } catch (_) {}
    clearChronosCache();
  }, CHRONOS_IDLE_TIMEOUT_MS);
  g.__kyberionChronosIdleTimer.unref?.();
}

async function ensureChronosAgent() {
  const cachedHandle = g.__kyberionChronosHandle;
  const runtimeHandle = agentLifecycle.getHandle(CHRONOS_AGENT_ID);
  const cachedStatus = cachedHandle?.getRecord?.()?.status;
  if (cachedHandle && runtimeHandle && cachedStatus !== "shutdown" && cachedStatus !== "error") {
    scheduleChronosShutdown();
    return cachedHandle;
  }
  if (!runtimeHandle || cachedStatus === "shutdown" || cachedStatus === "error") {
    clearChronosCache();
  }

  // Use a separate promise key to avoid storing a rejected promise forever
  if (!g.__kyberionChronosReady) {
    g.__kyberionChronosReady = (async () => {
      const manifest = getAgentManifest(CHRONOS_AGENT_ID, PROJECT_ROOT);
      const handle = await agentLifecycle.spawn({
        agentId: CHRONOS_AGENT_ID,
        provider: manifest?.provider || "gemini",
        modelId: manifest?.modelId || "gemini-2.5-flash",
        systemPrompt: manifest?.systemPrompt,
        capabilities: manifest?.capabilities || ["a2ui", "dashboard", "commands", "gateway"],
        cwd: PROJECT_ROOT,
      });
      g.__kyberionChronosHandle = handle;
      scheduleChronosShutdown();
      return handle;
    })().catch((err: any) => {
      console.error("[API_AGENT] Boot failed:", err.message);
      clearChronosCache();
      throw err;
    });
  }
  await g.__kyberionChronosReady;
  scheduleChronosShutdown();
  return g.__kyberionChronosHandle;
}

/**
 * Extract ```a2ui and ```a2a blocks from LLM response.
 */
function extractBlocks(raw: string): {
  text: string;
  a2uiMessages: any[];
  a2aMessages: any[];
} {
  const a2uiMessages: any[] = [];
  const a2aMessages: any[] = [];

  let text = raw;

  // Extract A2UI blocks — tolerant of whitespace variations
  text = text.replace(/```a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2uiMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return "";
  });

  // Also catch A2UI as flat JSON objects with "type" field that Gemini sometimes emits
  // inside regular ``` blocks labeled a2ui
  text = text.replace(/```\s*a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2uiMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return "";
  });

  // Extract A2A blocks
  text = text.replace(/```a2a\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2aMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return "";
  });
  text = text.replace(/>>A2A(\{[\s\S]*?\})<</g, (_match, json) => {
    try { a2aMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return "";
  });

  return { text: text.trim(), a2uiMessages, a2aMessages };
}

/**
 * Process A2A delegations: route each to the target agent via A2A Bridge,
 * collect responses, and return them for the client.
 */
async function processA2ADelegations(
  a2aMessages: any[],
  senderAgentId: string
): Promise<{ delegationResults: any[] }> {
  const delegationResults: any[] = [];

  for (const msg of a2aMessages) {
    try {
      const envelope = {
        a2a_version: "1.0",
        header: {
          msg_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
          sender: senderAgentId,
          receiver: msg.header?.receiver,
          performative: msg.header?.performative || "request",
          conversation_id: msg.header?.conversation_id,
          timestamp: new Date().toISOString(),
        },
        payload: msg.payload,
      };

      const response = await a2aBridge.route(envelope);
      delegationResults.push({
        receiver: envelope.header.receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
      });
    } catch (err: any) {
      delegationResults.push({
        receiver: msg.header?.receiver,
        error: err.message,
      });
    }
  }

  return { delegationResults };
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const query = (body.query || body.intent || "").trim();

    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const handle = await ensureChronosAgent();
    const rawResponse = await handle.ask(query);
    scheduleChronosShutdown();
    const { text, a2uiMessages, a2aMessages } = extractBlocks(rawResponse);

    // Process any A2A delegations the agent requested
    let delegationResults: any[] = [];
    if (a2aMessages.length > 0) {
      const result = await processA2ADelegations(a2aMessages, CHRONOS_AGENT_ID);
      delegationResults = result.delegationResults;

      // If there were delegation results, ask the gateway agent to summarize
      if (delegationResults.length > 0 && delegationResults.some(d => !d.error)) {
        const summaryContext = delegationResults
          .filter(d => !d.error)
          .map(d => `[Response from ${d.receiver}]: ${d.response}`)
          .join("\n\n");

        const followUp = await handle.ask(
          `以下は委任先エージェントからの回答です。ユーザーに分かりやすくまとめて表示してください。A2UIも使ってください。\n\n${summaryContext}`
        );
        scheduleChronosShutdown();
        const followUpBlocks = extractBlocks(followUp);
        return NextResponse.json({
          status: "ok",
          response: followUpBlocks.text,
          a2ui: [...a2uiMessages, ...followUpBlocks.a2uiMessages],
          delegations: delegationResults,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return NextResponse.json({
      status: "ok",
      response: text,
      a2ui: a2uiMessages,
      delegations: delegationResults.length > 0 ? delegationResults : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
