import { NextRequest, NextResponse } from 'next/server';
import { nowIso } from '@agent/core/foundation';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  requireChronosAccess,
} from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  ViewerContextError,
  viewerErrorResponse,
} from '../../../lib/viewer-context';
import { readChronosJsonObject, readChronosOptionalStringParam } from '../../../lib/request-input';
import { memoryCandidateVisibleToViewer } from '../../../lib/knowledge-scope';
import { collectA2AHandoffs, collectAgentMessages } from '../../../lib/agent-message-feed';
import {
  collectBrowserConversationSessions,
  collectBrowserSessions,
} from '../../../lib/intelligence-observations';
import { buildRuntimeTopology } from '../../../lib/runtime-topology';
import { collectComputerSessions } from '../../../lib/computer-sessions';
import {
  buildTrackGateReadinessSummaries,
  listArtifactRecords,
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  listDistillCandidateRecords,
  listMemoryPromotionCandidates,
  listMissionSeedRecords,
  listProjectRecords,
  listProjectTrackRecords,
  listServiceBindingRecords,
  listSurfaceOutboxMessages,
  summarizeMissionSeedAssessment,
} from '../../../lib/intelligence-primitives';
import { getProjectManagementView } from '@agent/core/project-management';
import { resolveCompany } from '@agent/core/company';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import { inferDeliverableTier } from '../../../lib/deliverable-inbox';
import * as intelligenceData from './intelligence-observation-data';
import * as intelligenceControlData from './intelligence-control-data';
import { parseChronosIntelligenceInput } from './intelligence-input';
import { INTELLIGENCE_ACTION_HANDLERS } from './actions';

let intelligenceSnapshotRevision = 0;

function nextIntelligenceSnapshotRevision(): number {
  intelligenceSnapshotRevision = Math.max(intelligenceSnapshotRevision + 1, Date.now());
  return intelligenceSnapshotRevision;
}

