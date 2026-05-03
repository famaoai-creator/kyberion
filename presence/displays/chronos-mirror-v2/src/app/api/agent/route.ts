import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { safeExistsSync } from "@agent/core/secure-io";
import { pathResolver as projectPathResolver } from "@agent/core/path-resolver";
import type { AgentRoutingDecision } from "@agent/core/intent-contract";
import { guardRequest } from "../../../lib/api-guard";
import { normalizeChronosLocale, selectChronosLocaleText } from "../../../lib/ux-vocabulary";

async function loadChronosCore() {
  const [
    core,
    pathResolverModule,
    secureIo,
    channelSurface,
    surfaceInteraction,
    runtimeSupervisor,
    runtimeSupervisorClient,
    pipelineContract,
    agentManifest,
    orchestrationEvents,
  ] = await Promise.all([
    import("@agent/core/core"),
    import("@agent/core/path-resolver"),
    import("@agent/core/secure-io"),
    import("@agent/core/channel-surface"),
    import("@agent/core/surface-interaction-model"),
    import("@agent/core/agent-runtime-supervisor"),
    import("@agent/core/agent-runtime-supervisor-client"),
    import("@agent/core/pipeline-contract"),
    import("@agent/core/agent-manifest"),
    import("@agent/core/mission-orchestration-events"),
  ]);

  return {
    logger: core.logger,
    pathResolver: pathResolverModule.pathResolver,
    safeExistsSync: secureIo.safeExistsSync,
    safeMkdir: secureIo.safeMkdir,
    safeReadFile: secureIo.safeReadFile,
    safeReaddir: secureIo.safeReaddir,
    safeRmSync: secureIo.safeRmSync,
    safeWriteFile: secureIo.safeWriteFile,
    recordChronosDelegationSummary: channelSurface.recordChronosDelegationSummary,
    recordChronosSurfaceRequest: channelSurface.recordChronosSurfaceRequest,
    runSurfaceConversation: channelSurface.runSurfaceConversation,
    runSurfaceMessageConversation: channelSurface.runSurfaceMessageConversation,
    reflectPresenceAgentReply: core.reflectPresenceAgentReply,
    dispatchPresenceFrame: core.dispatchPresenceFrame,
    listSurfaceOutboxMessages: channelSurface.listSurfaceOutboxMessages,
    isSlackMissionConfirmation: channelSurface.isSlackMissionConfirmation,
    ensureAgentRuntime: runtimeSupervisor.ensureAgentRuntime,
    getAgentRuntimeHandle: runtimeSupervisor.getAgentRuntimeHandle,
    listAgentRuntimeSnapshots: runtimeSupervisor.listAgentRuntimeSnapshots,
    stopAgentRuntime: runtimeSupervisor.stopAgentRuntime,
    ensureAgentRuntimeViaDaemon: runtimeSupervisorClient.ensureAgentRuntimeViaDaemon,
    createSupervisorBackedAgentHandle: runtimeSupervisorClient.createSupervisorBackedAgentHandle,
    toSupervisorEnsurePayload: runtimeSupervisorClient.toSupervisorEnsurePayload,
    validatePipelineAdf: pipelineContract.validatePipelineAdf,
    getAgentManifest: agentManifest.getAgentManifest,
    loadAgentManifests: agentManifest.loadAgentManifests,
    safeExec: secureIo.safeExec,
    emitMissionOrchestrationObservation: orchestrationEvents.emitMissionOrchestrationObservation,
    enqueueMissionOrchestrationEvent: orchestrationEvents.enqueueMissionOrchestrationEvent,
    startMissionOrchestrationWorker: orchestrationEvents.startMissionOrchestrationWorker,
  };
}

const PROJECT_ROOT = projectPathResolver.rootDir();

const CHRONOS_AGENT_ID = "chronos-mirror";
const CHRONOS_IDLE_TIMEOUT_MS = Number(process.env.KYBERION_CHRONOS_IDLE_TIMEOUT_MS || 10 * 60 * 1000);
const RUN_PIPELINE_PATTERN = /^node\s+dist\/scripts\/run_pipeline\.js\s+--input\s+(\S+)/;
const QUICK_ACTION_PATTERN = /^chronos:\/\/quick-action\/([a-z-]+)$/;

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
      const { stopAgentRuntime } = await loadChronosCore();
      await stopAgentRuntime(CHRONOS_AGENT_ID, "chronos_api");
    } catch (_) {}
    clearChronosCache();
  }, CHRONOS_IDLE_TIMEOUT_MS);
  g.__kyberionChronosIdleTimer.unref?.();
}

