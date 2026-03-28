import {
  ControlPlaneClientError,
  createControlPlaneClient,
  createStandardYargs,
  getControlPlaneRemediationPlan,
  logger,
  safeExec,
} from "@agent/core";

type SurfaceKind = "presence" | "chronos";

interface DoctorCheckResult {
  surface: SurfaceKind;
  ok: boolean;
  status: "ok" | "error";
  detail: string;
  suggestedCommand?: string;
  baseUrl?: string;
  fixAttempted?: boolean;
  fixResult?: string;
}

function summarizeSurfaceRuntimeOutput(output: unknown, fallback: string): string {
  const text = String(output || "").trim();
  if (!text) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const status = String(parsed.status || "ok");
    const id = parsed.id ? String(parsed.id) : undefined;
    const detail = parsed.detail ? String(parsed.detail) : undefined;
    const port = parsed.port ? String(parsed.port) : undefined;
    return [status, id, detail, port ? `port ${port}` : undefined].filter(Boolean).join(" · ");
  } catch (_) {
    return formatExecTail(text, fallback);
  }
}

function formatExecTail(output: unknown, fallback: string): string {
  const text = String(output || "").trim();
  if (!text) {
    return fallback;
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || fallback;
}

function attemptSurfaceFix(surface: SurfaceKind): string {
  const runtimeId = getControlPlaneRemediationPlan(surface).runtimeId;
  const actions: Array<{ args: string[]; fallback: string }> = [
    {
      args: ["dist/scripts/surface_runtime.js", "--action", "stop", "--surface", runtimeId],
      fallback: `stop ${runtimeId} completed`,
    },
    {
      args: ["dist/scripts/surface_runtime.js", "--action", "start", "--surface", runtimeId],
      fallback: `start ${runtimeId} completed`,
    },
  ];

  const steps: string[] = [];
  try {
    for (const action of actions) {
      const output = safeExec("node", action.args, { cwd: process.cwd(), timeoutMs: 120_000 });
      steps.push(summarizeSurfaceRuntimeOutput(output, action.fallback));
    }
    return steps.join(" -> ");
  } catch (error) {
    const reconcileOutput = safeExec("pnpm", ["surfaces:reconcile"], { cwd: process.cwd(), timeoutMs: 120_000 });
    const reconcileTail = formatExecTail(reconcileOutput, "reconcile completed");
    const reason = error instanceof Error ? error.message : String(error);
    steps.push(`fallback to reconcile after targeted restart failed: ${reason}`);
    steps.push(reconcileTail);
    return steps.join(" -> ");
  }
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function printItems(title: string, items: unknown[], projector: (item: any) => string[]): void {
  if (!items.length) {
    process.stdout.write(`${title}: none\n`);
    return;
  }
  process.stdout.write(`${title} (${items.length})\n`);
  for (const item of items) {
    const lines = projector(item);
    process.stdout.write(`- ${lines[0] || "item"}\n`);
    for (const line of lines.slice(1)) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function runDoctor(input: { json: boolean; verbose: boolean; fix: boolean; surface?: SurfaceKind }): Promise<void> {
  const checks: DoctorCheckResult[] = [];
  const surfaces: Array<{ surface: SurfaceKind; run: () => Promise<unknown>; baseUrl: string }> = [
    {
      surface: "presence" as SurfaceKind,
      baseUrl: String(process.env.PRESENCE_STUDIO_URL || "http://127.0.0.1:3031"),
      run: async () => createControlPlaneClient("presence", { timeoutMs: 3000, retryCount: 0 }).listProjects(),
    },
    {
      surface: "chronos" as SurfaceKind,
      baseUrl: String(process.env.CHRONOS_URL || "http://127.0.0.1:3000"),
      run: async () => createControlPlaneClient("chronos", { timeoutMs: 3000, retryCount: 0 }).getChronosOverview(),
    },
  ].filter((entry) => !input.surface || entry.surface === input.surface);

  for (const entry of surfaces) {
    try {
      const result = await entry.run();
      if (entry.surface === "presence") {
        checks.push({
          surface: entry.surface,
          ok: true,
          status: "ok",
          detail: `reachable · projects=${asArray(result).length}`,
          baseUrl: entry.baseUrl,
        });
      } else {
        const overview = result as { accessRole?: string; projects?: unknown[]; pendingApprovals?: unknown[] };
        checks.push({
          surface: entry.surface,
          ok: true,
          status: "ok",
          detail: `reachable · access=${overview.accessRole || "unknown"} · projects=${asArray(overview.projects).length} · approvals=${asArray(overview.pendingApprovals).length}`,
          baseUrl: entry.baseUrl,
        });
      }
    } catch (error) {
      const suggestedCommand = error instanceof ControlPlaneClientError ? error.suggestedCommand : undefined;
      const record: DoctorCheckResult = {
        surface: entry.surface,
        ok: false,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
        suggestedCommand,
        baseUrl: entry.baseUrl,
      };
      if (input.fix && suggestedCommand) {
        record.fixAttempted = true;
        try {
          const attempted = attemptSurfaceFix(entry.surface);
          try {
            await entry.run();
            record.fixResult = `${attempted} -> verified`;
          } catch (retryError) {
            const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
            record.fixResult = `${attempted} -> still failing: ${retryDetail}`;
          }
        } catch (fixError) {
          record.fixResult = fixError instanceof Error ? fixError.message : String(fixError);
        }
      }
      checks.push(record);
    }
  }

  const summary = {
    ok: checks.every((check) => check.ok),
    checked_at: new Date().toISOString(),
    surfaces: checks,
  };

  if (input.json) {
    printJson(summary);
    if (!summary.ok) {
      process.exitCode = 1;
    }
    return;
  }

  process.stdout.write("Control Plane Doctor\n");
  for (const check of checks) {
    process.stdout.write(`- ${check.surface}: ${check.ok ? "ok" : "error"}\n`);
    process.stdout.write(`  ${check.detail}\n`);
    if (input.verbose && check.baseUrl) {
      process.stdout.write(`  url: ${check.baseUrl}\n`);
    }
    if (check.suggestedCommand) {
      process.stdout.write(`  suggested fix: ${check.suggestedCommand}\n`);
    }
    if (check.fixAttempted) {
      process.stdout.write(`  fix attempted: ${check.fixResult || "completed"}\n`);
    }
  }
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

async function handlePresence(action: string, args: string[], json: boolean): Promise<void> {
  const client = createControlPlaneClient("presence", { timeoutMs: 5000, retryCount: 1 });
  if (action === "projects") {
    const items = await client.listProjects();
    if (json) return printJson(items);
    return printItems("Projects", items, (item) => [
      `${item.name || item.project_id} [${item.status || "unknown"}]`,
      `id: ${item.project_id || "unknown"}`,
      `tier: ${item.tier || "unknown"} · locale: ${item.primary_locale || "n/a"}`,
      `missions: ${asArray(item.active_missions).length} · bindings: ${asArray(item.service_bindings).length}`,
    ]);
  }
  if (action === "bindings") {
    const body = await client.getJson("/api/service-bindings");
    if (json) return printJson(body.items || []);
    return printItems("Service Bindings", asArray(body.items), (item) => [
      `${item.binding_id || "binding"} [${item.service_type || "service"}]`,
      `target: ${item.target || "unknown"}`,
      `scope: ${item.scope || "unknown"}`,
      `actions: ${asArray(item.allowed_actions).join(", ") || "n/a"}`,
    ]);
  }
  if (action === "mission-seeds") {
    const items = await client.listMissionSeeds();
    if (json) return printJson(items);
    return printItems("Mission Seeds", items, (item) => [
      `${item.title || item.seed_id} [${item.status || "unknown"}]`,
      `project: ${item.project_id || "standalone"} · specialist: ${item.specialist_id || "unknown"}`,
      `type: ${item.mission_type_hint || "general"} · source: ${item.source_work_id || "-"}`,
      item.promoted_mission_id ? `mission: ${item.promoted_mission_id}` : "mission: -",
    ]);
  }
  if (action === "approvals") {
    const items = await client.listApprovals();
    if (json) return printJson(items);
    return printItems("Approvals", items, (item) => [
      `${item.title || item.id} [${item.status || "pending"}]`,
      `id: ${item.id}`,
      `risk: ${item.risk?.level || item.severity || "unknown"} · requested by: ${item.requestedBy || "system"}`,
      item.expected_outcome ? `expected outcome: ${item.expected_outcome}` : "expected outcome: -",
    ]);
  }
  if (action === "approve") {
    const [requestId, decision] = args;
    if (!requestId || !["approved", "rejected"].includes(String(decision))) {
      throw new Error("Usage: control presence approve <requestId> <approved|rejected>");
    }
    const body = await client.postJson(`/api/approvals/${encodeURIComponent(requestId)}/decision`, { decision });
    return printJson(body);
  }
  if (action === "outcomes") {
    const items = await client.listOutcomes();
    if (json) return printJson(items);
    return printItems("Latest Outcomes", items, (item) => [
      `${item.preview_text || item.kind || "outcome"} [${item.kind || "artifact"}]`,
      `artifact: ${item.artifact_id || "unknown"} · project: ${item.project_id || "standalone"}`,
      `storage: ${item.storage_class || "unknown"}`,
      asArray(item.promoted_refs).length ? `promoted: ${asArray(item.promoted_refs).join(", ")}` : "promoted: -",
    ]);
  }
  if (action === "tasks") {
    const items = await client.listTaskSessions();
    if (json) return printJson(items);
    return printItems("Requested Work", items, (item) => [
      `${item.goal?.summary || item.session_id} [${item.status || "unknown"}]`,
      `id: ${item.session_id}`,
      `type: ${item.task_type || "unknown"} · project: ${item.project_context?.project_id || "standalone"}`,
      `result: ${item.artifact?.preview_text || "pending"}`,
    ]);
  }
  if (action === "task") {
    const [sessionId] = args;
    if (!sessionId) {
      throw new Error("Usage: control presence task <sessionId>");
    }
    const body = await client.getJson(`/api/task-sessions/${encodeURIComponent(sessionId)}`);
    return printJson(body.item || body);
  }
  if (action === "memory") {
    const [logicalPath] = args;
    if (!logicalPath) {
      throw new Error("Usage: control presence memory <knowledge/logical/path.md>");
    }
    const text = await client.getText(`/api/knowledge-ref?path=${encodeURIComponent(logicalPath)}`);
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  throw new Error(`Unsupported presence action: ${action}`);
}

async function handleChronos(action: string, args: string[], json: boolean): Promise<void> {
  const client = createControlPlaneClient("chronos", { timeoutMs: 5000, retryCount: 1 });
  if (action === "overview") {
    const body = await client.getChronosOverview();
    if (json) return printJson(body);
    process.stdout.write(`Chronos overview\n`);
    process.stdout.write(`- access: ${body.accessRole}\n`);
    process.stdout.write(`- projects: ${asArray(body.projects).length}\n`);
    process.stdout.write(`- mission seeds: ${asArray(body.missionSeeds).length}\n`);
    process.stdout.write(`- approvals: ${asArray(body.pendingApprovals).length}\n`);
    process.stdout.write(`- distill candidates: ${asArray(body.distillCandidates).length}\n`);
    return;
  }
  if (action === "approvals") {
    const items = await client.listApprovals();
    if (json) return printJson(items);
    return printItems("Chronos Approvals", items, (item) => [
      `${item.title || item.id} [${item.riskLevel || "unknown"}]`,
      `id: ${item.id} · channel: ${item.channel || "unknown"} · storage: ${item.storageChannel || "unknown"}`,
      `mission: ${item.missionId || "-"} · service: ${item.serviceId || "-"}`,
    ]);
  }
  if (action === "approve") {
    const [requestId, storageChannel, channel, decision] = args;
    if (!requestId || !storageChannel || !channel || !["approved", "rejected"].includes(String(decision))) {
      throw new Error("Usage: control chronos approve <requestId> <storageChannel> <channel> <approved|rejected>");
    }
    const body = await client.postJson("/api/intelligence", { action: "approval_decision", requestId, storageChannel, channel, decision });
    return printJson(body);
  }
  if (action === "mission-seeds") {
    const items = await client.listMissionSeeds();
    if (json) return printJson(items);
    return printItems("Mission Seeds", items, (item) => [
      `${item.title || item.seed_id} [${item.status || "unknown"}]`,
      `seed: ${item.seed_id} · project: ${item.project_id || "standalone"}`,
      `specialist: ${item.specialist_id || "unknown"} · type: ${item.mission_type_hint || "general"}`,
      item.promoted_mission_id ? `mission: ${item.promoted_mission_id}` : "mission: -",
    ]);
  }
  if (action === "promote-seed") {
    const [seedId] = args;
    if (!seedId) {
      throw new Error("Usage: control chronos promote-seed <seedId>");
    }
    const body = await client.postJson("/api/intelligence", { action: "promote_mission_seed", seedId });
    return printJson(body);
  }
  if (action === "distill-candidates") {
    const body = await client.getJson("/api/intelligence");
    const items = asArray(body.distillCandidates);
    if (json) return printJson(items);
    return printItems("Distill Candidates", items, (item) => [
      `${item.title || item.candidate_id} [${item.status || "proposed"}]`,
      `candidate: ${item.candidate_id} · kind: ${item.target_kind || "unknown"} · tier: ${item.tier || "unknown"}`,
      `project: ${item.project_id || "standalone"} · mission: ${item.mission_id || "-"} · task: ${item.task_session_id || "-"}`,
      item.promoted_ref ? `promoted: ${item.promoted_ref}` : "promoted: -",
    ]);
  }
  if (action === "distill") {
    const [candidateId, decision] = args;
    if (!candidateId || !["promote", "archive"].includes(String(decision))) {
      throw new Error("Usage: control chronos distill <candidateId> <promote|archive>");
    }
    const body = await client.postJson("/api/intelligence", { action: "distill_candidate_decision", candidateId, decision });
    return printJson(body);
  }
  if (action === "mission-control") {
    const [missionId, operation] = args;
    if (!missionId || !operation) {
      throw new Error("Usage: control chronos mission-control <missionId> <resume|refresh_team|prewarm_team|staff_team|finish>");
    }
    const body = await client.postJson("/api/intelligence", { action: "mission_control", missionId, operation });
    return printJson(body);
  }
  if (action === "surface-control") {
    const [operation, surfaceId] = args;
    if (!operation) {
      throw new Error("Usage: control chronos surface-control <reconcile|status|start|stop> [surfaceId]");
    }
    const body = await client.postJson("/api/intelligence", { action: "surface_control", operation, surfaceId });
    return printJson(body);
  }
  throw new Error(`Unsupported chronos action: ${action}`);
}

function printHelp(): void {
  process.stdout.write(`Kyberion Control Plane CLI

Usage:
  pnpm control doctor
  pnpm control doctor --surface presence --verbose
  pnpm control doctor --fix
  pnpm control presence projects
  pnpm control presence approvals
  pnpm control presence approve <requestId> <approved|rejected>
  pnpm control presence outcomes
  pnpm control presence tasks
  pnpm control presence task <sessionId>
  pnpm control presence memory <knowledge/logical/path.md>

  pnpm control chronos overview
  pnpm control chronos approvals
  pnpm control chronos approve <requestId> <storageChannel> <channel> <approved|rejected>
  pnpm control chronos mission-seeds
  pnpm control chronos promote-seed <seedId>
  pnpm control chronos distill-candidates
  pnpm control chronos distill <candidateId> <promote|archive>
  pnpm control chronos mission-control <missionId> <operation>
  pnpm control chronos surface-control <operation> [surfaceId]

Environment:
  PRESENCE_STUDIO_URL  default http://127.0.0.1:3031
  CHRONOS_URL          default http://127.0.0.1:3000
  KYBERION_LOCALADMIN_TOKEN / KYBERION_API_TOKEN for Chronos API
  Requests use a short timeout/retry and report stale surface processes explicitly.
`);
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option("json", { type: "boolean", default: false, description: "Print raw JSON" })
    .option("surface", { type: "string", choices: ["presence", "chronos"], description: "Filter doctor to one surface" })
    .option("verbose", { type: "boolean", default: false, description: "Show endpoint details in doctor output" })
    .option("fix", { type: "boolean", default: false, description: "Attempt suggested remediation for doctor failures" })
    .parseSync();
  const positional = (argv._ || []).map((value) => String(value));
  const [surface, action, ...rest] = positional;
  if (!surface || surface === "help" || surface === "--help") {
    printHelp();
    return;
  }
  if (surface === "doctor") {
    await runDoctor({
      json: Boolean(argv.json),
      verbose: Boolean(argv.verbose),
      fix: Boolean(argv.fix),
      surface: argv.surface as SurfaceKind | undefined,
    });
    return;
  }
  if (surface !== "presence" && surface !== "chronos") {
    throw new Error(`Unsupported surface "${surface}". Use "presence" or "chronos".`);
  }
  if (!action) {
    printHelp();
    return;
  }
  if (surface === "presence") {
    await handlePresence(action, rest, Boolean(argv.json));
    return;
  }
  await handleChronos(action, rest, Boolean(argv.json));
}

main().catch((error) => {
  logger.error(error?.message || String(error));
  if (error instanceof ControlPlaneClientError && error.suggestedCommand) {
    process.stderr.write(`Suggested fix: ${error.suggestedCommand}\n`);
  }
  process.exit(1);
});
