import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { resolveRuntimeModelId } from '@agent/core/reasoning-model-routing';
import { safeExistsSync } from '@agent/core/secure-io';
import { toWireError } from '@agent/core/wire-error';
import { getRegisteredEnvText, nowIso, parseSafeJsonInput } from '@agent/core/foundation';
import { pathResolver as projectPathResolver } from '@agent/core/path-resolver';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { resolveViewerContextForRequest, type ViewerContext } from '../../../lib/viewer-context';
import { buildUserFacingError } from '../../../lib/user-facing-error';
import {
  chronosConversationScope,
  intentResolutionA2ui,
  readChronosAgentBody,
  resolveChronosPipelineInputPath,
  withMissionRole,
} from './agent-route-helpers';
import {
  normalizeChronosLocale,
  uxMessage,
  uxTextOr,
  type SupportedLocale,
} from '../../../lib/ux-vocabulary';
import {
  collectActiveMissions,
  runCommandQuickAction,
  runScheduleQuickAction,
} from './chronos-quick-action-helpers';
import {
  parseChronosAuditEvent,
  parseChronosMissionProposalState,
  parseChronosSurfaceRequestArtifact,
  type ChronosMissionProposalState,
  type MissionProposal,
} from './chronos-persisted-parsers';

async function loadChronosCore() {
  const [
    presenceBridge,
    pathResolverModule,
    secureIo,
    channelSurface,
    surfaceInteraction,
    runtimeSupervisor,
    runtimeSupervisorClient,
    pipelineContract,
    agentManifest,
    orchestrationEvents,
    toolRuntimeRegistry,
    coreLogger,
    missionState,
  ] = await Promise.all([
    import('@agent/core/presence-bridge'),
    import('@agent/core/path-resolver'),
    import('@agent/core/secure-io'),
    import('@agent/core/channel-surface'),
    import('@agent/core/surface-interaction-model'),
    import('@agent/core/agent-runtime-supervisor'),
    import('@agent/core/agent-runtime-supervisor-client'),
    import('@agent/core/pipeline-contract'),
    import('@agent/core/agent-manifest'),
    import('@agent/core/mission-orchestration-events'),
    import('@agent/core/tool-runtime-registry'),
    import('@agent/core/core'),
    import('@agent/core/mission-state'),
  ]);

  return {
    logger: coreLogger.logger,
    pathResolver: pathResolverModule.pathResolver,
    assertSafeRepositoryPath: secureIo.assertSafeRepositoryPath,
    loadStateAtPath: missionState.loadStateAtPath,
    loadMissionNextTaskRecordsAtPath: missionState.loadMissionNextTaskRecordsAtPath,
    safeExistsSync: secureIo.safeExistsSync,
    safeMkdir: secureIo.safeMkdir,
    safeLstat: secureIo.safeLstat,
    safeReadFile: secureIo.safeReadFile,
    safeReaddir: secureIo.safeReaddir,
    safeRmSync: secureIo.safeRmSync,
    safeWriteFile: secureIo.safeWriteFile,
    recordChronosDelegationSummary: channelSurface.recordChronosDelegationSummary,
    recordChronosSurfaceRequest: channelSurface.recordChronosSurfaceRequest,
    runSurfaceConversation: channelSurface.runSurfaceConversation,
    runSurfaceMessageConversation: channelSurface.runSurfaceMessageConversation,
    buildMissionIssuanceReply: channelSurface.buildMissionIssuanceReply,
    issueChronosMissionFromProposal: channelSurface.issueChronosMissionFromProposal,
    reflectPresenceAgentReply: presenceBridge.reflectPresenceAgentReply,
    dispatchPresenceFrame: presenceBridge.dispatchPresenceFrame,
    listSurfaceOutboxMessages: channelSurface.listSurfaceOutboxMessages,
    isSlackMissionConfirmation: channelSurface.isSlackMissionConfirmation,
    isSlackMissionRejection: channelSurface.isSlackMissionRejection,
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
    listToolRuntimeInventory: toolRuntimeRegistry.listToolRuntimeInventory,
    safeExec: secureIo.safeExec,
    safeExecResult: secureIo.safeExecResult,
    emitMissionOrchestrationObservation: orchestrationEvents.emitMissionOrchestrationObservation,
    enqueueMissionOrchestrationEvent: orchestrationEvents.enqueueMissionOrchestrationEvent,
    startMissionOrchestrationWorker: orchestrationEvents.startMissionOrchestrationWorker,
  };
}

const PROJECT_ROOT = projectPathResolver.rootDir();

const CHRONOS_AGENT_ID = 'chronos-mirror';
const CHRONOS_IDLE_TIMEOUT_MS = Number(
  getRegisteredEnvText('KYBERION_CHRONOS_IDLE_TIMEOUT_MS') || 10 * 60 * 1000
);
const RUN_PIPELINE_PATTERN = /^node\s+dist\/scripts\/run_pipeline\.js\s+--input\s+(\S+)/;
const QUICK_ACTION_PATTERN = /^chronos:\/\/quick-action\/([a-z-]+)$/;

const g = globalThis as any;

type ChronosCore = Awaited<ReturnType<typeof loadChronosCore>>;

