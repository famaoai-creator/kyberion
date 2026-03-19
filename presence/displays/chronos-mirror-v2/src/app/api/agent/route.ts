import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { logger, pathResolver, safeExistsSync, safeReadFile, recordChronosDelegationSummary, recordChronosSurfaceRequest, ensureAgentRuntime, stopAgentRuntime, getAgentRuntimeHandle, validatePipelineAdf } from "@agent/core";
import { runSurfaceConversation } from "@agent/core";
import { guardRequest } from "../../../lib/api-guard";
import { getAgentManifest } from "@agent/core/agent-manifest";
import { executeSuperPipeline } from "../../../../../../libs/actuators/orchestrator-actuator/src/super-nerve/index.js";

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
const RUN_PIPELINE_PATTERN = /^node\s+dist\/scripts\/run_pipeline\.js\s+--input\s+(\S+)/;

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
      await stopAgentRuntime(CHRONOS_AGENT_ID, "chronos_api");
    } catch (_) {}
    clearChronosCache();
  }, CHRONOS_IDLE_TIMEOUT_MS);
  g.__kyberionChronosIdleTimer.unref?.();
}

async function ensureChronosAgent(context?: { missionId?: string; teamRole?: string; requesterId?: string }) {
  const cachedHandle = g.__kyberionChronosHandle;
  const runtimeHandle = getAgentRuntimeHandle(CHRONOS_AGENT_ID);
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
      const handle = await ensureAgentRuntime({
        agentId: CHRONOS_AGENT_ID,
        provider: manifest?.provider || "gemini",
        modelId: manifest?.modelId || "gemini-2.5-flash",
        systemPrompt: manifest?.systemPrompt,
        capabilities: manifest?.capabilities || ["a2ui", "dashboard", "commands", "gateway"],
        cwd: PROJECT_ROOT,
        requestedBy: "chronos_api",
        runtimeOwnerId: context?.missionId || CHRONOS_AGENT_ID,
        runtimeOwnerType: context?.missionId ? "mission" : "surface",
        runtimeMetadata: {
          lease_kind: "chronos_surface",
          mission_id: context?.missionId,
          team_role: context?.teamRole,
          requester_id: context?.requesterId || "chronos-ui",
        },
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

async function tryHandleDeterministicPipelineQuery(query: string) {
  const match = query.match(RUN_PIPELINE_PATTERN);
  if (!match) return null;

  const inputPath = pathResolver.rootResolve(match[1]);
  const pipeline = validatePipelineAdf(JSON.parse(safeReadFile(inputPath, { encoding: "utf8" }) as string));
  const result = await executeSuperPipeline(
    (pipeline.steps || []).map((step) => ({ ...step, params: step.params || {} })),
    pipeline.context || {},
    pipeline.options || {},
  );

  logger.info(`[CHRONOS] Deterministic pipeline query executed: ${match[1]}`);

  return {
    status: "ok",
    response: `Pipeline ${match[1]} finished with status: ${result.status}`,
    pipeline: {
      input: match[1],
      status: result.status,
      results: result.results,
      context: result.context,
    },
    a2ui: [],
    delegations: undefined,
    timestamp: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    process.env.MISSION_ROLE ||= "chronos_operator";
    const body = await req.json();
    const query = (body.query || body.intent || "").trim();
    const missionId = typeof body.missionId === "string" ? body.missionId : undefined;
    const teamRole = typeof body.teamRole === "string" ? body.teamRole : undefined;

    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const requestArtifactPath = recordChronosSurfaceRequest({
      query,
      sessionId: body.sessionId,
      requesterId: body.requesterId || "chronos-ui",
    });
    const requestArtifact = JSON.parse(safeReadFile(requestArtifactPath, { encoding: "utf8" }) as string);

    const deterministicPipelineResponse = await tryHandleDeterministicPipelineQuery(query);
    if (deterministicPipelineResponse) {
      return NextResponse.json(deterministicPipelineResponse);
    }

    await ensureChronosAgent({
      missionId,
      teamRole,
      requesterId: body.requesterId || "chronos-ui",
    });
    const conversation = await runSurfaceConversation({
      agentId: CHRONOS_AGENT_ID,
      query,
      senderAgentId: CHRONOS_AGENT_ID,
      cwd: PROJECT_ROOT,
      missionId,
      teamRole,
      delegationSummaryInstruction:
        "以下は委任先エージェントからの回答です。ユーザーに分かりやすくまとめて表示してください。必要なら A2UI を使ってください。追加の A2A は出力しないでください。",
    });
    scheduleChronosShutdown();

    const delegationResults = conversation.delegationResults || [];
    if (delegationResults.length > 0) {
      recordChronosDelegationSummary(
        requestArtifact.correlation_id,
        delegationResults.length,
        delegationResults.map((d: any) => d.receiver).filter(Boolean)
      );
    }

    return NextResponse.json({
      status: "ok",
      response: conversation.text,
      a2ui: conversation.a2uiMessages,
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