export async function GET(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const accessDenied = requireChronosAccess(req, 'readonly');
    if (accessDenied) return accessDenied;
    const resolvedViewer = resolveViewerContextForRequest(req);
    if (resolvedViewer.response) return resolvedViewer.response;
    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
    const tierAccess = resolvedViewer.context.tierAccess ?? ['public', 'confidential'];
    const allowedTiers = new Set<string>(tierAccess);
    const accessRole = getChronosAccessRoleOrThrow(req);
    const runtimeSupervisorClient = await import('@agent/core/agent-runtime-supervisor-client');
    const runtime = listAgentRuntimeSnapshots();
    const rawActiveMissions = intelligenceData
      .collectActiveMissions()
      .filter(
        (mission) =>
          allowedTiers.has(mission.tier) &&
          (tenantSlugs === 'all' ||
            Boolean(mission.tenantSlug && tenantSlugs.includes(mission.tenantSlug)))
      );
    const runtimeLeases = listAgentRuntimeLeaseSummaries()
      .filter((lease) =>
        intelligenceData.missionVisibleToScope(
          lease.owner_type === 'mission'
            ? lease.owner_id
            : typeof lease.metadata?.mission_id === 'string'
              ? lease.metadata.mission_id
              : undefined,
          tenantSlugs,
          tierAccess
        )
      )
      .slice(0, 12);
    const rawSurfaces = await intelligenceControlData.collectSurfaceSummaries();
    const controlActions = intelligenceControlData.collectControlActions(tenantSlugs, tierAccess);
    const { activeMissions, surfaces } = intelligenceControlData.applyPendingActionSummaries(
      rawActiveMissions,
      rawSurfaces,
      controlActions
    );
    const missionProgress = intelligenceData.collectMissionProgress(activeMissions);
    const agentMessages = collectAgentMessages().filter((message) =>
      intelligenceData.missionVisibleToScope(message.missionId, tenantSlugs, tierAccess)
    );
    const a2aHandoffs = collectA2AHandoffs().filter((handoff) =>
      intelligenceData.missionVisibleToScope(handoff.missionId, tenantSlugs, tierAccess)
    );
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
        provider: entry.provider || 'unknown',
        modelId: entry.model_id || undefined,
        status: entry.status || 'unknown',
        ownerId: entry.owner_id || 'unowned',
        ownerType: entry.owner_type || 'unknown',
        requestedBy:
          typeof entry.metadata?.requestedBy === 'string' ? entry.metadata.requestedBy : undefined,
        leaseKind:
          typeof entry.metadata?.lease_kind === 'string' ? entry.metadata.lease_kind : undefined,
        pid: entry.pid,
        metadata: entry.metadata || undefined,
      }));
    } catch {
      managedRuntimes = runtimeLeases.map((lease) => {
        const snapshot = runtime.find((entry) => entry.agent.agentId === lease.agent_id);
        return {
          agentId: lease.agent_id,
          provider: snapshot?.agent.provider || 'unknown',
          modelId: snapshot?.agent.modelId,
          status: snapshot?.agent.status || 'unknown',
          ownerId: lease.owner_id,
          ownerType: lease.owner_type,
          requestedBy:
            typeof lease.metadata?.requestedBy === 'string'
              ? lease.metadata.requestedBy
              : undefined,
          leaseKind:
            typeof lease.metadata?.execution_mode === 'string'
              ? lease.metadata.execution_mode
              : undefined,
          pid: snapshot?.runtime?.pid,
          metadata: {
            ...(snapshot?.agent.metadata || {}),
            ...(lease.metadata || {}),
          },
        };
      });
    }
    const scopedAgentIds = new Set(runtimeLeases.map((lease) => lease.agent_id));
    const scopedRuntime = runtime.filter((entry) => scopedAgentIds.has(entry.agent.agentId));
    managedRuntimes = managedRuntimes.filter((runtimeEntry) =>
      scopedAgentIds.has(runtimeEntry.agentId)
    );
    const controlActionCatalog = intelligenceControlData.collectControlActionCatalog(accessRole);
    const controlActionAvailability = intelligenceControlData.collectControlActionAvailability(
      accessRole,
      activeMissions,
      surfaces
    );
    const secretApprovals = intelligenceControlData.collectPendingSecretApprovals(
      tenantSlugs,
      tierAccess
    );
    const pendingApprovals = intelligenceControlData.collectPendingApprovals(
      tenantSlugs,
      tierAccess
    );
    const workCoordination = intelligenceData.safeCollect(
      'intelligenceData.collectWorkCoordinationSummary',
      {
        total: 0,
        backlog: 0,
        ready: 0,
        inProgress: 0,
        blocked: 0,
        review: 0,
        done: 0,
        archived: 0,
        runningAttempts: 0,
        recentItems: [],
      },
      () => intelligenceData.collectWorkCoordinationSummary(tenantSlugs, tierAccess)
    );
    const projects = listProjectRecords().filter(
      (project) =>
        allowedTiers.has(project.tier) &&
        Boolean(project.tenant_slug) &&
        (tenantSlugs === 'all' || tenantSlugs.includes(project.tenant_slug as string))
    );
    const projectManagement = intelligenceData.safeCollect('collectProjectManagement', [], () =>
      projects.map((project) => {
        const view = getProjectManagementView(project.project_id);
        return { project: view.project, lineage: view.lineage };
      })
    );
    const projectIds = new Set(projects.map((project) => project.project_id));
    const projectTracks = listProjectTrackRecords().filter(
      (track) =>
        projectIds.has(track.project_id) &&
        (tenantSlugs === 'all' ||
          Boolean(track.tenant_slug && tenantSlugs.includes(track.tenant_slug)))
    );
    const missionSeeds = listMissionSeedRecords().filter((seed) => projectIds.has(seed.project_id));
    const missionSeedAssessment = summarizeMissionSeedAssessment(missionSeeds);
    const distillCandidates = listDistillCandidateRecords().filter((candidate) =>
      Boolean(candidate.project_id && projectIds.has(candidate.project_id))
    );
    const memoryCandidates = listMemoryPromotionCandidates().filter((candidate) =>
      memoryCandidateVisibleToViewer(
        candidate,
        resolvedViewer.context,
        readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
      )
    );
    const nextActions = intelligenceData.buildChronosNextActions({
      pendingApprovals: pendingApprovals.length,
      missionSeeds,
      memoryCandidates,
    });
    const serviceBindings = intelligenceData.filterServiceBindingsToTenant(
      listServiceBindingRecords(),
      projects,
      tenantSlugs
    );
    const scopedSurfaceOutbox = {
      slack: listSurfaceOutboxMessages('slack', { includeTenantNamespaces: true }).filter(
        (message) => intelligenceData.surfaceOutboxVisibleToTenant(message, tenantSlugs, tierAccess)
      ),
      chronos: listSurfaceOutboxMessages('chronos', { includeTenantNamespaces: true }).filter(
        (message) => intelligenceData.surfaceOutboxVisibleToTenant(message, tenantSlugs, tierAccess)
      ),
    };
    const broadOperationalAccess = tenantSlugs === 'all' && tierAccess.includes('confidential');
    const scopedBrowserSessions = broadOperationalAccess ? collectBrowserSessions() : [];
    const scopedBrowserConversationSessions = broadOperationalAccess
      ? collectBrowserConversationSessions()
      : [];
    const scopedComputerSessions = broadOperationalAccess ? collectComputerSessions() : [];
    const allArtifacts = listArtifactRecords().filter((artifact) => {
      if (
        tenantSlugs !== 'all' &&
        (!artifact.tenant_slug || !tenantSlugs.includes(artifact.tenant_slug))
      ) {
        return false;
      }
      const projectTier = artifact.project_id
        ? projects.find((project) => project.project_id === artifact.project_id)?.tier
        : undefined;
      const missionTier = artifact.mission_id
        ? rawActiveMissions.find((mission) => mission.missionId === artifact.mission_id)?.tier
        : undefined;
      const tier = inferDeliverableTier(
        artifact,
        artifact.path?.replace(/\\/g, '/'),
        (projectTier || missionTier) as OsKnowledgeTier | undefined
      );
      return Boolean(tier && allowedTiers.has(tier));
    });
    const recentArtifacts = allArtifacts.slice(-8).reverse();
    const gateReadiness = buildTrackGateReadinessSummaries({
      tracks: projectTracks,
      artifacts: allArtifacts,
    });
    const company = intelligenceControlData.summarizeCompany(
      resolveCompany(
        tenantSlugs !== 'all' && tenantSlugs.length === 1
          ? tenantSlugs[0]
          : intelligenceControlData.resolveChronosTenantSlug()
      )
    );
    return NextResponse.json({
      revision: nextIntelligenceSnapshotRevision(),
      company,
      tenantSlugs,
      activeMissions,
      missionProgress,
      projects,
      projectManagement,
      projectTracks,
      gateReadiness,
      missionSeeds,
      missionSeedAssessment,
      distillCandidates,
      memoryCandidates,
      workCoordination,
      nextActions,
      serviceBindings,
      recentArtifacts,
      pendingApprovals,
      secretApprovals,
      surfaces,
      accessRole,
      recentEvents: intelligenceData.safeCollect(
        'intelligenceControlData.collectRecentEvents',
        [],
        () => intelligenceControlData.collectRecentEvents(tenantSlugs, tierAccess)
      ),
      agentMessages,
      a2aHandoffs,
      controlActionCatalog,
      controlActionAvailability,
      controlActions,
      controlActionDetails: intelligenceData.safeCollect(
        'intelligenceControlData.collectControlActionDetails',
        {},
        () => intelligenceControlData.collectControlActionDetails(tenantSlugs, tierAccess)
      ),
      ownerSummaries: intelligenceData.safeCollect(
        'intelligenceControlData.collectOwnerSummaries',
        [],
        () => intelligenceControlData.collectOwnerSummaries(tenantSlugs, tierAccess)
      ),
      browserSessions: scopedBrowserSessions,
      browserConversationSessions: scopedBrowserConversationSessions,
      computerSessions: scopedComputerSessions,
      surfaceOutbox: {
        slack: scopedSurfaceOutbox.slack.length,
        chronos: scopedSurfaceOutbox.chronos.length,
      },
      recentSurfaceOutbox: intelligenceData.safeCollect(
        'intelligenceControlData.collectRecentSurfaceOutbox',
        [],
        () =>
          intelligenceControlData
            .collectRecentSurfaceOutbox()
            .filter((message) =>
              intelligenceData.surfaceOutboxVisibleToTenant(message, tenantSlugs, tierAccess)
            )
      ),
      runtime: {
        total: scopedRuntime.length,
        ready: scopedRuntime.filter((entry) => entry.agent.status === 'ready').length,
        busy: scopedRuntime.filter((entry) => entry.agent.status === 'busy').length,
        error: scopedRuntime.filter((entry) => entry.agent.status === 'error').length,
      },
      runtimeLeases,
      runtimeDoctor: intelligenceControlData.buildRuntimeDoctor(
        runtimeLeases,
        activeMissions,
        scopedRuntime
      ),
      runtimeTopology: buildRuntimeTopology({
        surfaces: intelligenceControlData.collectRuntimeTopologySurfaces(surfaces),
        runtimes: managedRuntimes,
        handoffs: a2aHandoffs,
        messages: agentMessages,
      }),
      timestamp: nowIso(),
    });
  } catch (err: any) {
    return viewerErrorResponse(err, err instanceof ViewerContextError ? err.status : 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const requiresAdmin = requireChronosAccess(req, 'localadmin');
    if (requiresAdmin) return requiresAdmin;
    const resolvedViewer = resolveViewerContextForRequest(req);
    if (resolvedViewer.response) return resolvedViewer.response;
    const parsedBody = await readChronosJsonObject(req, 'Chronos intelligence');
    if (parsedBody.ok !== true)
      return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const body = parseChronosIntelligenceInput(parsedBody.body);
    const action = body.action;

    const handler = INTELLIGENCE_ACTION_HANDLERS[action];
    if (!handler) {
      return NextResponse.json(
        { error: `Unknown intelligence action: ${action}` },
        { status: 400 }
      );
    }
    return await handler(body, resolvedViewer, action);
  } catch (err: any) {
    return viewerErrorResponse(err, err instanceof ViewerContextError ? err.status : 500);
  }
}