function readSafeChronosFile(core: ChronosCore, filePath: string): string | null {
  try {
    const safePath = core.assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!core.safeExistsSync(safePath) || !core.safeLstat(safePath).isFile()) return null;
    return core.safeReadFile(safePath, { encoding: 'utf8' }) as string;
  } catch {
    return null;
  }
}

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
      await stopAgentRuntime(CHRONOS_AGENT_ID, 'chronos_api');
    } catch (_) {
      /* best-effort cleanup */
    }
    clearChronosCache();
  }, CHRONOS_IDLE_TIMEOUT_MS);
  g.__kyberionChronosIdleTimer.unref?.();
}

async function ensureChronosAgent(context?: {
  missionId?: string;
  teamRole?: string;
  requesterId?: string;
}) {
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
  if (cachedHandle && cachedStatus !== 'shutdown' && cachedStatus !== 'error') {
    scheduleChronosShutdown();
    return cachedHandle;
  }
  const runtimeHandle = getAgentRuntimeHandle(CHRONOS_AGENT_ID);
  if (!runtimeHandle || cachedStatus === 'shutdown' || cachedStatus === 'error') {
    clearChronosCache();
  }

  // Use a separate promise key to avoid storing a rejected promise forever
  if (!g.__kyberionChronosReady) {
    g.__kyberionChronosReady = (async () => {
      const manifest = getAgentManifest(CHRONOS_AGENT_ID, PROJECT_ROOT);
      const spawnOptions = {
        agentId: CHRONOS_AGENT_ID,
        provider: manifest?.selection_hints?.preferred_provider || 'agy',
        modelId:
          manifest?.selection_hints?.preferred_modelId || resolveRuntimeModelId('gemini-default'),
        systemPrompt: manifest?.systemPrompt,
        capabilities: manifest?.capabilities || ['a2ui', 'dashboard', 'commands', 'gateway'],
        cwd: PROJECT_ROOT,
        requestedBy: 'chronos_api',
        runtimeOwnerId: context?.missionId || CHRONOS_AGENT_ID,
        runtimeOwnerType: context?.missionId ? 'mission' : 'surface',
        runtimeMetadata: {
          lease_kind: 'chronos_surface',
          mission_id: context?.missionId,
          team_role: context?.teamRole,
          requester_id: context?.requesterId || 'chronos-ui',
        },
      } as const;
      console.log('[CHRONOS_DEBUG] spawnOptions:', spawnOptions);
      let handle;
      try {
        const snapshot = await ensureAgentRuntimeViaDaemon(toSupervisorEnsurePayload(spawnOptions));
        handle = createSupervisorBackedAgentHandle(CHRONOS_AGENT_ID, 'chronos_api', snapshot);
      } catch (_) {
        handle = await ensureAgentRuntime(spawnOptions);
      }
      g.__kyberionChronosHandle = handle;
      scheduleChronosShutdown();
      return handle;
    })().catch((err: any) => {
      console.error('[API_AGENT] Boot failed:', err.message);
      clearChronosCache();
      throw err;
    });
  }
  await g.__kyberionChronosReady;
  scheduleChronosShutdown();
  return g.__kyberionChronosHandle;
}

function chronosMissionProposalStatePath(
  sessionId: string,
  pathResolver: Awaited<ReturnType<typeof loadChronosCore>>['pathResolver']
): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return pathResolver.resolve(
    `active/shared/coordination/channels/chronos/mission-proposals/chronos-${safeSession}.json`
  );
}

function getChronosMissionProposalState(
  sessionId: string,
  core: Awaited<ReturnType<typeof loadChronosCore>>
): ChronosMissionProposalState | null {
  const statePath = chronosMissionProposalStatePath(sessionId, core.pathResolver);
  return withMissionRole('chronos_gateway', () => {
    const raw = readSafeChronosFile(core, statePath);
    if (raw === null) return null;
    try {
      return parseChronosMissionProposalState(parseSafeJsonInput(raw, 'mission proposal state'));
    } catch {
      return null;
    }
  });
}

function saveChronosMissionProposalState(
  params: {
    sessionId: string;
    proposal: MissionProposal;
    sourceText?: string;
    routingDecision?: AgentRoutingDecision;
  },
  core: Awaited<ReturnType<typeof loadChronosCore>>
): string {
  const statePath = chronosMissionProposalStatePath(params.sessionId, core.pathResolver);
  return withMissionRole('chronos_gateway', () => {
    core.safeMkdir(path.dirname(statePath));
    core.safeWriteFile(
      statePath,
      JSON.stringify(
        {
          surface: 'chronos',
          channel: 'chronos',
          threadTs: params.sessionId,
          proposal: params.proposal,
          sourceText: params.sourceText,
          routingDecision: params.routingDecision,
          createdAt: nowIso(),
        } satisfies ChronosMissionProposalState,
        null,
        2
      )
    );
    return statePath;
  });
}

function clearChronosMissionProposalState(
  sessionId: string,
  core: Awaited<ReturnType<typeof loadChronosCore>>
): void {
  const statePath = chronosMissionProposalStatePath(sessionId, core.pathResolver);
  withMissionRole('chronos_gateway', () => {
    if (!core.safeExistsSync(statePath) || !core.safeLstat(statePath).isFile()) return;
    core.safeRmSync(statePath, { force: true });
  });
}