async function ensureChronosAgent(context?: { missionId?: string; teamRole?: string; requesterId?: string }) {
  const {
    ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    createSupervisorBackedAgentHandle,
    getAgentManifest,
    getAgentRuntimeHandle,
    toSupervisorEnsurePayload,
  } = await loadChronosCore();
  const cachedHandle = g.__kyberionChronosHandle;
  const cachedStatus = cachedHandle?.getRecord?.()?.status;
  if (cachedHandle && cachedStatus !== "shutdown" && cachedStatus !== "error") {
    scheduleChronosShutdown();
    return cachedHandle;
  }
  const runtimeHandle = getAgentRuntimeHandle(CHRONOS_AGENT_ID);
  if (!runtimeHandle || cachedStatus === "shutdown" || cachedStatus === "error") {
    clearChronosCache();
  }

  // Use a separate promise key to avoid storing a rejected promise forever
  if (!g.__kyberionChronosReady) {
    g.__kyberionChronosReady = (async () => {
      const manifest = getAgentManifest(CHRONOS_AGENT_ID, PROJECT_ROOT);
      const spawnOptions = {
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
      } as const;
      let handle;
      try {
        const snapshot = await ensureAgentRuntimeViaDaemon(toSupervisorEnsurePayload(spawnOptions));
        handle = createSupervisorBackedAgentHandle(CHRONOS_AGENT_ID, "chronos_api", snapshot);
      } catch (_) {
        handle = await ensureAgentRuntime(spawnOptions);
      }
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

type MissionProposal = {
  intent: "create_mission";
  mission_type?: string;
  summary?: string;
  assigned_persona?: string;
  tier?: "personal" | "confidential" | "public";
  vision_ref?: string;
  why?: string;
};

type ChronosMissionProposalState = {
  surface: "chronos";
  channel: "chronos";
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  createdAt: string;
};

function withMissionRole<T>(role: string, fn: () => T): T {
  const previousRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = role;
  try {
    return fn();
  } finally {
    if (previousRole === undefined) {
      delete process.env.MISSION_ROLE;
    } else {
      process.env.MISSION_ROLE = previousRole;
    }
  }
}

function chronosMissionProposalStatePath(sessionId: string, pathResolver: Awaited<ReturnType<typeof loadChronosCore>>["pathResolver"]): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return pathResolver.resolve(`active/shared/coordination/channels/chronos/mission-proposals/chronos-${safeSession}.json`);
}

function sanitizeMissionSlug(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "REQUEST";
}

function buildSurfaceMissionId(prefix: string, threadTs: string, proposal: MissionProposal, sourceText?: string): string {
  const base = proposal.summary || sourceText || proposal.why || proposal.mission_type || "request";
  const slug = sanitizeMissionSlug(base);
  const numericThread = threadTs.replace(/\D+/g, "").slice(-8) || Date.now().toString().slice(-8);
  return `MSN-${prefix}-${slug}-${numericThread}`;
}

function getChronosMissionProposalState(
  sessionId: string,
  core: Awaited<ReturnType<typeof loadChronosCore>>,
): ChronosMissionProposalState | null {
  const statePath = chronosMissionProposalStatePath(sessionId, core.pathResolver);
  return withMissionRole("chronos_gateway", () => {
    if (!core.safeExistsSync(statePath)) return null;
    return JSON.parse(core.safeReadFile(statePath, { encoding: "utf8" }) as string) as ChronosMissionProposalState;
  });
}

function saveChronosMissionProposalState(
  params: { sessionId: string; proposal: MissionProposal; sourceText?: string; routingDecision?: AgentRoutingDecision },
  core: Awaited<ReturnType<typeof loadChronosCore>>,
): string {
  const statePath = chronosMissionProposalStatePath(params.sessionId, core.pathResolver);
  return withMissionRole("chronos_gateway", () => {
    core.safeMkdir(path.dirname(statePath));
    core.safeWriteFile(
      statePath,
      JSON.stringify(
        {
          surface: "chronos",
          channel: "chronos",
          threadTs: params.sessionId,
          proposal: params.proposal,
          sourceText: params.sourceText,
          routingDecision: params.routingDecision,
          createdAt: new Date().toISOString(),
        } satisfies ChronosMissionProposalState,
        null,
        2,
      ),
    );
    return statePath;
  });
}

function clearChronosMissionProposalState(
  sessionId: string,
  core: Awaited<ReturnType<typeof loadChronosCore>>,
): void {
  const statePath = chronosMissionProposalStatePath(sessionId, core.pathResolver);
  withMissionRole("chronos_gateway", () => {
    if (!core.safeExistsSync(statePath)) return;
    core.safeRmSync(statePath, { force: true });
  });
}

async function issueChronosMissionFromProposal(
  params: { sessionId: string; proposal: MissionProposal; sourceText?: string; routingDecision?: AgentRoutingDecision },
  core: Awaited<ReturnType<typeof loadChronosCore>>,
) {
  const missionId = buildSurfaceMissionId("CHRONOS", params.sessionId, params.proposal, params.sourceText);
  const tier = params.proposal.tier || "public";
  const missionType = params.proposal.mission_type || "development";
  const persona = params.proposal.assigned_persona || "Ecosystem Architect";
  const env = { ...process.env, MISSION_ROLE: "mission_controller" };

  const startOutput = core.safeExec(
    "node",
    [
      "dist/scripts/mission_controller.js",
      "start",
      missionId,
      tier,
      persona,
      "default",
      missionType,
      ...(params.routingDecision ? ["--routing-decision", JSON.stringify(params.routingDecision)] : []),
    ],
    { env, cwd: PROJECT_ROOT },
  );

  let orchestrationStatus: "queued" | "failed" = "queued";
  let orchestrationJobPath: string | undefined;
  let orchestrationError: string | undefined;
  try {
    const event = withMissionRole("chronos_gateway", () =>
      core.enqueueMissionOrchestrationEvent({
        eventType: "mission_issue_requested",
        missionId,
        requestedBy: "chronos_gateway",
        correlationId: randomUUID(),
        payload: {
          sessionId: params.sessionId,
          proposal: params.proposal,
          sourceText: params.sourceText,
          tier,
          persona,
          missionType,
          channel: "chronos",
          threadTs: params.sessionId,
        },
      }),
    );
    orchestrationJobPath = withMissionRole("chronos_gateway", () => core.startMissionOrchestrationWorker(event));
  } catch (error) {
    orchestrationStatus = "failed";
    orchestrationError = error instanceof Error ? error.message : String(error);
  }

  withMissionRole("chronos_gateway", () => {
    core.emitMissionOrchestrationObservation({
      decision: "mission_issued",
      source: "chronos",
      mission_id: missionId,
      session_id: params.sessionId,
      mission_type: missionType,
      tier,
      requested_by: "chronos_gateway",
      orchestration_status: orchestrationStatus,
      orchestration_job_path: orchestrationJobPath,
    });
  });

  return {
    missionId,
    tier,
    missionType,
    persona,
    startOutput,
    orchestrationStatus,
    orchestrationJobPath,
    orchestrationError,
  };
}

function l(locale: "en" | "ja", en: string, ja: string): string {
  return selectChronosLocaleText(locale, { en, ja });
}

async function tryHandleDeterministicPipelineQuery(query: string, locale: "en" | "ja") {
  const match = query.match(RUN_PIPELINE_PATTERN);
  if (!match) return null;

  const { pathResolver, safeExec, logger } = await loadChronosCore();
  const inputPath = pathResolver.rootResolve(match[1]);
  const output = safeExec("node", ["dist/scripts/run_pipeline.js", "--input", inputPath], { cwd: PROJECT_ROOT });

  logger.info(`[CHRONOS] Deterministic pipeline query executed via built script: ${match[1]}`);

  return {
    status: "ok",
    response: l(locale, `Pipeline ${match[1]} completed.`, `Pipeline ${match[1]} の実行が完了しました。`),
    a2ui: [
      {
        type: "display:section",
        props: {
          title: "Pipeline Execution",
          description: `Deterministic execution of ${match[1]} through the built pipeline runner.`,
          items: [
            {
              type: "display:log",
              props: {
                title: "Execution Output",
                lines: output.split("\n").filter(Boolean).slice(-40),
              },
            },
          ],
        },
      },
    ],
    pipeline: {
      input: match[1],
      status: "completed",
    },
    delegations: undefined,
    timestamp: new Date().toISOString(),
  };
}

async function tryHandleChronosQuickAction(query: string, locale: "en" | "ja") {
  const match = query.match(QUICK_ACTION_PATTERN);
  if (!match) return null;

  const action = match[1];
  const core = await loadChronosCore();

  const collectActiveMissions = () => {
    const roots = [
      { dir: core.pathResolver.active("missions/public"), tier: "public" },
      { dir: core.pathResolver.active("missions/confidential"), tier: "confidential" },
    ];

    const missions: Array<{
      missionId: string;
      status: string;
      tier: string;
      missionType?: string;
      checkpoints: number;
      nextTaskCount: number;
      planReady: boolean;
    }> = [];

    for (const root of roots) {
      if (!core.safeExistsSync(root.dir)) continue;
      for (const item of core.safeReaddir(root.dir)) {
        const missionDir = path.join(root.dir, item);
        const statePath = path.join(missionDir, "mission-state.json");
        if (!core.safeExistsSync(statePath)) continue;
        const state = JSON.parse(core.safeReadFile(statePath, { encoding: "utf8" }) as string);
        missions.push({
          missionId: state.mission_id || item,
          status: state.status,
          tier: state.tier || root.tier,
          missionType: state.mission_type,
          checkpoints: state.git?.checkpoints?.length || 0,
          nextTaskCount: core.safeExistsSync(path.join(missionDir, "NEXT_TASKS.json"))
            ? ((JSON.parse(core.safeReadFile(path.join(missionDir, "NEXT_TASKS.json"), { encoding: "utf8" }) as string) as any[])?.length || 0)
            : 0,
          planReady: core.safeExistsSync(path.join(missionDir, "PLAN.md")),
        });
      }
    }

    return missions.sort((a, b) => a.missionId.localeCompare(b.missionId));
  };

  const readJson = (filePath: string) => JSON.parse(core.safeReadFile(filePath, { encoding: "utf8" }) as string);

  switch (action) {
    case "dashboard": {
      const missions = collectActiveMissions();
      const runtime = core.listAgentRuntimeSnapshots();
      const pendingOutbox = [
        ...core.listSurfaceOutboxMessages("slack"),
        ...core.listSurfaceOutboxMessages("chronos"),
      ].length;

      return {
        status: "ok",
        response: l(
          locale,
          `Dashboard ready. ${missions.length} missions, ${runtime.length} agent runtimes, ${pendingOutbox} pending outbox messages.`,
          `Dashboard を更新しました。missions=${missions.length}、agent runtimes=${runtime.length}、pending outbox=${pendingOutbox} です。`,
        ),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Operator Snapshot",
              title: "Chronos Dashboard",
              description: "Mission state, runtime health, and pending delivery are aligned into a single control surface snapshot.",
              status: `${missions.length} missions`,
            },
          },
          {
            type: "display:metrics-row",
            props: {
              metrics: [
                { label: "missions", value: missions.length, trend: "flat" },
                { label: "runtime", value: runtime.length, trend: "flat" },
                { label: "ready", value: runtime.filter((entry: any) => entry.agent.status === "ready").length, trend: "flat" },
                { label: "outbox", value: pendingOutbox, trend: pendingOutbox > 0 ? "up" : "flat" },
              ],
            },
          },
          {
            type: "display:table",
            props: {
              title: "Active Missions",
              headers: ["Mission", "Status", "Tier", "Type", "Next", "Plan"],
              rows: missions.slice(0, 12).map((mission) => [
                mission.missionId,
                mission.status,
                mission.tier,
                mission.missionType || "development",
                String(mission.nextTaskCount),
                mission.planReady ? "ready" : "pending",
              ]),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "missions": {
      const missions = collectActiveMissions();
      return {
        status: "ok",
        response: l(locale, `Mission list refreshed from active mission state. ${missions.length} missions are visible to Chronos.`, `active mission state から mission list を更新しました。Chronos から ${missions.length} 件の mission が見えています。`),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Mission Control",
              title: "Visible Missions",
              description: "Chronos lists missions from active mission state under public and confidential tiers.",
              status: `${missions.length} visible`,
            },
          },
          {
            type: "display:table",
            props: {
              title: "Mission Registry View",
              headers: ["Mission", "Status", "Tier", "Checkpoints", "Next Tasks", "Plan"],
              rows: missions.map((mission) => [
                mission.missionId,
                mission.status,
                mission.tier,
                String(mission.checkpoints),
                String(mission.nextTaskCount),
                mission.planReady ? "ready" : "pending",
              ]),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "agents": {
      const manifests = core.loadAgentManifests();
      const runtimes = core.listAgentRuntimeSnapshots();
      const runtimeById = new Map(runtimes.map((entry: any) => [entry.agent.agentId, entry]));
      return {
        status: "ok",
        response: l(locale, `Agent catalog refreshed. ${manifests.length} manifests, ${runtimes.length} active runtimes.`, `agent catalog を更新しました。manifests=${manifests.length}、active runtimes=${runtimes.length} です。`),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Agent Catalog",
              title: "Available Agents",
              description: "Manifest definitions are merged with current runtime status so operator decisions match actual runtime state.",
              status: `${runtimes.length} active runtimes`,
            },
          },
          {
            type: "display:table",
            props: {
              title: "Agents",
              headers: ["Agent", "Provider", "Model", "Status", "Capabilities"],
              rows: manifests.map((manifest: any) => {
                const runtime = runtimeById.get(manifest.agentId);
                return [
                  manifest.agentId,
                  manifest.provider,
                  manifest.modelId || "-",
                  runtime?.agent.status || "offline",
                  (manifest.capabilities || []).join(", "),
                ];
              }),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "vital-check": {
      const missions = collectActiveMissions();
      const runtimes = core.listAgentRuntimeSnapshots();
      const readyCount = runtimes.filter((entry: any) => entry.agent.status === "ready").length;
      const pendingOutbox = core.listSurfaceOutboxMessages("slack").length + core.listSurfaceOutboxMessages("chronos").length;
      return {
        status: "ok",
        response: l(locale, `Vital check complete. ${missions.length} missions, ${readyCount}/${runtimes.length} runtimes ready, ${pendingOutbox} pending outbox messages.`, `vital check が完了しました。missions=${missions.length}、ready runtimes=${readyCount}/${runtimes.length}、pending outbox=${pendingOutbox} です。`),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Vital Check",
              title: "System Vital Signs",
              description: "Mission load, runtime readiness, and surface delivery pressure.",
              status: readyCount === runtimes.length ? "healthy" : "degraded",
            },
          },
          {
            type: "display:metrics-row",
            props: {
              metrics: [
                { label: "missions", value: missions.length, trend: "flat" },
                { label: "runtimes", value: runtimes.length, trend: "flat" },
                { label: "ready", value: readyCount, trend: readyCount === runtimes.length ? "flat" : "down" },
                { label: "outbox", value: pendingOutbox, trend: pendingOutbox > 0 ? "up" : "flat" },
              ],
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "diagnostics": {
      const runtimes = core.listAgentRuntimeSnapshots();
      const problematic = runtimes.filter((entry: any) => entry.agent.status !== "ready");
      const recentFiles = [
        core.pathResolver.shared("observability/mission-control/orchestration-events.jsonl"),
        core.pathResolver.shared("observability/channels/slack/missions.jsonl"),
      ];
      const recentLines = recentFiles.flatMap((file) => {
        if (!core.safeExistsSync(file)) return [];
        return (core.safeReadFile(file, { encoding: "utf8" }) as string).trim().split("\n").filter(Boolean).slice(-5);
      }).slice(-10);
      return {
        status: "ok",
        response: l(locale, `Diagnostics loaded. ${problematic.length} non-ready runtimes detected.`, `diagnostics を読み込みました。non-ready runtime は ${problematic.length} 件です。`),
        a2ui: [
          {
            type: "display:section",
            props: {
              title: "Runtime Diagnostics",
              description: "Non-ready runtime entries and recent control-plane events.",
              items: [
                {
                  type: "display:table",
                  props: {
                    title: "Non-ready Runtimes",
                    headers: ["Agent", "Status", "Owner", "Kind"],
                    rows: problematic.length > 0
                      ? problematic.map((entry: any) => [
                          entry.agent.agentId,
                          entry.agent.status,
                          entry.agent.ownerId || "-",
                          entry.agent.ownerType || "-",
                        ])
                      : [["none", "ready", "-", "-"]],
                  },
                },
                {
                  type: "display:log",
                  props: {
                    title: "Recent Events",
                    lines: recentLines,
                  },
                },
              ],
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "capability-audit": {
      const manifests = core.loadAgentManifests();
      const capabilityCounts = manifests
        .flatMap((manifest: any) => manifest.capabilities || [])
        .reduce((acc: Record<string, number>, capability: string) => {
          acc[capability] = (acc[capability] || 0) + 1;
          return acc;
        }, {});
      const rows = Object.entries(capabilityCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([capability, count]) => [capability, String(count)]);
      return {
        status: "ok",
        response: l(locale, `Capability audit complete. ${manifests.length} agent manifests were scanned.`, `capability audit が完了しました。${manifests.length} 件の agent manifest を確認しました。`),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Capability Audit",
              title: "Manifest Capability Coverage",
              description: "Capability density derived from current agent manifests.",
              status: `${manifests.length} manifests`,
            },
          },
          {
            type: "display:table",
            props: {
              title: "Capabilities",
              headers: ["Capability", "Agents"],
              rows,
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "provider-check": {
      const manifests = core.loadAgentManifests();
      const runtimes = core.listAgentRuntimeSnapshots();
      const runtimeById = new Map(runtimes.map((entry: any) => [entry.agent.agentId, entry.agent.status]));
      return {
        status: "ok",
        response: l(locale, `Provider inventory loaded for ${manifests.length} manifests.`, `${manifests.length} 件の manifest について provider inventory を読み込みました。`),
        a2ui: [
          {
            type: "display:table",
            props: {
              title: "Provider Status",
              headers: ["Agent", "Provider", "Model", "Runtime"],
              rows: manifests.map((manifest: any) => [
                manifest.agentId,
                manifest.provider,
                manifest.modelId || "-",
                runtimeById.get(manifest.agentId) || "offline",
              ]),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "audit-log": {
      const auditChainPath = core.pathResolver.rootResolve(
        `active/audit/audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      const eventFiles = [
        auditChainPath,
        core.pathResolver.shared("observability/mission-control/orchestration-events.jsonl"),
        core.pathResolver.shared("observability/channels/slack/missions.jsonl"),
      ];
      const events: Array<{ time: string; label: string; detail?: string; status?: string }> = [];
      for (const file of eventFiles) {
        if (!core.safeExistsSync(file)) continue;
        const lines = (core.safeReadFile(file, { encoding: "utf8" }) as string).trim().split("\n").filter(Boolean);
        for (const line of lines.slice(-12)) {
          const event = JSON.parse(line);
          const routingDecision = event.metadata?.routing_decision as { mode?: string; owner?: string; fanout?: string } | undefined;
          const routingSummary = routingDecision
            ? [routingDecision.mode, routingDecision.owner ? `owner=${routingDecision.owner}` : undefined, routingDecision.fanout && routingDecision.fanout !== "none" ? `fanout=${routingDecision.fanout}` : undefined]
                .filter(Boolean)
                .join(", ")
            : undefined;
          events.push({
            time: String(event.ts || new Date().toISOString()).slice(11, 19),
            label: String(event.decision || event.action || event.event_type || "event"),
            detail: routingSummary
              ? `${String(event.mission_id || event.resource_id || event.agentId || "system")} · ${routingSummary}`
              : String(event.mission_id || event.resource_id || event.agentId || "system"),
            status: String(event.result || event.decision || "").includes("failed")
              ? "error"
              : String(event.result || event.decision || "").includes("completed")
                ? "ok"
                : "warning",
          });
        }
      }
      return {
        status: "ok",
        response: l(locale, `Recent orchestration and mission audit events loaded.`, `最近の orchestration と mission audit event を読み込みました。`),
        a2ui: [
          {
            type: "display:timeline",
            props: {
              title: "Recent Audit Events",
              events: events.slice(-12).reverse(),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "policies": {
      const securityPolicyPath = core.pathResolver.knowledge("public/governance/security-policy.json");
      const securityPolicy = readJson(securityPolicyPath);
      const chronosPolicy = securityPolicy.authority_role_permissions?.chronos_operator || {};
      return {
        status: "ok",
        response: l(locale, "Chronos operator policy loaded.", "Chronos operator policy を読み込みました。"),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Governance",
              title: "Chronos Operator Policy",
              description: "Read scopes and runtime boundaries applied to the Chronos surface.",
              status: "policy loaded",
            },
          },
          {
            type: "display:badges",
            props: {
              title: "Read Scopes",
              items: (chronosPolicy.allow_read || []).map((scope: string) => ({ label: scope, tone: "info" })),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "knowledge": {
      const roots = ["knowledge/public", "knowledge/public/architecture", "knowledge/public/governance"];
      const files = roots.flatMap((root) => {
        const dir = core.pathResolver.rootResolve(root);
        if (!core.safeExistsSync(dir)) return [];
        return core.safeReaddir(dir).map((name) => `${root}/${name}`);
      }).slice(0, 24);
      return {
        status: "ok",
        response: l(locale, "Public knowledge surface refreshed.", "public knowledge surface を更新しました。"),
        a2ui: [
          {
            type: "display:list",
            props: {
              title: "Public Knowledge Files",
              items: files.map((file) => ({ label: file })),
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    case "build-test": {
      const buildOutput = core.safeExec("pnpm", ["run", "build"], { cwd: PROJECT_ROOT });
      const testOutput = core.safeExec("pnpm", ["test"], { cwd: PROJECT_ROOT });
      return {
        status: "ok",
        response: l(locale, "Build and test completed.", "build と test が完了しました。"),
        a2ui: [
          {
            type: "display:section",
            props: {
              title: "Build & Test",
              description: "Deterministic local verification from Chronos.",
              items: [
                { type: "display:log", props: { title: "Build Output", lines: buildOutput.split("\n").slice(-20) } },
                { type: "display:log", props: { title: "Test Output", lines: testOutput.split("\n").slice(-20) } },
              ],
            },
          },
        ],
        timestamp: new Date().toISOString(),
      };
    }
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    process.env.MISSION_ROLE ||= "chronos_operator";
    const core = await loadChronosCore();
    const {
      isSlackMissionConfirmation,
      dispatchPresenceFrame,
      reflectPresenceAgentReply,
      recordChronosDelegationSummary,
      recordChronosSurfaceRequest,
      runSurfaceConversation,
      safeReadFile,
    } = core;
    const body = await req.json();
    const locale = normalizeChronosLocale(body.locale);
    const query = (body.query || body.intent || "").trim();
    const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId : "chronos-default";
    const pendingMissionProposal = getChronosMissionProposalState(sessionId, core);
    const missionId = typeof body.missionId === "string" ? body.missionId : undefined;
    const teamRole = typeof body.teamRole === "string" ? body.teamRole : undefined;

    if (!query) {
      return NextResponse.json({ error: l(locale, "Missing query", "query がありません") }, { status: 400 });
    }

    if (pendingMissionProposal && isSlackMissionConfirmation(query)) {
      const issued = await issueChronosMissionFromProposal({
        sessionId,
        proposal: pendingMissionProposal.proposal,
        sourceText: pendingMissionProposal.sourceText,
        routingDecision: pendingMissionProposal.routingDecision,
      }, core);
      clearChronosMissionProposalState(sessionId, core);
      return NextResponse.json({
        status: "ok",
        response: [
          `Mission ${issued.missionId} started.`,
          `Type: ${issued.missionType}`,
          `Tier: ${issued.tier}`,
          `Persona: ${issued.persona}`,
          issued.routingDecision
            ? `Routing: ${issued.routingDecision.mode}${issued.routingDecision.owner ? ` (${issued.routingDecision.owner})` : ""}`
            : undefined,
          issued.orchestrationStatus === "queued"
            ? "Background orchestration has been queued."
            : "Background orchestration could not be queued.",
        ].filter(Boolean).join("\n"),
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Mission Started",
              title: issued.missionId,
              description: issued.routingDecision
                ? `Type ${issued.missionType}. Tier ${issued.tier}. Persona ${issued.persona}. Routing ${issued.routingDecision.mode}${issued.routingDecision.owner ? ` (${issued.routingDecision.owner})` : ""}.`
                : `Type ${issued.missionType}. Tier ${issued.tier}. Persona ${issued.persona}.`,
              status: issued.orchestrationStatus,
            },
          },
          {
            type: "display:badges",
            props: {
              title: "Mission Context",
              items: [
                { label: issued.missionType, tone: "info" },
                { label: issued.tier, tone: "warning" },
                { label: issued.persona, tone: "success" },
              ],
            },
          },
        ],
        mission: issued,
        timestamp: new Date().toISOString(),
      });
    }

    const quickActionResponse = await tryHandleChronosQuickAction(query, locale);
    if (quickActionResponse) {
      return NextResponse.json(quickActionResponse);
    }

    const requestArtifactPath = recordChronosSurfaceRequest({
      query,
      sessionId,
      requesterId: body.requesterId || "chronos-ui",
    });
    const requestArtifact = JSON.parse(safeReadFile(requestArtifactPath, { encoding: "utf8" }) as string);

    const deterministicPipelineResponse = await tryHandleDeterministicPipelineQuery(query, locale);
    if (deterministicPipelineResponse) {
      return NextResponse.json(deterministicPipelineResponse);
    }

    await ensureChronosAgent({
      missionId,
      teamRole,
      requesterId: body.requesterId || "chronos-ui",
    });
    await dispatchPresenceFrame({
      agentId: CHRONOS_AGENT_ID,
      title: "Presence Studio",
      status: "thinking",
      expression: "thinking",
      subtitle: "Chronos is preparing a response.",
      transcript: [{ speaker: "User", text: query }],
    });
    const conversation = await runSurfaceMessageConversation({
      surface: "chronos",
      text: query,
      threadTs: sessionId,
      correlationId: requestArtifact.correlation_id,
      actorId: body.requesterId || "chronos-ui",
      senderAgentId: CHRONOS_AGENT_ID,
      agentId: CHRONOS_AGENT_ID,
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

    if (conversation.missionProposals && conversation.missionProposals.length > 0) {
      const proposal = conversation.missionProposals[0];
      await dispatchPresenceFrame({
        agentId: CHRONOS_AGENT_ID,
        title: "Presence Studio",
        status: "speaking",
        expression: "thinking",
        subtitle: conversation.text || "Chronos prepared a mission proposal.",
        transcript: [{ speaker: "Chronos", text: conversation.text || "I can turn this into a mission." }],
      });
      saveChronosMissionProposalState({
        sessionId,
        proposal,
        sourceText: query,
        routingDecision: conversation.routingDecision,
      }, core);
      const confirmationText = [
        conversation.text || "I can turn this into a mission.",
        "",
        "If you want me to proceed, reply with `はい` or `お願いします` in this session.",
      ].join("\n").trim();

      return NextResponse.json({
        status: "ok",
        response: confirmationText,
        a2ui: [
          {
            type: "display:hero",
            props: {
              eyebrow: "Mission Proposal",
              title: proposal.summary || proposal.why || proposal.mission_type || "New mission",
              description: conversation.text || "Chronos has prepared a mission proposal and is waiting for confirmation.",
              status: "awaiting confirmation",
            },
          },
          {
            type: "display:badges",
            props: {
              title: "Proposed Configuration",
              items: [
                { label: proposal.mission_type || "development", tone: "info" },
                { label: proposal.tier || "public", tone: "warning" },
                { label: proposal.assigned_persona || "Ecosystem Architect", tone: "success" },
              ],
            },
          },
          {
            type: "display:section",
            props: {
              title: "Next Step",
              description: "Confirm from Chronos to issue the mission through mission_controller and queue orchestration.",
              items: [
                {
                  type: "display:alert",
                  props: {
                    severity: "info",
                    title: "Reply with confirmation",
                    message: "Send `はい` or `お願いします` in this session to start the mission.",
                  },
                },
              ],
            },
          },
        ],
        delegations: delegationResults.length > 0 ? delegationResults : undefined,
        timestamp: new Date().toISOString(),
      });
    }

    if (conversation.text) {
      await reflectPresenceAgentReply({
        agentId: CHRONOS_AGENT_ID,
        speaker: "Chronos",
        text: conversation.text,
      });
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
