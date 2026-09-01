import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  requireChronosAccess,
  roleToMissionRole,
} from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  ViewerContextError,
  viewerErrorResponse,
  type ViewerContext,
} from '../../../lib/viewer-context';
import { resolveApprovalTenant } from '../../../lib/su-surface-data';
import { readChronosJsonObject } from '../../../lib/request-input';
import { memoryCandidateVisibleToViewer } from '../../../lib/knowledge-scope';
import { buildCompanyVisionRef, resolveCompany, type CompanyAggregate } from '@agent/core/company';
import {
  summarizeApprovalAuditDrilldown,
  summarizeApprovalAuditTrail,
  type ApprovalAuditDrilldownSummary,
} from '@agent/core/approval-audit';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import {
  resolveFinanceControllerDecision,
  type FinanceControllerDecision,
} from '@agent/core/finance-controller';
import type { OrganizationWorkLoopSummary } from '@agent/core/work-design';
import { activeCustomer } from '@agent/core/customer-resolver';
import {
  collectA2AHandoffs,
  collectAgentMessages,
  type AgentMessageSummary,
  type A2AHandoffSummary,
} from '../../../lib/agent-message-feed';
import {
  collectBrowserConversationSessions,
  collectBrowserSessions,
  type BrowserConversationSessionSummary,
  type BrowserSessionSummary,
} from '../../../lib/intelligence-observations';
import {
  extractMissionDependencies,
  normalizeMissionAssets,
  parseTaskBoard,
  summarizeNextTasks,
} from '../../../lib/mission-progress';
import { applyBrowserSessionControl } from '../../../lib/browser-session-control';
import { buildRuntimeTopology } from '../../../lib/runtime-topology';
import {
  collectComputerSessions,
  type ComputerSessionSummary,
} from '../../../lib/computer-sessions';
import {
  buildExecutionEnv,
  buildTrackGateReadinessSummaries,
  buildTrackNextWorkProposal,
  clearSurfaceOutboxMessage,
  createDistillCandidateRecord,
  createNextActionContract,
  decideApprovalRequest,
  loadApprovalRequest,
  normalizeRejectionReasonCategory,
  enqueueSurfaceNotification,
  emitChannelSurfaceEvent,
  emitMissionOrchestrationObservation,
  enqueueMissionOrchestrationEvent,
  ledger,
  listArtifactRecords,
  listAgentRuntimeLeaseSummaries,
  listAgentRuntimeSnapshots,
  listApprovalRequests,
  listDistillCandidateRecords,
  listMemoryPromotionCandidates,
  listMissionSeedRecords,
  listProjectRecords,
  listProjectTrackRecords,
  listServiceBindingRecords,
  listSurfaceOutboxMessages,
  loadDistillCandidateRecord,
  loadMissionSeedRecord,
  loadProjectRecord,
  loadProjectTrackRecord,
  loadSurfaceManifest,
  loadSurfaceState,
  materializeTrackArtifactSkeleton,
  normalizeSurfaceDefinition,
  pathResolver,
  promoteMemoryCandidateToKnowledge,
  promotePersonalMemoryCandidates,
  probeSurfaceHealth,
  restartAgentRuntime,
  safeExec,
  safeExistsSync,
  safeReadFile,
  loadJson,
  safeReaddir,
  safeStat,
  saveDistillCandidateRecord,
  saveMissionSeedRecord,
  saveProjectRecord,
  savePromotedMemoryRecord,
  startMissionOrchestrationWorker,
  stopAgentRuntime,
  summarizeMissionSeedAssessment,
  updateDistillCandidateRecord,
  updateMemoryPromotionCandidateStatus,
} from '../../../lib/intelligence-primitives';
import { listWorkItems } from '@agent/core/work-coordination';
import { getProjectManagementView } from '@agent/core/project-management';
import { listMissionsInSearchDirs, loadState } from '@agent/core/mission-state';
import { inferDeliverableTier } from '../../../lib/deliverable-inbox';
import * as intelligenceData from './intelligence-observation-data';
import * as intelligenceControlData from './intelligence-control-data';
import { parseChronosIntelligenceInput } from './intelligence-input';

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
      req.nextUrl.searchParams.get('tenant') || undefined
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
        req.nextUrl.searchParams.get('tenant') || undefined
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
        projectTier || missionTier
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
      timestamp: new Date().toISOString(),
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
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const body = parseChronosIntelligenceInput(parsedBody.body);
    const action = body.action;

    if (action === 'approval_decision') {
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      const storageChannel = typeof body?.storageChannel === 'string' ? body.storageChannel : '';
      const channel = typeof body?.channel === 'string' ? body.channel : '';
      const decision =
        body?.decision === 'approved' || body?.decision === 'rejected' ? body.decision : null;
      if (!requestId || !storageChannel || !channel || !decision) {
        return NextResponse.json({ error: 'Missing approval decision payload' }, { status: 400 });
      }
      // LC-10: carry the operator's rejection reason (ask-why on the panel)
      // into the decision so the event stream and learning loops see it.
      const decisionNote = typeof body?.note === 'string' ? body.note.trim() : '';
      const decisionReasonCategory = normalizeRejectionReasonCategory(body?.reasonCategory);
      const approvalRecord = loadApprovalRequest(storageChannel, requestId);
      if (!approvalRecord) {
        return NextResponse.json({ error: 'Approval request not found' }, { status: 404 });
      }
      const approvalTenant = resolveApprovalTenant(approvalRecord);
      const allowedTenants = strictViewerScopeTenantSlugs(
        resolvedViewer.context,
        typeof body?.tenant === 'string' ? body.tenant : undefined
      );
      if (
        allowedTenants !== 'all' &&
        (!approvalTenant || !allowedTenants.includes(approvalTenant))
      ) {
        return NextResponse.json(
          { error: 'Approval is outside the viewer tenant scope' },
          { status: 403 }
        );
      }
      const updated = decideApprovalRequest('chronos_gateway', {
        channel,
        storageChannel,
        requestId,
        decision,
        decidedBy: 'chronos-localadmin',
        decidedByRole: 'sovereign',
        authMethod: 'surface_session',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: approvalRecord.accountability?.payloadHash,
        effectBinding: approvalRecord.accountability?.effectBinding,
        note: decisionNote || 'Decision captured from Chronos approval panel.',
        reasonCategory: decisionReasonCategory,
      });
      enqueueSurfaceNotification({
        surface: 'presence',
        requestId: updated.correlationId || updated.id,
        title: `Approval ${decision}`,
        channel: 'chronos',
        threadTs: updated.correlationId || updated.id,
        sourceAgentId: 'chronos_gateway',
        text: intelligenceData.buildApprovalDecisionText({
          title: updated.title,
          decision,
          missionId: updated.requestedByContext?.missionId,
          serviceId: updated.target?.serviceId,
        }),
        status: decision === 'approved' ? 'success' : 'error',
      });
      return NextResponse.json({ ok: true, approval: updated });
    }

    if (action === 'memory_promote_candidate') {
      const candidateId = typeof body?.candidateId === 'string' ? body.candidateId : '';
      if (!candidateId) {
        return NextResponse.json({ error: 'Missing candidateId' }, { status: 400 });
      }
      const candidate = listMemoryPromotionCandidates().find(
        (entry) => entry.candidate_id === candidateId
      );
      if (!candidate) {
        return NextResponse.json(
          { error: 'Memory promotion candidate not found' },
          { status: 404 }
        );
      }
      const requestedTenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
      const allowedTenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      if (!memoryCandidateVisibleToViewer(candidate, resolvedViewer.context, requestedTenant)) {
        return NextResponse.json(
          { error: 'Memory candidate is outside the viewer scope' },
          { status: 403 }
        );
      }
      const promoted = await promoteMemoryCandidateToKnowledge({
        candidateId,
        executionRole: 'chronos_gateway',
        ratificationNote: 'Promoted from the Chronos knowledge review page.',
      });
      return NextResponse.json({
        ok: true,
        candidate: promoted.candidate,
        promotedRef: promoted.promotedRef,
        tenantSlugs: allowedTenants,
      });
    }

    if (action === 'memory_approve_candidate') {
      const candidateId = typeof body?.candidateId === 'string' ? body.candidateId : '';
      if (!candidateId) {
        return NextResponse.json({ error: 'Missing candidateId' }, { status: 400 });
      }
      const candidate = listMemoryPromotionCandidates().find(
        (entry) => entry.candidate_id === candidateId
      );
      const requestedTenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
      strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      if (!candidate) {
        return NextResponse.json(
          { error: 'Memory promotion candidate not found' },
          { status: 404 }
        );
      }
      if (candidate.status !== 'queued' || !candidate.ratification_required) {
        return NextResponse.json(
          { error: 'Only queued candidates requiring ratification can be approved' },
          { status: 409 }
        );
      }
      if (!memoryCandidateVisibleToViewer(candidate, resolvedViewer.context, requestedTenant)) {
        return NextResponse.json(
          { error: 'Memory candidate is outside the viewer scope' },
          { status: 403 }
        );
      }
      const updated = updateMemoryPromotionCandidateStatus({
        candidateId,
        status: 'approved',
        ratificationNote: 'Approved from the Chronos knowledge review page.',
      });
      return NextResponse.json({ ok: true, candidate: updated || candidate });
    }

    if (action === 'memory_reject_candidate') {
      const candidateId = typeof body?.candidateId === 'string' ? body.candidateId : '';
      if (!candidateId) {
        return NextResponse.json({ error: 'Missing candidateId' }, { status: 400 });
      }
      const candidate = listMemoryPromotionCandidates().find(
        (entry) => entry.candidate_id === candidateId
      );
      if (!candidate) {
        return NextResponse.json(
          { error: 'Memory promotion candidate not found' },
          { status: 404 }
        );
      }
      const requestedTenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
      strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      if (!memoryCandidateVisibleToViewer(candidate, resolvedViewer.context, requestedTenant)) {
        return NextResponse.json(
          { error: 'Memory candidate is outside the viewer scope' },
          { status: 403 }
        );
      }
      if (candidate.status !== 'queued' && candidate.status !== 'approved') {
        return NextResponse.json(
          { error: 'Only queued or approved candidates can be rejected' },
          { status: 409 }
        );
      }
      const note = typeof body?.note === 'string' ? body.note.trim() : '';
      const updated = updateMemoryPromotionCandidateStatus({
        candidateId,
        status: 'rejected',
        ratificationNote: note || 'Rejected from the Chronos knowledge review page.',
      });
      return NextResponse.json({ ok: true, candidate: updated || candidate });
    }

    if (action === 'distill_candidate_decision') {
      const candidateId = typeof body?.candidateId === 'string' ? body.candidateId : '';
      const decision =
        body?.decision === 'promote' || body?.decision === 'archive' ? body.decision : null;
      if (!candidateId || !decision) {
        return NextResponse.json(
          { error: 'Missing distill candidate decision payload' },
          { status: 400 }
        );
      }
      const candidate = loadDistillCandidateRecord(candidateId);
      if (!candidate) {
        return NextResponse.json({ error: 'Distill candidate not found' }, { status: 404 });
      }
      const requestedTenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
      const allowedTenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      if (!intelligenceData.distillCandidateVisibleToTenant(candidate, allowedTenants)) {
        return NextResponse.json(
          { error: 'Distill candidate is outside the viewer tenant scope' },
          { status: 403 }
        );
      }
      let updated = candidate;
      if (decision === 'archive') {
        updated = updateDistillCandidateRecord(candidateId, { status: 'archived' }) || candidate;
      } else {
        const saved = savePromotedMemoryRecord(candidate, { executionRole: 'chronos_gateway' });
        updated =
          updateDistillCandidateRecord(candidateId, {
            status: 'promoted',
            promoted_ref: saved.logicalPath,
          }) || candidate;
      }
      enqueueSurfaceNotification({
        surface: 'presence',
        requestId: updated.candidate_id,
        title: decision === 'promote' ? 'Memory promoted' : 'Memory archived',
        channel: 'chronos',
        threadTs: updated.candidate_id,
        sourceAgentId: 'chronos_gateway',
        text:
          decision === 'promote'
            ? `${updated.title} was promoted for reuse.${intelligenceData.buildLearnedNotificationText({ projectId: updated.project_id, language: 'en' })}`
            : `${updated.title} was archived from the memory queue.`,
        status: 'success',
      });
      return NextResponse.json({ ok: true, candidate: updated });
    }

    if (action === 'memory_promote_pending') {
      const requestedTenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
      const allowedTenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      const dryRun = body?.dryRun === true;
      const approved = listMemoryPromotionCandidates()
        .filter(
          (candidate) =>
            candidate.status === 'approved' &&
            memoryCandidateVisibleToViewer(candidate, resolvedViewer.context, requestedTenant)
        )
        .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
      if (dryRun) {
        return NextResponse.json({
          status: 'ok',
          action,
          dryRun: true,
          pending: approved.map((candidate) => ({
            candidate_id: candidate.candidate_id,
            proposed_memory_kind: candidate.proposed_memory_kind,
            sensitivity_tier: candidate.sensitivity_tier,
            source_ref: candidate.source_ref,
          })),
          ts: new Date().toISOString(),
        });
      }

      const promoted: string[] = [];
      const failed: Array<{ candidate_id: string; reason: string }> = [];
      const supersedes = typeof body?.supersedes === 'string' ? body.supersedes : '';
      for (const candidate of approved) {
        try {
          await promoteMemoryCandidateToKnowledge({
            candidateId: candidate.candidate_id,
            executionRole: 'chronos_gateway',
            ratificationNote: 'Promoted from Chronos control action memory_promote_pending.',
            supersedes,
          });
          promoted.push(candidate.candidate_id);
        } catch (err: any) {
          failed.push({
            candidate_id: candidate.candidate_id,
            reason: err?.message || String(err),
          });
        }
      }

      const personalAutopromote =
        allowedTenants === 'all' && resolvedViewer.context.source === 'loopback'
          ? await promotePersonalMemoryCandidates({
              executionRole: 'chronos_gateway',
              ratificationNote: 'Autopromoted from Chronos control action memory_promote_pending.',
              dryRun: false,
            })
          : { enabled: false, considered: 0, promoted: [], skipped: [] };

      emitMissionOrchestrationObservation({
        event_id: `CA-MEM-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        decision: 'memory_promote_pending_applied',
        event_type: 'memory_promote_pending_applied',
        requested_by: 'chronos_localadmin',
        resource_id: 'memory-promotion-queue',
        operation: 'memory_promote_pending',
        action,
        why: 'Chronos localadmin triggered governed memory promotion for approved queue candidates.',
      });

      return NextResponse.json({
        status: 'ok',
        action,
        promoted_count: promoted.length,
        failed_count: failed.length,
        autopromote: personalAutopromote,
        promoted,
        failed,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'next_action_execute') {
      const actionId = typeof body?.actionId === 'string' ? body.actionId : '';
      const operation =
        typeof body?.operation === 'string' ? body.operation : 'next_action_execute';
      const outcome = body?.outcome === 'failed' ? 'failed' : 'completed';
      const target = typeof body?.target === 'string' ? body.target : 'next-actions';
      const detail = typeof body?.detail === 'string' ? body.detail : '';
      if (!actionId) {
        return NextResponse.json({ error: 'Missing actionId' }, { status: 400 });
      }
      emitMissionOrchestrationObservation({
        event_id: `CA-NEXT-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        decision: 'next_action_executed',
        event_type: 'next_action_executed',
        requested_by: 'chronos_localadmin',
        resource_id: target,
        operation,
        outcome,
        action_id: actionId,
        why: detail || 'Chronos operator executed a recommended next action.',
      });
      return NextResponse.json({
        status: 'ok',
        action,
        actionId,
        operation,
        outcome,
        target,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'close_browser_session' || action === 'restart_browser_session') {
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) {
        return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
      }
      const requestedTenant = typeof body?.tenant === 'string' ? body.tenant : undefined;
      const allowedTenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
      if (allowedTenants !== 'all') {
        return NextResponse.json(
          { error: 'Browser session has no resolvable tenant scope' },
          { status: 403 }
        );
      }
      const ok = applyBrowserSessionControl(sessionId, action);
      if (!ok) {
        return NextResponse.json({ error: 'Browser session not found' }, { status: 404 });
      }
      emitMissionOrchestrationObservation({
        decision: 'browser_session_control_applied',
        event_type: 'browser_session_control_applied',
        requested_by: 'chronos_localadmin',
        resource_id: sessionId,
        action,
        why: 'Chronos operator applied browser session control from the browser session panel.',
      });
      return NextResponse.json({
        status: 'ok',
        action,
        sessionId,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'promote_mission_seed') {
      const seedId = typeof body?.seedId === 'string' ? body.seedId : '';
      if (!seedId) {
        return NextResponse.json({ error: 'Missing seedId' }, { status: 400 });
      }
      const seed = loadMissionSeedRecord(seedId);
      if (!seed) {
        return NextResponse.json({ error: 'Mission seed not found' }, { status: 404 });
      }
      const project = loadProjectRecord(seed.project_id);
      if (!project) {
        return NextResponse.json({ error: 'Parent project not found' }, { status: 404 });
      }
      const projectError = intelligenceData.projectScopeError(
        resolvedViewer.context,
        project,
        typeof body?.tenant === 'string' ? body.tenant : undefined
      );
      if (projectError) return projectError;
      const projectPath = intelligenceData.resolveProjectRootPath(project);
      if (!projectPath) {
        return NextResponse.json(
          { error: 'Parent project has no governed root_path' },
          { status: 400 }
        );
      }
      const missionId = `MSN-${seed.seed_id.replace(/^MSD-/, '')}`.toUpperCase();
      const persona =
        seed.specialist_id === 'service-operator' ? 'Reliability Engineer' : 'Ecosystem Architect';
      const missionType = seed.mission_type_hint || 'development';
      const executionContract =
        seed.metadata && typeof seed.metadata.execution_contract === 'object'
          ? (seed.metadata.execution_contract as Record<string, unknown>)
          : null;
      const contractTarget =
        typeof executionContract?.review_target === 'string' ? executionContract.review_target : '';
      const contractRepo =
        typeof executionContract?.repository_id === 'string' ? executionContract.repository_id : '';
      const env = buildExecutionEnv(process.env, 'mission_controller');
      const startArgs = [
        'dist/scripts/mission_controller.js',
        'start',
        missionId,
        '--tier',
        project.tier,
        '--persona',
        persona,
        '--tenant-id',
        project.tenant_slug || 'default',
        '--mission-type',
        missionType,
        '--project-id',
        project.project_id,
        '--project-path',
        projectPath,
        '--project-relationship',
        'belongs_to',
        '--project-note',
        `Promoted from mission seed ${seed.seed_id}${contractTarget ? ` targeting ${contractTarget}` : ''}${contractRepo ? ` in ${contractRepo}` : ''}`,
      ];
      if (seed.track_id) startArgs.push('--track-id', seed.track_id);
      if (seed.track_name) startArgs.push('--track-name', seed.track_name);
      const track = seed.track_id ? loadProjectTrackRecord(seed.track_id) : null;
      if (track?.track_type) startArgs.push('--track-type', track.track_type);
      if (track?.lifecycle_model) startArgs.push('--lifecycle-model', track.lifecycle_model);
      if (seed.track_id || seed.track_name) startArgs.push('--track-relationship', 'belongs_to');
      const startOutput = safeExec('node', startArgs, {
        env,
        cwd: pathResolver.rootDir(),
        timeoutMs: 120_000,
      });
      saveMissionSeedRecord({
        ...seed,
        status: 'promoted',
        promoted_mission_id: missionId,
        track_id: seed.track_id,
        track_name: seed.track_name,
        work_loop: seed.work_loop,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(seed.metadata || {}),
          start_output: startOutput,
          promoted_execution_contract: executionContract,
        },
      });
      const activeMissions = new Set(project.active_missions || []);
      activeMissions.add(missionId);
      saveProjectRecord({
        ...project,
        active_missions: Array.from(activeMissions),
        metadata: {
          ...(project.metadata || {}),
          last_promoted_seed_id: seed.seed_id,
        },
      });
      saveDistillCandidateRecord(
        createDistillCandidateRecord({
          source_type: 'mission',
          tier: project.tier,
          project_id: project.project_id,
          track_id: seed.track_id,
          track_name: seed.track_name,
          mission_id: missionId,
          task_session_id: seed.source_task_session_id,
          title: `Promote durable mission orchestration for ${seed.title}`,
          summary: `${seed.title} was promoted from a project mission seed into durable mission ${missionId}. This transition may be reusable as governed organizational memory.`,
          status: 'proposed',
          target_kind: intelligenceData.inferMissionSeedPromotionTargetKind(seed),
          specialist_id: seed.specialist_id,
          locale: seed.locale || project.primary_locale,
          work_loop: seed.work_loop,
          evidence_refs: [
            `project:${project.project_id}`,
            `mission_seed:${seed.seed_id}`,
            `mission:${missionId}`,
            ...(seed.source_task_session_id ? [`task_session:${seed.source_task_session_id}`] : []),
          ],
          metadata: intelligenceData.buildMissionSeedPromotionMetadata(seed, project),
        })
      );
      emitMissionOrchestrationObservation({
        decision: 'mission_seed_promoted',
        event_type: 'mission_seed_promoted',
        requested_by: 'chronos_localadmin',
        mission_id: missionId,
        resource_id: seed.seed_id,
        why: 'Chronos promoted a project mission seed into a durable mission through mission_controller.',
      });
      enqueueSurfaceNotification({
        surface: 'presence',
        channel: 'voice',
        threadTs: seed.source_task_session_id || seed.seed_id,
        sourceAgentId: 'chronos_localadmin',
        title: `Mission promoted: ${seed.title}`,
        text: `${project.name} の mission seed 「${seed.title}」を durable mission ${missionId} として開始しました。${intelligenceData.buildLearnedNotificationText({ projectId: project.project_id, language: 'ja' })}`,
      });
      return NextResponse.json({
        status: 'ok',
        action,
        seedId,
        missionId,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'create_track_seed') {
      const trackId = typeof body?.trackId === 'string' ? body.trackId : '';
      const artifactId = typeof body?.artifactId === 'string' ? body.artifactId : undefined;
      if (!trackId) {
        return NextResponse.json({ error: 'Missing trackId' }, { status: 400 });
      }
      const track = loadProjectTrackRecord(trackId);
      if (!track) {
        return NextResponse.json({ error: 'Track not found' }, { status: 404 });
      }
      const project = loadProjectRecord(track.project_id);
      if (!project) {
        return NextResponse.json({ error: 'Parent project not found' }, { status: 404 });
      }
      const projectError = intelligenceData.projectScopeError(
        resolvedViewer.context,
        project,
        typeof body?.tenant === 'string' ? body.tenant : undefined
      );
      if (projectError) return projectError;
      const readiness = buildTrackGateReadinessSummaries({
        tracks: [track],
        artifacts: listArtifactRecords(),
      })[0];
      if (!readiness) {
        return NextResponse.json({ error: 'Track readiness not available' }, { status: 400 });
      }
      const proposal = buildTrackNextWorkProposal({ project, track, readiness, artifactId });
      if (!proposal) {
        return NextResponse.json({ error: 'No pending gate artifact to propose' }, { status: 400 });
      }
      const projectPath = intelligenceData.resolveProjectRootPath(project);
      if (!projectPath) {
        return NextResponse.json(
          { error: 'Parent project has no governed root_path' },
          { status: 400 }
        );
      }
      const skeletonPath = materializeTrackArtifactSkeleton({
        projectRootPath: projectPath,
        proposal,
      });
      const existing = loadMissionSeedRecord(proposal.seed_id);
      const now = new Date().toISOString();
      const seed = existing || {
        seed_id: proposal.seed_id,
        project_id: project.project_id,
        track_id: track.track_id,
        track_name: track.name,
        source_work_id: `track_gate:${track.track_id}:${proposal.artifact_id}`,
        title: proposal.title,
        summary: proposal.summary,
        status: 'ready' as const,
        specialist_id: proposal.specialist_id,
        outcome_id: proposal.artifact_id,
        mission_type_hint: proposal.mission_type_hint,
        locale: project.primary_locale,
        work_loop: proposal.work_loop,
        created_at: now,
        updated_at: now,
        metadata: {
          proposed_from_gate_id: readiness.current_gate_id,
          template_ref: proposal.template_ref,
          skeleton_path: skeletonPath,
        },
      };
      if (!existing) {
        saveMissionSeedRecord(seed);
      }
      enqueueSurfaceNotification({
        surface: 'presence',
        requestId: seed.seed_id,
        title: 'Track seed proposed',
        channel: 'chronos',
        threadTs: seed.seed_id,
        sourceAgentId: 'chronos_gateway',
        text: `${track.name} needs ${proposal.artifact_id}. Mission seed ${seed.seed_id} is ready for review.`,
        status: 'success',
      });
      return NextResponse.json({
        status: 'ok',
        action,
        seed,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'mission_control') {
      const missionId = typeof body?.missionId === 'string' ? body.missionId.toUpperCase() : '';
      const operation = typeof body?.operation === 'string' ? body.operation : '';
      if (!missionId || !operation) {
        return NextResponse.json({ error: 'Missing missionId or operation' }, { status: 400 });
      }
      if (
        ![
          'resume',
          'pause',
          'cancel',
          'refresh_team',
          'prewarm_team',
          'staff_team',
          'finish',
        ].includes(operation)
      ) {
        return NextResponse.json({ error: 'Unsupported mission operation' }, { status: 400 });
      }
      const missionError = intelligenceData.missionScopeError(
        resolvedViewer.context,
        missionId,
        typeof body?.tenant === 'string' ? body.tenant : undefined
      );
      if (missionError) return missionError;

      const event = enqueueMissionOrchestrationEvent({
        eventType: 'mission_control_requested',
        missionId,
        requestedBy: 'chronos_localadmin',
        payload: {
          operation,
          requested_by_surface: 'chronos',
        },
      });
      startMissionOrchestrationWorker(event);

      return NextResponse.json({
        status: 'queued',
        action,
        missionId,
        operation,
        eventId: event.event_id,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'intervention_respond') {
      const missionId = typeof body?.missionId === 'string' ? body.missionId.toUpperCase() : '';
      const response = typeof body?.response === 'string' ? body.response.trim() : '';
      const question = typeof body?.question === 'string' ? body.question.trim() : '';
      if (!missionId || !response) {
        return NextResponse.json({ error: 'Missing missionId or response' }, { status: 400 });
      }
      const missionError = intelligenceData.missionScopeError(
        resolvedViewer.context,
        missionId,
        typeof body?.tenant === 'string' ? body.tenant : undefined
      );
      if (missionError) return missionError;
      emitMissionOrchestrationObservation({
        decision: 'mission_intervention_response_recorded',
        event_type: 'mission_intervention_response_recorded',
        requested_by: 'chronos_localadmin',
        mission_id: missionId,
        why: question
          ? `Intervention response recorded for blocking question: ${question}`
          : 'Intervention response recorded from the control surface.',
        response,
      });
      return NextResponse.json({
        status: 'ok',
        action,
        missionId,
        response,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'surface_control') {
      const surfaceId = typeof body?.surfaceId === 'string' ? body.surfaceId : '';
      const operation = typeof body?.operation === 'string' ? body.operation : '';
      if (!operation) {
        return NextResponse.json({ error: 'Missing surface operation' }, { status: 400 });
      }

      if (!(
        operation === 'reconcile' ||
        operation === 'status' ||
        ((operation === 'start' || operation === 'stop') && surfaceId)
      )) {
        return NextResponse.json({ error: 'Unsupported surface operation' }, { status: 400 });
      }
      const event = enqueueMissionOrchestrationEvent({
        eventType: 'surface_control_requested',
        missionId: 'MSN-CHRONOS-SURFACE-CONTROL',
        requestedBy: 'chronos_localadmin',
        payload: {
          operation,
          surfaceId: surfaceId || undefined,
          requested_by_surface: 'chronos',
        },
      });
      startMissionOrchestrationWorker(event);

      return NextResponse.json({
        status: 'queued',
        action,
        surfaceId,
        operation,
        eventId: event.event_id,
        ts: new Date().toISOString(),
      });
    }

    if (action === 'clear_surface_outbox') {
      const surface =
        body?.surface === 'chronos' ? 'chronos' : body?.surface === 'slack' ? 'slack' : '';
      const messageId = typeof body?.messageId === 'string' ? body.messageId : '';
      if (!surface || !messageId) {
        return NextResponse.json({ error: 'Missing surface or messageId' }, { status: 400 });
      }
      const message = listSurfaceOutboxMessages(surface, { includeTenantNamespaces: true }).find(
        (entry) => entry.message_id === messageId
      );
      const allowedTenants = strictViewerScopeTenantSlugs(
        resolvedViewer.context,
        typeof body?.tenant === 'string' ? body.tenant : undefined
      );
      const allowedTiers = resolvedViewer.context.tierAccess ?? ['public', 'confidential'];
      if (
        !message ||
        !intelligenceData.surfaceOutboxVisibleToTenant(message, allowedTenants, allowedTiers)
      ) {
        return NextResponse.json(
          { error: 'Surface outbox message is outside the viewer tenant scope' },
          { status: 403 }
        );
      }
      clearSurfaceOutboxMessage(surface, messageId, message.scope);
      emitMissionOrchestrationObservation({
        decision: 'surface_outbox_cleared',
        event_type: 'surface_outbox_cleared',
        requested_by: 'chronos_localadmin',
        resource_id: messageId,
        surface,
        why: 'Chronos operator cleared a surface outbox message.',
      });
      emitChannelSurfaceEvent('chronos_gateway', surface, 'outbox', {
        correlation_id: message?.correlation_id || messageId,
        decision: 'surface_outbox_cleared',
        why: 'Chronos operator cleared a surface outbox message from the shared outbox contract.',
        policy_used: 'mission_orchestration_control_plane_v1',
        mission_id:
          typeof message?.correlation_id === 'string' && message.correlation_id.startsWith('MSN-')
            ? message.correlation_id
            : undefined,
        resource_id: messageId,
        surface,
        thread: message?.thread_ts,
        channel: message?.channel,
      });
      return NextResponse.json({
        status: 'ok',
        action,
        surface,
        messageId,
        ts: new Date().toISOString(),
      });
    }

    const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
    if (!agentId) {
      return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
    }
    const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === agentId);
    if (!lease) {
      return NextResponse.json({ error: 'Runtime lease not found' }, { status: 404 });
    }
    const leaseMissionId =
      lease.owner_type === 'mission'
        ? lease.owner_id
        : typeof lease.metadata?.mission_id === 'string'
          ? lease.metadata.mission_id
          : undefined;
    const leaseError = intelligenceData.missionScopeError(
      resolvedViewer.context,
      leaseMissionId || '',
      typeof body?.tenant === 'string' ? body.tenant : undefined
    );
    if (leaseError) return leaseError;

    if (action === 'cleanup_runtime_lease') {
      await stopAgentRuntime(agentId, 'chronos_localadmin');
    } else {
      await restartAgentRuntime(agentId, 'chronos_localadmin');
    }
    emitMissionOrchestrationObservation({
      decision: 'runtime_lease_remediation_applied',
      event_type: 'runtime_lease_remediation_applied',
      requested_by: 'chronos_localadmin',
      resource_id: agentId,
      action,
      why: 'Chronos operator applied runtime lease remediation from the doctor view.',
    });
    intelligenceControlData.recordRuntimeRemediationArtifacts({ action, agentId, lease });
    return NextResponse.json({
      status: 'ok',
      action,
      agentId,
      ts: new Date().toISOString(),
    });
  } catch (err: any) {
    return viewerErrorResponse(err, err instanceof ViewerContextError ? err.status : 500);
  }
}