async function tryHandleDeterministicPipelineQuery(query: string, locale: SupportedLocale) {
  const match = query.match(RUN_PIPELINE_PATTERN);
  if (!match) return null;

  const { safeExec, logger } = await loadChronosCore();
  const inputPath = resolveChronosPipelineInputPath(PROJECT_ROOT, match[1]);
  if (!inputPath) return null;
  const output = safeExec('node', ['dist/scripts/run_pipeline.js', '--input', inputPath], {
    cwd: PROJECT_ROOT,
  });

  logger.info(`[CHRONOS] Deterministic pipeline query executed via built script: ${match[1]}`);

  return {
    status: 'ok',
    response: uxMessage(
      'chronos_pipeline_completed',
      { pipeline: match[1] },
      `Pipeline ${match[1]} completed.`,
      locale
    ),
    a2ui: [
      {
        type: 'display:section',
        props: {
          title: 'Pipeline Execution',
          description: `Deterministic execution of ${match[1]} through the built pipeline runner.`,
          items: [
            {
              type: 'display:log',
              props: {
                title: 'Execution Output',
                lines: output.split('\n').filter(Boolean).slice(-40),
              },
            },
          ],
        },
      },
    ],
    pipeline: {
      input: match[1],
      status: 'completed',
    },
    delegations: undefined,
    timestamp: nowIso(),
  };
}

