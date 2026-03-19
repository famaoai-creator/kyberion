import { randomUUID } from 'node:crypto';
import { pathResolver, rootDir } from './path-resolver.js';
import { ensureMissionTeamRuntime, type EnsureMissionTeamRuntimeOptions, type MissionTeamRuntimePlan } from './mission-team-orchestrator.js';
import { agentLifecycle, type SpawnOptions, type AgentHandle, type AgentRuntimeSnapshot } from './agent-lifecycle.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { spawnManagedProcess } from './managed-process.js';

export interface AgentRuntimeEnsureRequest {
  request_id: string;
  mission_id: string;
  team_roles?: string[];
  requested_by: string;
  reason?: string;
  created_at: string;
}

export interface AgentRuntimeEnsureResult {
  request_id: string;
  mission_id: string;
  team_roles?: string[];
  requested_by: string;
  created_at: string;
  completed_at: string;
  runtime_plan: MissionTeamRuntimePlan;
}

export interface EnsureAgentRuntimeOptions extends SpawnOptions {
  requestedBy: string;
}

interface EnsureMissionTeamRuntimeViaSupervisorOptions extends EnsureMissionTeamRuntimeOptions {
  requestedBy: string;
  reason?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const REQUESTS_DIR = pathResolver.shared('coordination/agent-runtime/requests');
const RESULTS_DIR = pathResolver.shared('coordination/agent-runtime/results');
const EVENTS_PATH = pathResolver.shared('observability/mission-control/agent-runtime-supervisor-events.jsonl');
const EVENTS_DIR = pathResolver.shared('observability/mission-control');

function ensureQueueDirs(): void {
  safeMkdir(REQUESTS_DIR);
  safeMkdir(RESULTS_DIR);
}

function ensureEventDir(): void {
  safeMkdir(EVENTS_DIR);
}

function appendSupervisorEvent(event: Record<string, unknown>): void {
  try {
    ensureEventDir();
    safeAppendFileSync(EVENTS_PATH, `${JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    })}\n`);
  } catch {
    // Some narrow authority roles can ensure/stop runtimes without observability write scope.
    // Runtime control should still succeed even if supervisor event logging is unavailable.
  }
}

export function getAgentRuntimeEnsureRequestPath(requestId: string): string {
  ensureQueueDirs();
  return `${REQUESTS_DIR}/${requestId}.json`;
}

export function getAgentRuntimeEnsureResultPath(requestId: string): string {
  ensureQueueDirs();
  return `${RESULTS_DIR}/${requestId}.json`;
}

export function enqueueMissionTeamPrewarmRequest(input: {
  missionId: string;
  teamRoles?: string[];
  requestedBy: string;
  reason?: string;
}): AgentRuntimeEnsureRequest {
  ensureQueueDirs();
  const request: AgentRuntimeEnsureRequest = {
    request_id: `AR-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    mission_id: input.missionId.toUpperCase(),
    team_roles: input.teamRoles?.length ? [...input.teamRoles] : undefined,
    requested_by: input.requestedBy,
    reason: input.reason,
    created_at: new Date().toISOString(),
  };
  safeWriteFile(getAgentRuntimeEnsureRequestPath(request.request_id), JSON.stringify(request, null, 2));
  appendSupervisorEvent({
    decision: 'agent_runtime_prewarm_requested',
    request_id: request.request_id,
    mission_id: request.mission_id,
    requested_by: request.requested_by,
    team_roles: request.team_roles || [],
  });
  return request;
}

export function loadMissionTeamPrewarmRequest(requestPath: string): AgentRuntimeEnsureRequest {
  return JSON.parse(safeReadFile(requestPath, { encoding: 'utf8' }) as string) as AgentRuntimeEnsureRequest;
}

export async function processMissionTeamPrewarmRequest(requestPath: string): Promise<AgentRuntimeEnsureResult> {
  const request = loadMissionTeamPrewarmRequest(requestPath);
  appendSupervisorEvent({
    decision: 'agent_runtime_prewarm_started',
    request_id: request.request_id,
    mission_id: request.mission_id,
    requested_by: request.requested_by,
  });

  const runtime_plan = await ensureMissionTeamRuntime({
    missionId: request.mission_id,
    teamRoles: request.team_roles,
  });

  const result: AgentRuntimeEnsureResult = {
    ...request,
    completed_at: new Date().toISOString(),
    runtime_plan,
  };
  safeWriteFile(getAgentRuntimeEnsureResultPath(request.request_id), JSON.stringify(result, null, 2));
  appendSupervisorEvent({
    decision: 'agent_runtime_prewarm_completed',
    request_id: request.request_id,
    mission_id: request.mission_id,
    requested_by: request.requested_by,
    assignment_count: runtime_plan.assignments.length,
  });
  return result;
}

export function startAgentRuntimeSupervisorForRequest(request: AgentRuntimeEnsureRequest): string {
  const requestPath = getAgentRuntimeEnsureRequestPath(request.request_id);
  const resourceId = `agent-runtime-supervisor:${request.request_id}`;
  spawnManagedProcess({
    resourceId,
    kind: 'service',
    ownerId: request.requested_by,
    ownerType: 'agent-runtime-supervisor',
    command: 'node',
    args: ['dist/scripts/run_agent_runtime_supervisor.js', '--request', requestPath],
    spawnOptions: {
      cwd: rootDir(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
    },
    shutdownPolicy: 'detached',
    metadata: {
      requestId: request.request_id,
      missionId: request.mission_id,
      teamRoles: request.team_roles || [],
    },
  });
  return requestPath;
}

export async function waitForMissionTeamPrewarmResult(
  requestId: string,
  timeoutMs = 600_000,
  pollIntervalMs = 1_000,
): Promise<AgentRuntimeEnsureResult> {
  const resultPath = getAgentRuntimeEnsureResultPath(requestId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (safeExistsSync(resultPath)) {
      return JSON.parse(safeReadFile(resultPath, { encoding: 'utf8' }) as string) as AgentRuntimeEnsureResult;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  appendSupervisorEvent({
    decision: 'agent_runtime_prewarm_timeout',
    request_id: requestId,
  });
  throw new Error(`Timed out waiting for agent runtime prewarm result: ${requestId}`);
}

export async function ensureMissionTeamRuntimeViaSupervisor(
  options: EnsureMissionTeamRuntimeViaSupervisorOptions,
): Promise<AgentRuntimeEnsureResult> {
  const request = enqueueMissionTeamPrewarmRequest({
    missionId: options.missionId,
    teamRoles: options.teamRoles,
    requestedBy: options.requestedBy,
    reason: options.reason,
  });
  startAgentRuntimeSupervisorForRequest(request);
  return waitForMissionTeamPrewarmResult(
    request.request_id,
    options.timeoutMs,
    options.pollIntervalMs,
  );
}

export async function ensureAgentRuntime(options: EnsureAgentRuntimeOptions): Promise<AgentHandle> {
  appendSupervisorEvent({
    decision: 'agent_runtime_ensure_requested',
    agent_id: options.agentId,
    mission_id: options.missionId,
    requested_by: options.requestedBy,
    provider: options.provider,
  });
  const handle = await agentLifecycle.spawn(options);
  appendSupervisorEvent({
    decision: 'agent_runtime_ensure_completed',
    agent_id: options.agentId || handle.agentId,
    mission_id: options.missionId,
    requested_by: options.requestedBy,
    provider: options.provider,
  });
  return handle;
}

export async function stopAgentRuntime(agentId: string, requestedBy: string): Promise<void> {
  appendSupervisorEvent({
    decision: 'agent_runtime_stop_requested',
    agent_id: agentId,
    requested_by: requestedBy,
  });
  await agentLifecycle.shutdown(agentId);
  appendSupervisorEvent({
    decision: 'agent_runtime_stopped',
    agent_id: agentId,
    requested_by: requestedBy,
  });
}

export async function shutdownAllAgentRuntimes(requestedBy: string): Promise<void> {
  appendSupervisorEvent({
    decision: 'agent_runtime_shutdown_all_requested',
    requested_by: requestedBy,
  });
  await agentLifecycle.shutdownAll();
  appendSupervisorEvent({
    decision: 'agent_runtime_shutdown_all_completed',
    requested_by: requestedBy,
  });
}

export function listAgentRuntimeSnapshots(): AgentRuntimeSnapshot[] {
  return agentLifecycle.listSnapshots();
}

export function getAgentRuntimeSnapshot(agentId: string, logLimit?: number): AgentRuntimeSnapshot | null {
  return agentLifecycle.getSnapshot(agentId, logLimit) || null;
}

export function getAgentRuntimeHandle(agentId: string): AgentHandle | null {
  return agentLifecycle.getHandle(agentId) || null;
}

export function getAgentRuntimeLog(agentId: string, limit = 50) {
  return agentLifecycle.getLog(agentId, limit);
}

export async function refreshAgentRuntime(agentId: string, requestedBy: string) {
  appendSupervisorEvent({
    decision: 'agent_runtime_refresh_requested',
    agent_id: agentId,
    requested_by: requestedBy,
  });
  const result = await agentLifecycle.refreshContext(agentId);
  appendSupervisorEvent({
    decision: 'agent_runtime_refreshed',
    agent_id: agentId,
    requested_by: requestedBy,
    mode: result.mode,
  });
  return result;
}

export async function restartAgentRuntime(agentId: string, requestedBy: string): Promise<AgentHandle> {
  appendSupervisorEvent({
    decision: 'agent_runtime_restart_requested',
    agent_id: agentId,
    requested_by: requestedBy,
  });
  const handle = await agentLifecycle.restart(agentId);
  appendSupervisorEvent({
    decision: 'agent_runtime_restarted',
    agent_id: agentId,
    requested_by: requestedBy,
  });
  return handle;
}