async function tryHandleChronosQuickAction(
  query: string,
  locale: SupportedLocale,
  viewer: ViewerContext
) {
  const match = query.match(QUICK_ACTION_PATTERN);
  if (!match) return null;

  // Quick actions intentionally execute repository-wide operator commands and
  // several of them read global mission/audit/runtime state. They are not yet
  // tenant-aware projections, so never expose them to a scoped viewer. The
  // route performs the localadmin check before entering this helper as well.
  if (viewer.tenantSlugs !== 'all') return null;

  const action = match[1];
  const core = await loadChronosCore();

  const readJson = <T = unknown>(filePath: string) =>
    core.readJson<T>(core.assertSafeRepositoryPath(filePath));

  switch (action) {
    case 'prereq-check': {
      return runCommandQuickAction(
        core,
        PROJECT_ROOT,
        'Kyberion Toolchain Preflight',
        ['env:bootstrap', '--manifest', 'kyberion-toolchain'],
        'Confirm the local Node, pnpm, git, and source-workflow tooling before you build from source.',
        locale
      );
    }
    case 'setup-report': {
      return runCommandQuickAction(
        core,
        PROJECT_ROOT,
        'Kyberion Setup Report',
        ['setup:report'],
        'Inspect surfaces, services, reasoning, and doctor readiness together before you start work.',
        locale
      );
    }
    case 'doctor': {
      return runCommandQuickAction(
        core,
        PROJECT_ROOT,
        'Kyberion Doctor',
        ['run', 'doctor'],
        'Run the consolidated readiness check for must / should / nice signals.',
        locale
      );
    }
    case 'surfaces-setup': {
      return runCommandQuickAction(
        core,
        PROJECT_ROOT,
        'Surface Setup',
        ['surfaces', 'setup'],
        'Inspect surface auth readiness and host-managed bridge prerequisites.',
        locale
      );
    }
    case 'services-setup': {
      return runCommandQuickAction(
        core,
        PROJECT_ROOT,
        'Service Setup',
        ['services:setup'],
        'Inspect external service presets, auth strategies, and connection files.',
        locale
      );
    }
    case 'reasoning-setup': {
      return runCommandQuickAction(
        core,
        PROJECT_ROOT,
        'Reasoning Setup',
        ['reasoning:setup'],
        'Inspect reasoning backend readiness before routing missions through a provider.',
        locale
      );
    }
    case 'schedule-tick':
      return runScheduleQuickAction('tick', locale);
    case 'schedule-list':
      return runScheduleQuickAction('list', locale);
    case 'dashboard': {
      const missions = collectActiveMissions(core);
      const runtime = core.listAgentRuntimeSnapshots();
      const pendingOutbox = [
        ...core.listSurfaceOutboxMessages('slack', { includeTenantNamespaces: true }),
        ...core.listSurfaceOutboxMessages('chronos', { includeTenantNamespaces: true }),
      ].length;

      return {
        status: 'ok',
        response: uxMessage(
          'chronos_dashboard_ready',
          {
            missions: missions.length,
            runtimes: runtime.length,
            pendingOutbox,
          },
          `Dashboard ready. ${missions.length} missions, ${runtime.length} agent runtimes, ${pendingOutbox} pending outbox messages.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Operator Snapshot',
              title: 'Chronos Dashboard',
              description:
                'Mission state, runtime health, and pending delivery are aligned into a single control surface snapshot.',
              status: `${missions.length} missions`,
            },
          },
          {
            type: 'display:metrics-row',
            props: {
              metrics: [
                { label: 'missions', value: missions.length, trend: 'flat' },
                { label: 'runtime', value: runtime.length, trend: 'flat' },
                {
                  label: 'ready',
                  value: runtime.filter((entry: any) => entry.agent.status === 'ready').length,
                  trend: 'flat',
                },
                { label: 'outbox', value: pendingOutbox, trend: pendingOutbox > 0 ? 'up' : 'flat' },
              ],
            },
          },
          {
            type: 'display:table',
            props: {
              title: 'Active Missions',
              headers: ['Mission', 'Status', 'Tier', 'Type', 'Next', 'Plan'],
              rows: missions
                .slice(0, 12)
                .map((mission) => [
                  mission.missionId,
                  mission.status,
                  mission.tier,
                  mission.missionType || 'development',
                  String(mission.nextTaskCount),
                  mission.planReady ? 'ready' : 'pending',
                ]),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'missions': {
      const missions = collectActiveMissions(core);
      return {
        status: 'ok',
        response: uxMessage(
          'chronos_mission_list_refreshed',
          { missions: missions.length },
          `Mission list refreshed from active mission state. ${missions.length} missions are visible to Chronos.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Mission Control',
              title: 'Visible Missions',
              description:
                'Chronos lists missions from active mission state under public and confidential tiers.',
              status: `${missions.length} visible`,
            },
          },
          {
            type: 'display:table',
            props: {
              title: 'Mission Registry View',
              headers: ['Mission', 'Status', 'Tier', 'Checkpoints', 'Next Tasks', 'Plan'],
              rows: missions.map((mission) => [
                mission.missionId,
                mission.status,
                mission.tier,
                String(mission.checkpoints),
                String(mission.nextTaskCount),
                mission.planReady ? 'ready' : 'pending',
              ]),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'agents': {
      const manifests = core.loadAgentManifests();
      const runtimes = core.listAgentRuntimeSnapshots();
      const runtimeById = new Map(runtimes.map((entry: any) => [entry.agent.agentId, entry]));
      return {
        status: 'ok',
        response: uxMessage(
          'chronos_agent_catalog_refreshed',
          { manifests: manifests.length, runtimes: runtimes.length },
          `Agent catalog refreshed. ${manifests.length} manifests, ${runtimes.length} active runtimes.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Agent Catalog',
              title: 'Available Agents',
              description:
                'Manifest definitions are merged with current runtime status so operator decisions match actual runtime state.',
              status: `${runtimes.length} active runtimes`,
            },
          },
          {
            type: 'display:table',
            props: {
              title: 'Agents',
              headers: ['Agent', 'Provider', 'Model', 'Status', 'Capabilities'],
              rows: manifests.map((manifest: any) => {
                const runtime = runtimeById.get(manifest.agentId);
                return [
                  manifest.agentId,
                  manifest.provider,
                  manifest.modelId || '-',
                  runtime?.agent.status || 'offline',
                  (manifest.capabilities || []).join(', '),
                ];
              }),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'vital-check': {
      const missions = collectActiveMissions(core);
      const runtimes = core.listAgentRuntimeSnapshots();
      const readyCount = runtimes.filter((entry: any) => entry.agent.status === 'ready').length;
      const pendingOutbox =
        core.listSurfaceOutboxMessages('slack', { includeTenantNamespaces: true }).length +
        core.listSurfaceOutboxMessages('chronos', { includeTenantNamespaces: true }).length;
      return {
        status: 'ok',
        response: uxMessage(
          'chronos_vital_check_complete',
          {
            missions: missions.length,
            readyRuntimes: readyCount,
            totalRuntimes: runtimes.length,
            pendingOutbox,
          },
          `Vital check complete. ${missions.length} missions, ${readyCount}/${runtimes.length} runtimes ready, ${pendingOutbox} pending outbox messages.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Vital Check',
              title: 'System Vital Signs',
              description: 'Mission load, runtime readiness, and surface delivery pressure.',
              status: readyCount === runtimes.length ? 'healthy' : 'degraded',
            },
          },
          {
            type: 'display:metrics-row',
            props: {
              metrics: [
                { label: 'missions', value: missions.length, trend: 'flat' },
                { label: 'runtimes', value: runtimes.length, trend: 'flat' },
                {
                  label: 'ready',
                  value: readyCount,
                  trend: readyCount === runtimes.length ? 'flat' : 'down',
                },
                { label: 'outbox', value: pendingOutbox, trend: pendingOutbox > 0 ? 'up' : 'flat' },
              ],
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'diagnostics': {
      const runtimes = core.listAgentRuntimeSnapshots();
      const problematic = runtimes.filter((entry: any) => entry.agent.status !== 'ready');
      const toolRuntimes = core.listToolRuntimeInventory();
      const readyToolRuntimes = toolRuntimes.items.filter(
        (item: any) => item.lifecycle_stage === 'installed' || item.lifecycle_stage === 'pinned'
      );
      const recentFiles = [
        core.pathResolver.shared('observability/mission-control/orchestration-events.jsonl'),
        core.pathResolver.shared('observability/channels/slack/missions.jsonl'),
      ];
      const recentLines = recentFiles
        .flatMap((file) => {
          const raw = readSafeChronosFile(core, file);
          if (raw === null) return [];
          return raw.trim().split('\n').filter(Boolean).slice(-5);
        })
        .slice(-10);
      return {
        status: 'ok',
        response: uxMessage(
          'chronos_diagnostics_loaded',
          {
            problematic: problematic.length,
            readyTools: readyToolRuntimes.length,
            totalTools: toolRuntimes.items.length,
          },
          `Diagnostics loaded. ${problematic.length} non-ready agent runtimes and ${readyToolRuntimes.length}/${toolRuntimes.items.length} governed tool runtimes ready.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:section',
            props: {
              title: 'Runtime Diagnostics',
              description:
                'Non-ready runtime entries, governed tool runtime inventory, and recent control-plane events.',
              items: [
                {
                  type: 'display:table',
                  props: {
                    title: 'Non-ready Runtimes',
                    headers: ['Agent', 'Status', 'Owner', 'Kind'],
                    rows:
                      problematic.length > 0
                        ? problematic.map((entry: any) => [
                            entry.agent.agentId,
                            entry.agent.status,
                            entry.agent.ownerId || '-',
                            entry.agent.ownerType || '-',
                          ])
                        : [['none', 'ready', '-', '-']],
                  },
                },
                {
                  type: 'display:table',
                  props: {
                    title: 'Governed Tool Runtimes',
                    headers: ['Tool', 'Lifecycle', 'Action', 'Backend', 'Managed Path'],
                    rows:
                      toolRuntimes.items.length > 0
                        ? toolRuntimes.items.map((item: any) => [
                            item.tool.display_name || item.tool.tool_id,
                            item.lifecycle_stage,
                            item.selected_action,
                            item.selected_backend?.kind || item.selected_backend?.command || '-',
                            item.managed_env_path,
                          ])
                        : [['none', 'trial', '-', '-', '-']],
                  },
                },
                {
                  type: 'display:log',
                  props: {
                    title: 'Recent Events',
                    lines: recentLines,
                  },
                },
              ],
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'capability-audit': {
      const manifests = core.loadAgentManifests();
      const capabilityCounts = manifests
        .flatMap((manifest: any) => manifest.capabilities || [])
        .reduce((acc: Record<string, number>, capability: string) => {
          acc[capability] = (acc[capability] || 0) + 1;
          return acc;
        }, {});
      const rows = Object.entries(capabilityCounts)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 16)
        .map(([capability, count]) => [capability, String(count)]);
      return {
        status: 'ok',
        response: uxMessage(
          'chronos_capability_audit_complete',
          { manifests: manifests.length },
          `Capability audit complete. ${manifests.length} agent manifests were scanned.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Capability Audit',
              title: 'Manifest Capability Coverage',
              description: 'Capability density derived from current agent manifests.',
              status: `${manifests.length} manifests`,
            },
          },
          {
            type: 'display:table',
            props: {
              title: 'Capabilities',
              headers: ['Capability', 'Agents'],
              rows,
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'provider-check': {
      const manifests = core.loadAgentManifests();
      const runtimes = core.listAgentRuntimeSnapshots();
      const runtimeById = new Map(
        runtimes.map((entry: any) => [entry.agent.agentId, entry.agent.status])
      );
      return {
        status: 'ok',
        response: uxMessage(
          'chronos_provider_inventory_loaded',
          { manifests: manifests.length },
          `Provider inventory loaded for ${manifests.length} manifests.`,
          locale
        ),
        a2ui: [
          {
            type: 'display:table',
            props: {
              title: 'Provider Status',
              headers: ['Agent', 'Provider', 'Model', 'Runtime'],
              rows: manifests.map((manifest: any) => [
                manifest.agentId,
                manifest.provider,
                manifest.modelId || '-',
                runtimeById.get(manifest.agentId) || 'offline',
              ]),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'audit-log': {
      const auditChainPath = core.pathResolver.rootResolve(
        `active/audit/audit-${nowIso().slice(0, 10)}.jsonl`
      );
      const eventFiles = [
        auditChainPath,
        core.pathResolver.shared('observability/mission-control/orchestration-events.jsonl'),
        core.pathResolver.shared('observability/channels/slack/missions.jsonl'),
      ];
      const events: Array<{ time: string; label: string; detail?: string; status?: string }> = [];
      for (const file of eventFiles) {
        const raw = readSafeChronosFile(core, file);
        if (raw === null) continue;
        const lines = raw.trim().split('\n').filter(Boolean);
        for (const line of lines.slice(-12)) {
          let parsed: unknown;
          try {
            parsed = parseSafeJsonInput(line, 'Chronos audit event');
          } catch {
            continue;
          }
          const event = parseChronosAuditEvent(parsed);
          if (!event) continue;
          const routingDecision = event.metadata?.routing_decision;
          const routingSummary = routingDecision
            ? [
                routingDecision.mode,
                routingDecision.owner ? `owner=${routingDecision.owner}` : undefined,
                routingDecision.fanout && routingDecision.fanout !== 'none'
                  ? `fanout=${routingDecision.fanout}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(', ')
            : undefined;
          events.push({
            time: String(event.ts || nowIso()).slice(11, 19),
            label: String(event.decision || event.action || event.event_type || 'event'),
            detail: routingSummary
              ? `${String(event.mission_id || event.resource_id || event.agentId || 'system')} · ${routingSummary}`
              : String(event.mission_id || event.resource_id || event.agentId || 'system'),
            status: String(event.result || event.decision || '').includes('failed')
              ? 'error'
              : String(event.result || event.decision || '').includes('completed')
                ? 'ok'
                : 'warning',
          });
        }
      }
      return {
        status: 'ok',
        response: uxTextOr(
          'chronos_audit_events_loaded',
          'Recent orchestration and mission audit events loaded.',
          locale
        ),
        a2ui: [
          {
            type: 'display:timeline',
            props: {
              title: 'Recent Audit Events',
              events: events.slice(-12).reverse(),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'policies': {
      const securityPolicyPath = core.pathResolver.knowledge(
        'public/governance/security-policy.json'
      );
      const securityPolicy = readJson(securityPolicyPath);
      const chronosPolicy = securityPolicy.authority_role_permissions?.chronos_operator || {};
      return {
        status: 'ok',
        response: uxTextOr('chronos_policy_loaded', 'Chronos operator policy loaded.', locale),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Governance',
              title: 'Chronos Operator Policy',
              description: 'Read scopes and runtime boundaries applied to the Chronos surface.',
              status: 'policy loaded',
            },
          },
          {
            type: 'display:badges',
            props: {
              title: 'Read Scopes',
              items: (chronosPolicy.allow_read || []).map((scope: string) => ({
                label: scope,
                tone: 'info',
              })),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'knowledge': {
      const roots = [
        'knowledge/public',
        'knowledge/product/architecture',
        'knowledge/product/governance',
      ];
      const files = roots
        .flatMap((root) => {
          const dir = core.pathResolver.rootResolve(root);
          try {
            const safeDir = core.assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
            if (!core.safeExistsSync(safeDir) || !core.safeLstat(safeDir).isDirectory()) return [];
            return core.safeReaddir(safeDir).flatMap((name) => {
              try {
                const safeFile = core.assertSafeRepositoryPath(path.join(safeDir, name), {
                  allowMissingLeaf: true,
                });
                return core.safeExistsSync(safeFile) && core.safeLstat(safeFile).isFile()
                  ? [`${root}/${name}`]
                  : [];
              } catch {
                return [];
              }
            });
          } catch {
            return [];
          }
        })
        .slice(0, 24);
      return {
        status: 'ok',
        response: uxTextOr(
          'chronos_knowledge_refreshed',
          'Public knowledge surface refreshed.',
          locale
        ),
        a2ui: [
          {
            type: 'display:list',
            props: {
              title: 'Public Knowledge Files',
              items: files.map((file) => ({ label: file })),
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    case 'build-test': {
      const buildOutput = core.safeExec('pnpm', ['run', 'build'], { cwd: PROJECT_ROOT });
      const testOutput = core.safeExec('pnpm', ['test'], { cwd: PROJECT_ROOT });
      return {
        status: 'ok',
        response: uxTextOr('chronos_build_test_completed', 'Build and test completed.', locale),
        a2ui: [
          {
            type: 'display:section',
            props: {
              title: 'Build & Test',
              description: 'Deterministic local verification from Chronos.',
              items: [
                {
                  type: 'display:log',
                  props: { title: 'Build Output', lines: buildOutput.split('\n').slice(-20) },
                },
                {
                  type: 'display:log',
                  props: { title: 'Test Output', lines: testOutput.split('\n').slice(-20) },
                },
              ],
            },
          },
        ],
        timestamp: nowIso(),
      };
    }
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const parsedBody = await readChronosAgentBody(req);
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const { body, query: rawQuery, requesterId } = parsedBody;
    const core = await loadChronosCore();
    const {
      isSlackMissionConfirmation,
      dispatchPresenceFrame,
      reflectPresenceAgentReply,
      recordChronosDelegationSummary,
      recordChronosSurfaceRequest,
      runSurfaceConversation,
      runSurfaceMessageConversation,
      safeReadFile,
      logger,
    } = core;
    const dispatchPresenceFrameBestEffort = async (frame: any) => {
      try {
        await dispatchPresenceFrame(frame);
      } catch (error: any) {
        logger.warn(
          `[CHRONOS_PRESENCE] Presence Studio unavailable; continuing Sovereign Link response: ${error?.message || String(error)}`
        );
      }
    };
    const reflectPresenceAgentReplyBestEffort = async (reply: any) => {
      try {
        await reflectPresenceAgentReply(reply);
      } catch (error: any) {
        logger.warn(
          `[CHRONOS_PRESENCE] Presence Studio reply reflection unavailable; response remains available: ${error?.message || String(error)}`
        );
      }
    };
    const conversationScope = chronosConversationScope(resolvedViewer.context);
    const locale = normalizeChronosLocale(body.locale);
    const action =
      body.action === 'approve_mission' || body.action === 'reject_mission'
        ? (body.action as 'approve_mission' | 'reject_mission')
        : undefined;
    const query =
      (rawQuery || '').trim() ||
      (action === 'approve_mission' ? '1' : action === 'reject_mission' ? '2' : '');
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId
        : 'chronos-default';
    const pendingMissionProposal = getChronosMissionProposalState(sessionId, core);
    const missionId = typeof body.missionId === 'string' ? body.missionId : undefined;
    const teamRole = typeof body.teamRole === 'string' ? body.teamRole : undefined;

    if (!query) {
      return NextResponse.json(
        { error: uxTextOr('chronos_error_missing_query', 'Missing query', locale) },
        { status: 400 }
      );
    }

    // Mission proposal confirmation/rejection mutates durable proposal state
    // or starts a mission. The proposal record predates tenant-bound scope,
    // so a scoped viewer cannot safely identify its owner; fail closed until
    // the stored state carries an authenticated tenant binding.
    if (action) {
      const proposalAccessDenied = requireChronosAccess(req, 'localadmin');
      if (proposalAccessDenied) return proposalAccessDenied;
      if (resolvedViewer.context.tenantSlugs !== 'all') {
        return NextResponse.json(
          {
            error: 'Chronos mission proposal actions require an all-tenant localadmin viewer.',
          },
          { status: 403 }
        );
      }
    }

    if (QUICK_ACTION_PATTERN.test(query)) {
      const quickActionAccessDenied = requireChronosAccess(req, 'localadmin');
      if (quickActionAccessDenied) return quickActionAccessDenied;
      if (resolvedViewer.context.tenantSlugs !== 'all') {
        return NextResponse.json(
          {
            error:
              'Chronos quick actions require an all-tenant localadmin viewer; use a scoped surface operation instead.',
          },
          { status: 403 }
        );
      }
    }

    if (pendingMissionProposal && core.isSlackMissionRejection?.(query)) {
      const proposalAccessDenied = requireChronosAccess(req, 'localadmin');
      if (proposalAccessDenied) return proposalAccessDenied;
      if (resolvedViewer.context.tenantSlugs !== 'all') {
        return NextResponse.json(
          {
            error: 'Chronos mission proposal actions require an all-tenant localadmin viewer.',
          },
          { status: 403 }
        );
      }
      clearChronosMissionProposalState(sessionId, core);
      return NextResponse.json({
        status: 'ok',
        response: uxTextOr(
          'chronos_mission_discarded',
          'Understood — the mission proposal has been discarded. Nothing was created.',
          locale
        ),
        timestamp: nowIso(),
      });
    }

    if (pendingMissionProposal && isSlackMissionConfirmation(query)) {
      const proposalAccessDenied = requireChronosAccess(req, 'localadmin');
      if (proposalAccessDenied) return proposalAccessDenied;
      if (resolvedViewer.context.tenantSlugs !== 'all') {
        return NextResponse.json(
          {
            error: 'Chronos mission proposal actions require an all-tenant localadmin viewer.',
          },
          { status: 403 }
        );
      }
      const issued = await core.issueChronosMissionFromProposal(
        {
          sessionId,
          proposal: pendingMissionProposal.proposal,
          sourceText: pendingMissionProposal.sourceText,
          routingDecision: pendingMissionProposal.routingDecision,
        },
        core
      );
      clearChronosMissionProposalState(sessionId, core);
      return NextResponse.json({
        status: 'ok',
        response: core.buildMissionIssuanceReply(issued, {
          locale: 'en',
          includeDetails: true,
        }),
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Mission Started',
              title: issued.missionId,
              description: issued.routingDecision
                ? `Type ${issued.missionType}. Tier ${issued.tier}. Persona ${issued.persona}. Routing ${issued.routingDecision.mode}${issued.routingDecision.owner ? ` (${issued.routingDecision.owner})` : ''}.`
                : `Type ${issued.missionType}. Tier ${issued.tier}. Persona ${issued.persona}.`,
              status: issued.orchestrationStatus,
            },
          },
          {
            type: 'display:badges',
            props: {
              title: 'Mission Context',
              items: [
                { label: issued.missionType, tone: 'info' },
                { label: issued.tier, tone: 'warning' },
                { label: issued.persona, tone: 'success' },
              ],
            },
          },
        ],
        mission: issued,
        timestamp: nowIso(),
      });
    }

    const quickActionResponse = await tryHandleChronosQuickAction(
      query,
      locale,
      resolvedViewer.context
    );
    if (quickActionResponse) {
      return NextResponse.json(quickActionResponse);
    }

    if (RUN_PIPELINE_PATTERN.test(query)) {
      const pipelineAccessDenied = requireChronosAccess(req, 'localadmin');
      if (pipelineAccessDenied) return pipelineAccessDenied;
      // The explicit pipeline shortcut executes repository-wide ADF and has
      // no tenant-aware projection. A scoped localadmin must not use it to
      // run a pipeline whose inputs or effects belong to another tenant.
      if (resolvedViewer.context.tenantSlugs !== 'all') {
        return NextResponse.json(
          {
            error:
              'Chronos pipeline shortcuts require an all-tenant localadmin viewer; use a scoped operation instead.',
          },
          { status: 403 }
        );
      }
    }

    const requestArtifactPath = recordChronosSurfaceRequest({
      query,
      sessionId,
      requesterId,
    });
    const requestArtifact = parseChronosSurfaceRequestArtifact(
      readJson<unknown>(requestArtifactPath)
    );
    if (!requestArtifact) {
      throw new Error('Chronos surface request artifact is invalid');
    }

    const deterministicPipelineResponse = await tryHandleDeterministicPipelineQuery(query, locale);
    if (deterministicPipelineResponse) {
      return NextResponse.json(deterministicPipelineResponse);
    }

    await ensureChronosAgent({
      missionId,
      teamRole,
      requesterId,
    });
    await dispatchPresenceFrameBestEffort({
      agentId: CHRONOS_AGENT_ID,
      title: 'Presence Studio',
      status: 'thinking',
      expression: 'thinking',
      subtitle: 'Chronos is preparing a response.',
      transcript: [{ speaker: 'User', text: query }],
    });
    const conversation = await runSurfaceMessageConversation({
      surface: 'chronos',
      text: query,
      locale,
      threadTs: sessionId,
      correlationId: requestArtifact.correlation_id,
      actorId: requesterId,
      senderAgentId: CHRONOS_AGENT_ID,
      agentId: CHRONOS_AGENT_ID,
      cwd: PROJECT_ROOT,
      missionId,
      teamRole,
      scope: conversationScope,
      // I18N-06: English instruction text — the output-language contract
      // itself is injected once, centrally, by
      // `runSurfaceConversation`/`buildOutputLanguageInstruction` in
      // `surface-runtime-orchestrator.ts`, so this no longer needs (and must
      // not hardcode) a target language.
      delegationSummaryInstruction:
        'Below are delegated responses. Summarize them clearly for the user, using A2UI blocks where helpful. Do not emit any additional A2A blocks.',
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
      await dispatchPresenceFrameBestEffort({
        agentId: CHRONOS_AGENT_ID,
        title: 'Presence Studio',
        status: 'speaking',
        expression: 'thinking',
        subtitle: conversation.text || 'Chronos prepared a mission proposal.',
        transcript: [
          { speaker: 'Chronos', text: conversation.text || 'I can turn this into a mission.' },
        ],
      });
      saveChronosMissionProposalState(
        {
          sessionId,
          proposal,
          sourceText: query,
          routingDecision: conversation.routingDecision,
        },
        core
      );
      const confirmationText = [
        conversation.text || 'I can turn this into a mission.',
        '',
        uxTextOr(
          'chronos_mission_confirm_instruction',
          '1) create 2) cancel — reply with the number or `yes`/`no`.',
          locale
        ),
      ]
        .join('\n')
        .trim();

      return NextResponse.json({
        status: 'ok',
        response: confirmationText,
        intentResolution: conversation.intentResolution,
        a2ui: [
          {
            type: 'display:hero',
            props: {
              eyebrow: 'Mission Proposal',
              title: proposal.summary || proposal.why || proposal.mission_type || 'New mission',
              description:
                conversation.text ||
                'Chronos has prepared a mission proposal and is waiting for confirmation.',
              status: 'awaiting confirmation',
            },
          },
          {
            type: 'display:badges',
            props: {
              title: 'Proposed Configuration',
              items: [
                { label: proposal.mission_type || 'development', tone: 'info' },
                { label: proposal.tier || 'public', tone: 'warning' },
                { label: proposal.assigned_persona || 'Ecosystem Architect', tone: 'success' },
              ],
            },
          },
          {
            type: 'display:section',
            props: {
              title: 'Next Step',
              description:
                'Confirm from Chronos to issue the mission through mission_controller and queue orchestration.',
              items: [
                {
                  type: 'display:alert',
                  props: {
                    severity: 'info',
                    title: 'Reply with confirmation',
                    message: uxTextOr(
                      'chronos_mission_confirm_alert_message',
                      '1) create 2) cancel — send the number or `yes`/`no` to start the mission.',
                      locale
                    ),
                  },
                },
              ],
            },
          },
          ...(conversation.intentResolution
            ? intentResolutionA2ui(conversation.intentResolution, locale)
            : []),
        ],
        delegations: delegationResults.length > 0 ? delegationResults : undefined,
        timestamp: nowIso(),
      });
    }

    if (conversation.text) {
      await reflectPresenceAgentReplyBestEffort({
        agentId: CHRONOS_AGENT_ID,
        speaker: 'Chronos',
        text: conversation.text,
      });
    }

    return NextResponse.json({
      status: 'ok',
      response: conversation.text,
      intentResolution: conversation.intentResolution,
      a2ui: [
        ...(conversation.intentResolution
          ? intentResolutionA2ui(conversation.intentResolution, locale)
          : []),
        ...(conversation.a2uiMessages || []),
      ],
      delegations: delegationResults.length > 0 ? delegationResults : undefined,
      timestamp: nowIso(),
    });
  } catch (err: any) {
    clearChronosCache();
    console.error('[CHRONOS_API_AGENT] Error in POST:', err);
    const wireError = toWireError(err);
    const envelope = buildUserFacingError(err, {
      surface: 'chronos',
      traceId: wireError.correlation_id,
    });
    return NextResponse.json(
      {
        error: envelope.body,
        errorCode: wireError.code,
        correlationId: wireError.correlation_id,
        ...envelope,
      },
      { status: 500 }
    );
  }
}
