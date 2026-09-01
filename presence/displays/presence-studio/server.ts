import { appendJsonLine, loadJson } from '@agent/core/foundation';
import { t as catalogT } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import {
  applyBrowserOnboarding,
  getBrowserOnboardingState,
  previewBrowserOnboarding,
} from '@agent/core/browser-onboarding';
import {
  createBrowserConversationSession,
  listBrowserConversationSessions,
  saveBrowserConversationSession,
} from '@agent/core/browser-conversation-session';
import { decideApprovalRequest, listApprovalRequests } from '@agent/core/approval-store';
import { listArtifactRecords } from '@agent/core/artifact-record';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { listAgentRuntimeSnapshots } from '@agent/core/agent-runtime-supervisor';
import {
  getSurfaceAgentCatalogEntry,
  listSurfaceAgentCatalog,
} from '@agent/core/surface-agent-catalog';
import {
  listSurfaceAsyncRequestsAcrossChannels,
  listSurfaceNotificationsAcrossChannels,
} from '@agent/core/surface-ux';
import { resolveWorkDesign } from '@agent/core/work-design';
import { loadStandardIntentCatalog } from '@agent/core/intent-resolution';
import { buildTrackGateReadinessSummaries } from '@agent/core/sdlc-gate-readiness';
import { listProjectRecords } from '@agent/core/project-registry';
import { listManagedProjects } from '@agent/core/project-management';
import { listProjectTrackRecords } from '@agent/core/project-track-registry';
import { listServiceBindingRecords } from '@agent/core/service-binding-registry';
import { listMissionSeedRecords } from '@agent/core/mission-seed-registry';
import { listDistillCandidateRecords } from '@agent/core/distill-candidate-registry';
import { getActiveTaskSession, listTaskSessions } from '@agent/core/task-session';
import { pathResolver } from '@agent/core/path-resolver';
import { probeMicCapture } from '@agent/core/mic-capture';
import {
  getVoiceSelectionSnapshot,
  saveVoiceSelectionPreferences,
} from '@agent/core/voice-selection-preferences';
import { safeMkdir, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  PresenceStudioViewerError,
  presenceStudioApprovalDecisionSchema,
  presenceStudioEmailDeliverSchema,
  presenceStudioEmailDraftSchema,
  presenceStudioLocationSchema,
  presenceStudioDemoFrameSchema,
  presenceStudioVoiceStopSchema,
  presenceStudioBrowserBootstrapSchema,
  summarizePresenceStudioIdentity,
  summarizePresenceStudioState,
  presenceStudioVoiceMinutesSchema,
  presenceStudioVoiceIngestSchema,
  presenceStudioVoiceNativeListenSchema,
  presenceStudioVoiceSelectionSchema,
  presenceStudioVoiceStimulusSchema,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
} from './security.js';
import {
  buildPresenceSurfaceFrame,
  createPresenceVoiceStimulus,
  validatePresenceTimeline,
} from '@agent/core/presence-surface';
import {
  executeEmailDelivery,
  extractFirstJsonBlock,
  generateEmailReplyDraft,
  listEmailAccountProviders,
  readEmailDraftArtifact as readSharedEmailDraftArtifact,
} from '@agent/core/email-workflow';
import * as presenceStudioData from './presence-studio-runtime-data.js';

presenceStudioData.app.get('/api/ui-vocabulary', (req, res) => {
  const locale = normalizeLocale(req.query.locale) ?? 'en';
  const texts = Object.fromEntries(
    presenceStudioData.PRESENCE_STUDIO_VOCABULARY_KEYS.map((key) => [
      key,
      catalogT(key, undefined, locale),
    ])
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, locale, texts });
});

presenceStudioData.app.get('/api/identity', (_req, res) => {
  try {
    const personalDir = pathResolver.knowledge('personal');
    const idPath = path.join(personalDir, 'my-identity.json');
    const agentPath = path.join(personalDir, 'agent-identity.json');
    const visionPath = path.join(personalDir, 'my-vision.md');
    const result = withExecutionContext('ecosystem_architect', () => {
      const safeIdPath = presenceStudioData.resolveSafeExistingFile(idPath);
      const safeAgentPath = presenceStudioData.resolveSafeExistingFile(agentPath);
      const safeVisionPath = presenceStudioData.resolveSafeExistingFile(visionPath);
      const sovereign = safeIdPath ? loadJson<unknown>(safeIdPath) : null;
      const agent = safeAgentPath ? loadJson<unknown>(safeAgentPath) : null;
      const visionRaw = safeVisionPath
        ? (safeReadFile(safeVisionPath, { encoding: 'utf8' }) as string)
        : null;
      const vision = visionRaw
        ? visionRaw
            .replace(/^#[^\n]*\n+/, '')
            .trim()
            .slice(0, 600)
        : null;
      return { sovereign, agent, vision };
    });
    res.json(summarizePresenceStudioIdentity(result));
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

presenceStudioData.app.get('/api/onboarding/browser-state', (_req, res) => {
  try {
    const mic = probeMicCapture();
    res.json({ ...getBrowserOnboardingState(), readiness: { microphone: mic } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

presenceStudioData.app.post('/api/onboarding/preview', (req, res) => {
  try {
    res.json(previewBrowserOnboarding(req.body));
  } catch (error: any) {
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.post('/api/onboarding/apply', async (req, res) => {
  try {
    const result = await applyBrowserOnboarding(req.body);
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'onboarding/apply.complete', {
        artifacts: result.artifacts.length,
        status: 200,
      })
    );
    res.json(result);
  } catch (error: any) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'onboarding/apply.reject', {
        status: 400,
        error: error?.message || String(error),
      })
    );
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    surfaces: Object.keys(presenceStudioData.state.surfaces).length,
    recentStimuli: presenceStudioData.state.recentStimuli.length,
    timestamp: new Date().toISOString(),
  });
});

presenceStudioData.app.get('/api/state', (_req, res) => {
  res.json(summarizePresenceStudioState(presenceStudioData.state));
});

presenceStudioData.app.get('/api/email-triage', (_req, res) => {
  res.json(presenceStudioData.readEmailTriageArtifact());
});

presenceStudioData.app.get('/api/email-draft', (_req, res) => {
  res.json(readSharedEmailDraftArtifact());
});

presenceStudioData.app.get('/api/email-auth-status', (_req, res) => {
  res.json({ accounts: listEmailAccountProviders() });
});

presenceStudioData.app.get('/api/surface-agents', (_req, res) => {
  const currentAgentId =
    typeof presenceStudioData.state.surfaces['presence-studio']?.data?.agentId === 'string'
      ? (presenceStudioData.state.surfaces['presence-studio']?.data?.agentId as string)
      : 'presence-surface-agent';
  const currentRuntime = listAgentRuntimeSnapshots().find(
    (entry) => entry.agent.agentId === currentAgentId
  );
  const providerResolution =
    currentRuntime?.agent?.metadata && typeof currentRuntime.agent.metadata === 'object'
      ? (currentRuntime.agent.metadata.provider_resolution as Record<string, unknown> | undefined)
      : undefined;
  const currentCatalogEntry = getSurfaceAgentCatalogEntry(currentAgentId);
  res.json({
    ok: true,
    currentAgentId,
    current: currentCatalogEntry
      ? {
          ...currentCatalogEntry,
          resolvedProvider: currentRuntime?.agent?.provider,
          resolvedModelId: currentRuntime?.agent?.modelId,
          providerResolution: providerResolution
            ? {
                preferredProvider:
                  typeof providerResolution.preferredProvider === 'string'
                    ? providerResolution.preferredProvider
                    : undefined,
                preferredModelId:
                  typeof providerResolution.preferredModelId === 'string'
                    ? providerResolution.preferredModelId
                    : undefined,
                strategy:
                  typeof providerResolution.strategy === 'string'
                    ? providerResolution.strategy
                    : undefined,
              }
            : undefined,
        }
      : null,
    agents: listSurfaceAgentCatalog(),
  });
});

presenceStudioData.app.get('/api/standard-intents', (_req, res) => {
  try {
    const items = loadStandardIntentCatalog()
      .filter((intent) => intent?.category === 'surface')
      .map((intent) => {
        const design = resolveWorkDesign({
          intentId: intent.id,
          shape: typeof intent.resolution?.shape === 'string' ? intent.resolution.shape : undefined,
          outcomeIds: Array.isArray(intent.outcome_ids) ? intent.outcome_ids : [],
        });
        return {
          id: intent.id || 'unknown',
          description: intent.description || '',
          examples: Array.isArray(intent.surface_examples) ? intent.surface_examples : [],
          planOutline: Array.isArray(intent.plan_outline) ? intent.plan_outline : [],
          shape: typeof intent.resolution?.shape === 'string' ? intent.resolution.shape : undefined,
          resultShape:
            typeof intent.resolution?.result_shape === 'string'
              ? intent.resolution.result_shape
              : undefined,
          primary_specialist: design.primary_specialist,
          conversation_agent: design.conversation_agent,
          team_roles: design.team_roles,
          outcomes: design.outcomes,
          reusable_refs: design.reusable_refs,
        };
      });
    res.json({ ok: true, items });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.get('/api/projects', (_req, res) => {
  res.json({
    ok: true,
    items: listProjectRecords(),
  });
});

presenceStudioData.app.get('/api/project-management', (_req, res) => {
  try {
    res.json({
      ok: true,
      items: listManagedProjects().map((view) => ({
        project: view.project,
        lineage: view.lineage,
        operational_states: view.operational_states.map((state) => ({
          project_id: state.project_id,
          tier: state.tier,
          tenant_slug: state.tenant_slug,
          status: state.status,
          active_track_ids: state.active_track_ids || [],
          active_mission_ids: state.active_mission_ids || [],
          active_task_session_ids: state.active_task_session_ids || [],
          updated_at: state.updated_at,
        })),
      })),
    });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.get('/api/project-tracks', (_req, res) => {
  const tracks = listProjectTrackRecords();
  const gateReadiness = buildTrackGateReadinessSummaries({
    tracks,
    artifacts: listArtifactRecords(),
  });
  const gateReadinessMap = new Map(gateReadiness.map((item) => [item.track_id, item]));
  res.json({
    ok: true,
    items: tracks.map((track) => ({
      ...track,
      gate_readiness: gateReadinessMap.get(track.track_id),
    })),
  });
});

presenceStudioData.app.get('/api/service-bindings', (_req, res) => {
  res.json({
    ok: true,
    items: listServiceBindingRecords(),
  });
});

presenceStudioData.app.get('/api/mission-seeds', (_req, res) => {
  res.json({
    ok: true,
    items: listMissionSeedRecords(),
  });
});

presenceStudioData.app.get('/api/distill-candidates', (_req, res) => {
  res.json({
    ok: true,
    items: listDistillCandidateRecords(),
  });
});

presenceStudioData.app.get('/api/async-requests', (_req, res) => {
  res.json({
    ok: true,
    items: listSurfaceAsyncRequestsAcrossChannels().slice(0, 20),
  });
});

presenceStudioData.app.get('/api/notifications', (_req, res) => {
  res.json({
    ok: true,
    items: listSurfaceNotificationsAcrossChannels().slice(0, 20),
  });
});

presenceStudioData.app.get('/api/surface-launcher', async (_req, res) => {
  try {
    res.json(await presenceStudioData.loadSurfaceLauncherPayload());
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.get('/api/os/control-plane', (req, res) => {
  try {
    const access = resolvePresenceStudioViewerContext(req);
    const rawMissionId = req.query.mission_id;
    if (Array.isArray(rawMissionId)) {
      return res.status(400).json({ ok: false, error: 'mission_id must be a single value' });
    }
    const snapshot = presenceStudioData.cloudflareOsSurface.snapshot(
      typeof rawMissionId === 'string' ? rawMissionId : undefined,
      access
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ ok: true, ...snapshot });
  } catch (error: unknown) {
    const status = error instanceof PresenceStudioViewerError ? error.status : 400;
    const message =
      error instanceof PresenceStudioViewerError
        ? error.message
        : error instanceof Error && error.message.startsWith('[POLICY_VIOLATION]')
          ? error.message
          : 'Unable to load the OS control-plane projection.';
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'os/control-plane.reject', {
        status,
        error: message,
      })
    );
    return res.status(status).json({ ok: false, error: message });
  }
});

presenceStudioData.app.post('/api/os/held-actions/:actionId/decision', (req, res) => {
  const actionId = String(req.params.actionId || '').trim();
  const parsed = presenceStudioApprovalDecisionSchema.safeParse(req.body);
  if (!actionId || !parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'actionId and decision (approved|rejected) are required',
    });
  }
  const { decision } = parsed.data;
  try {
    const access = resolvePresenceStudioViewerContext(req);
    requirePresenceStudioLocalAdmin(access);
    const item = presenceStudioData.cloudflareOsSurface.decideHeldAction(
      actionId,
      decision,
      access
    );
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'os/held-action.decision', {
        action_id: actionId,
        decision,
        status: 200,
      })
    );
    return res.json({ ok: true, item });
  } catch (error: unknown) {
    const status = error instanceof PresenceStudioViewerError ? error.status : 409;
    const message =
      error instanceof PresenceStudioViewerError
        ? error.message
        : error instanceof Error && error.message.startsWith('[POLICY_VIOLATION]')
          ? error.message
          : 'Unable to record the held-action decision.';
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'os/held-action.decision.reject', {
        action_id: actionId,
        status,
        error: message,
      })
    );
    return res.status(status).json({ ok: false, error: message });
  }
});

presenceStudioData.app.post('/api/os/held-actions/:actionId/apply', async (req, res) => {
  const actionId = String(req.params.actionId || '').trim();
  if (!actionId) return res.status(400).json({ ok: false, error: 'actionId is required' });
  try {
    const access = resolvePresenceStudioViewerContext(req);
    requirePresenceStudioLocalAdmin(access);
    const item = await presenceStudioData.cloudflareOsSurface.applyHeldAction(actionId, access);
    if (item.status === 'failed') {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'os/held-action.apply.failed', {
          action_id: actionId,
          status: 502,
        })
      );
      return res.status(502).json({
        ok: false,
        error: 'Held action application failed; inspect the audit record.',
        item,
      });
    }
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'os/held-action.apply', {
        action_id: actionId,
        status: 200,
      })
    );
    return res.json({ ok: true, item });
  } catch (error: unknown) {
    const status = error instanceof PresenceStudioViewerError ? error.status : 409;
    const message =
      error instanceof PresenceStudioViewerError
        ? error.message
        : error instanceof Error && error.message.startsWith('[POLICY_VIOLATION]')
          ? error.message
          : 'Unable to apply the held action.';
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'os/held-action.apply.reject', {
        action_id: actionId,
        status,
        error: message,
      })
    );
    return res.status(status).json({ ok: false, error: message });
  }
});

presenceStudioData.app.get('/api/approvals', (_req, res) => {
  res.json({
    ok: true,
    items: listApprovalRequests({ status: 'pending' })
      .slice(0, 10)
      .map(presenceStudioData.buildApprovalInboxItem),
  });
});

presenceStudioData.app.post('/api/approvals/:requestId/decision', (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const parsed = presenceStudioApprovalDecisionSchema.safeParse(req.body);
  if (!requestId) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
        status: 400,
        error: 'requestId is required',
      })
    );
    return res.status(400).json({ ok: false, error: 'requestId is required' });
  }
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
        request_id: requestId,
        status: 400,
        error: 'decision must be approved or rejected',
      })
    );
    return res.status(400).json({ ok: false, error: 'decision must be approved or rejected' });
  }
  const { decision } = parsed.data;

  const record = listApprovalRequests({ status: 'pending' }).find((item) => item.id === requestId);
  if (!record) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
        request_id: requestId,
        status: 404,
        error: 'approval request not found',
      })
    );
    return res.status(404).json({ ok: false, error: `approval request not found: ${requestId}` });
  }

  try {
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.accept', {
        request_id: requestId,
        decision,
        channel: record.channel || 'unknown',
        status: 202,
      })
    );
    const updated = decideApprovalRequest('surface_runtime', {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId,
      decision,
      decidedBy: 'presence-studio',
      decidedByRole: 'sovereign',
      authMethod: 'surface_session',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.accountability?.payloadHash,
      effectBinding: record.accountability?.effectBinding,
      note: 'Decision captured from Presence Studio approval inbox.',
    });
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.complete', {
        request_id: requestId,
        decision,
        status: 200,
      })
    );
    return res.json({ ok: true, item: updated });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.get('/api/outcomes', (_req, res) => {
  const items = listArtifactRecords()
    .slice(-10)
    .reverse()
    .map(presenceStudioData.buildOutcomeInboxItem);
  res.json({ ok: true, items });
});

presenceStudioData.app.get('/api/knowledge-ref', (req, res) => {
  const logicalPath = String(req.query.path || '').trim();
  if (!logicalPath) {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (!presenceStudioData.isAllowedKnowledgeRefPath(logicalPath)) {
    return res
      .status(403)
      .json({ ok: false, error: `knowledge ref is not accessible: ${logicalPath}` });
  }
  const resolved = presenceStudioData.resolveSafeExistingFile(pathResolver.resolve(logicalPath));
  if (!resolved) {
    return res.status(404).json({ ok: false, error: `knowledge ref not found: ${logicalPath}` });
  }
  if (logicalPath.endsWith('.json')) {
    res.type('application/json');
  } else {
    res.type('text/markdown; charset=utf-8');
  }
  return res.send(safeReadFile(resolved, { encoding: 'utf8' }));
});

presenceStudioData.app.get('/api/runtime-ref', (req, res) => {
  const logicalPath = String(req.query.path || '').trim();
  if (!logicalPath) {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (!presenceStudioData.isAllowedRuntimeRefPath(logicalPath)) {
    return res
      .status(403)
      .json({ ok: false, error: `runtime ref is not accessible: ${logicalPath}` });
  }
  const resolved = presenceStudioData.resolveSafeExistingFile(pathResolver.resolve(logicalPath));
  if (!resolved) {
    return res.status(404).json({ ok: false, error: `runtime ref not found: ${logicalPath}` });
  }
  res.type(logicalPath.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8');
  return res.send(safeReadFile(resolved, { encoding: 'utf8' }));
});

presenceStudioData.app.get('/api/artifacts/:artifactId', (req, res) => {
  const artifactId = String(req.params.artifactId || '').trim();
  const artifact = listArtifactRecords().find((item) => item.artifact_id === artifactId) as
    presenceStudioData.ArtifactRecordShape | undefined;
  if (!artifact) {
    return res.status(404).json({ ok: false, error: `artifact not found: ${artifactId}` });
  }
  const artifactPath = typeof artifact.path === 'string' ? artifact.path : '';
  const safeArtifactPath =
    artifactPath && presenceStudioData.isAllowedArtifactDownloadPath(artifactPath)
      ? presenceStudioData.resolveSafeExistingFile(artifactPath)
      : null;
  if (!artifactPath || !safeArtifactPath) {
    return res
      .status(403)
      .json({ ok: false, error: `artifact path is not accessible: ${artifactId}` });
  }
  return res.download(safeArtifactPath, path.basename(safeArtifactPath));
});

presenceStudioData.app.get('/api/browser-conversation-sessions', (_req, res) => {
  const active = presenceStudioData.ensurePresenceBrowserConversationSession();
  res.json({
    ok: true,
    active,
    items: listBrowserConversationSessions().filter((session) => session.surface === 'presence'),
  });
});

presenceStudioData.app.get('/api/browser-sessions', (_req, res) => {
  const items = presenceStudioData.listBrowserRuntimeSessions();
  res.json({ ok: true, items });
});

presenceStudioData.app.get('/api/task-sessions', (_req, res) => {
  res.json({
    ok: true,
    active: getActiveTaskSession('presence'),
    items: listTaskSessions('presence').slice(0, 10),
  });
});

presenceStudioData.app.get('/api/task-sessions/:sessionId', (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const session = presenceStudioData.findTaskSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: `task session not found: ${sessionId}` });
  }
  return res.json({ ok: true, item: session });
});

presenceStudioData.app.get('/api/task-sessions/:sessionId/artifact', (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const session = presenceStudioData.findTaskSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: `task session not found: ${sessionId}` });
  }
  const artifact = (session.artifact || {}) as presenceStudioData.TaskSessionArtifactShape;
  const outputPath = typeof artifact.output_path === 'string' ? artifact.output_path : '';
  if (!outputPath) {
    return res
      .status(404)
      .json({ ok: false, error: `artifact not found for task session: ${sessionId}` });
  }
  const safeOutputPath = presenceStudioData.isAllowedTaskArtifactPath(outputPath)
    ? presenceStudioData.resolveSafeExistingFile(outputPath)
    : null;
  if (!safeOutputPath) {
    return res
      .status(403)
      .json({ ok: false, error: `artifact path is not accessible: ${sessionId}` });
  }
  return res.download(safeOutputPath, path.basename(safeOutputPath));
});

presenceStudioData.app.post('/api/browser-conversation-sessions/bootstrap', (req, res) => {
  const parsed = presenceStudioBrowserBootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'browser-bootstrap.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  const browserSessionId = parsed.data.browser_session_id;
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'browser-bootstrap.accept', {
      browser_session_id: browserSessionId,
      goal_summary_len: parsed.data.goal_summary?.length || 0,
      success_condition_len: parsed.data.success_condition?.length || 0,
    })
  );

  try {
    const browserSession = presenceStudioData
      .listBrowserRuntimeSessions()
      .find((item) => item.session_id === browserSessionId);
    if (!browserSession) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'browser-bootstrap.reject', {
          browser_session_id: browserSessionId,
          status: 404,
          error: 'browser session not found',
        })
      );
      return res
        .status(404)
        .json({ ok: false, error: `browser session not found: ${browserSessionId}` });
    }
    const activeTab =
      (browserSession.tabs || []).find(
        (tab) => tab.active && tab.url && tab.url !== 'about:blank'
      ) ||
      browserSession.tabs?.find(
        (tab) => tab.tab_id === browserSession.active_tab_id && tab.url && tab.url !== 'about:blank'
      ) ||
      browserSession.tabs?.find((tab) => tab.url && tab.url !== 'about:blank') ||
      browserSession.tabs?.[0];
    const session = createBrowserConversationSession({
      sessionId: `BCS-presence-${browserSessionId}`,
      surface: 'presence',
      goal: {
        summary:
          typeof req.body?.goal_summary === 'string'
            ? req.body.goal_summary
            : activeTab?.title || browserSessionId,
        success_condition:
          typeof req.body?.success_condition === 'string'
            ? req.body.success_condition
            : 'Complete the requested browser step safely.',
      },
      target: {
        app: 'browser',
        window_title: activeTab?.title,
        url: activeTab?.url,
        tab_id: activeTab?.tab_id || browserSession.active_tab_id,
        browser_session_id: browserSessionId,
      },
    });
    saveBrowserConversationSession(session);
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'browser-bootstrap.complete', {
        browser_session_id: browserSessionId,
        session_id: session.session_id,
        status: 200,
      })
    );
    return res.json({ ok: true, session });
  } catch (error: any) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'browser-bootstrap.fail', {
        browser_session_id: browserSessionId,
        status: 500,
        error: error?.message || String(error),
      })
    );
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  presenceStudioData.sseClients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(presenceStudioData.state)}\n\n`);
  res.write(
    `event: speech_state\ndata: ${JSON.stringify({ ok: true, speech: { status: presenceStudioData.latestSpeechSseState } })}\n\n`
  );
  req.on('close', () => {
    presenceStudioData.sseClients.delete(res);
  });
});

presenceStudioData.app.post('/a2ui/dispatch', (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'a2ui/dispatch.accept', {
      messages: messages.length,
      body_kind: Array.isArray(body) ? 'array' : typeof body,
    })
  );
  try {
    for (const message of messages) {
      presenceStudioData.applyA2UIMessage(presenceStudioData.validateA2UIMessage(message));
    }
  } catch (error) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'a2ui/dispatch.reject', {
        messages: messages.length,
        status: 400,
        error: presenceStudioData.safeErrorMessage(error),
      })
    );
    return res.status(400).json({
      ok: false,
      error: presenceStudioData.safeErrorMessage(error) || 'Invalid A2UI message.',
    });
  }
  presenceStudioData.emitState();
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'a2ui/dispatch.complete', {
      messages: messages.length,
      status: 200,
    })
  );
  res.json({ ok: true, applied: messages.length });
});

presenceStudioData.app.post('/api/voice/stimuli', (req, res) => {
  const parsed = presenceStudioVoiceStimulusSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/stimuli.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }

  const requestId = parsed.data.request_id || randomUUID();
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/stimuli.accept', {
      request_id: requestId,
      text_len: parsed.data.text.length,
      intent: parsed.data.intent || 'conversation',
      source_id: parsed.data.source_id || 'presence-studio',
    })
  );

  const stimulus = createPresenceVoiceStimulus(
    parsed.data.text,
    parsed.data.intent || 'conversation',
    parsed.data.source_id || 'presence-studio',
    requestId
  );
  appendJsonLine(presenceStudioData.STIMULI_PATH, stimulus);
  presenceStudioData.rememberStimulus(stimulus as unknown as Record<string, unknown>);
  presenceStudioData.emitState();
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/stimuli.complete', {
      request_id: requestId,
      status: 201,
    })
  );
  return res.status(201).json({ ok: true, request_id: requestId, stimulus });
});

presenceStudioData.app.post('/api/voice/ingest', async (req, res) => {
  const parsed = presenceStudioVoiceIngestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/ingest.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }

  const requestId = parsed.data.request_id || randomUUID();
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/ingest.accept', {
      request_id: requestId,
      text_len: parsed.data.text.length,
      intent: parsed.data.intent || 'conversation',
      source_id: parsed.data.source_id || 'browser-mic',
    })
  );

  const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/ingest-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      text: parsed.data.text,
      intent: parsed.data.intent || 'conversation',
      source_id: parsed.data.source_id || 'browser-mic',
      speaker: parsed.data.speaker || 'User',
      reflect_to_surface:
        parsed.data.reflect_to_surface === undefined
          ? true
          : presenceStudioData.toBoolean(parsed.data.reflect_to_surface),
      auto_reply:
        parsed.data.auto_reply === undefined
          ? true
          : presenceStudioData.toBoolean(parsed.data.auto_reply),
    }),
  });

  const payload = await response.text();
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/ingest.complete', {
      request_id: requestId,
      status: response.status,
    })
  );
  res.status(response.status).type('application/json').send(payload);
});

presenceStudioData.app.post('/api/voice/minutes', async (req, res) => {
  const parsed = presenceStudioVoiceMinutesSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/minutes.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }

  const sourceText = parsed.data.text;
  const requestId = parsed.data.request_id || randomUUID();
  const missionId = parsed.data.mission_id || undefined;
  const title = parsed.data.title || 'Voice Notes Minutes';
  const language = parsed.data.language || 'ja';
  const attendees = presenceStudioData.toLineItems(parsed.data.attendees);
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/minutes.accept', {
      request_id: requestId,
      mission_id: missionId || 'none',
      text_len: sourceText.length,
      attendees: attendees.length,
      language,
    })
  );
  const outputDir = presenceStudioData.resolveVoiceMinutesDir(missionId);
  safeMkdir(outputDir, { recursive: true });

  const sourcePath = path.join(outputDir, `voice-notes-${requestId}.txt`);
  safeWriteFile(sourcePath, `${sourceText}\n`, { encoding: 'utf8' });

  const backend = getReasoningBackend();
  const prompt = [
    `You are converting dictated notes into meeting minutes in ${language}.`,
    'Output ONLY a JSON object with keys: title, summary, decisions, action_items, open_questions, minutes_markdown.',
    'Keep the content concise, factual, and useful for follow-up.',
    'Do not invent facts that are not in the source notes.',
    `Title: ${title}`,
    attendees.length ? `Attendees: ${attendees.join(', ')}` : 'Attendees: not provided',
    'Source notes:',
    sourceText,
  ].join('\n');

  let backendName = 'unknown';
  let artifact: presenceStudioData.VoiceMinutesArtifact | null = null;
  try {
    const raw = await backend.delegateTask(prompt, `voice-minutes:${requestId}`);
    backendName = (backend as any)?.name || backendName;
    const parsed = extractFirstJsonBlock(raw);
    if (parsed) {
      artifact = {
        title:
          typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : title,
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
        decisions: presenceStudioData.toLineItems(parsed.decisions),
        action_items: presenceStudioData.toLineItems(parsed.action_items),
        open_questions: presenceStudioData.toLineItems(parsed.open_questions),
        minutes_markdown:
          typeof parsed.minutes_markdown === 'string' ? parsed.minutes_markdown.trim() : '',
      };
    }
  } catch (error: any) {
    logger.warn(
      `[presence-studio] voice minutes generation failed: ${error?.message || String(error)}`
    );
  }

  const minutes = artifact || {
    title,
    summary: sourceText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' '),
    decisions: [],
    action_items: [],
    open_questions: [],
    minutes_markdown: '',
  };
  const markdown =
    minutes.minutes_markdown.trim() ||
    presenceStudioData.buildFallbackMinutesMarkdown({
      title: minutes.title,
      summary: minutes.summary,
      decisions: minutes.decisions,
      actionItems: minutes.action_items,
      openQuestions: minutes.open_questions,
      sourceText,
    });

  const minutesPath = path.join(outputDir, `voice-minutes-${requestId}.md`);
  const jsonPath = path.join(outputDir, `voice-minutes-${requestId}.json`);
  safeWriteFile(minutesPath, markdown, { encoding: 'utf8' });
  safeWriteFile(
    jsonPath,
    JSON.stringify(
      {
        request_id: requestId,
        mission_id: missionId,
        backend: backendName,
        title: minutes.title,
        summary: minutes.summary,
        decisions: minutes.decisions,
        action_items: minutes.action_items,
        open_questions: minutes.open_questions,
        source_path: sourcePath,
        minutes_path: minutesPath,
        generated_at: new Date().toISOString(),
      },
      null,
      2
    ),
    { encoding: 'utf8' }
  );
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/minutes.complete', {
      request_id: requestId,
      mission_id: missionId || 'none',
      status: 201,
    })
  );

  return res.status(201).json({
    ok: true,
    request_id: requestId,
    backend: backendName,
    title: minutes.title,
    summary: minutes.summary,
    source_path: sourcePath,
    minutes_path: minutesPath,
    json_path: jsonPath,
    minutes_markdown: markdown,
  });
});

presenceStudioData.app.post('/api/email-draft', async (req, res) => {
  const parsed = presenceStudioEmailDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'email-draft.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }

  const requestId = parsed.data.request_id || randomUUID();
  const recipient = parsed.data.to || '';
  const subjectInput = parsed.data.subject || '';
  const tone = parsed.data.tone || 'clear and concise';
  const triageInput = parsed.data.triage_text || '';
  const triageText = triageInput || presenceStudioData.readEmailTriageArtifact().content.trim();
  if (!triageText) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'email-draft.reject', {
        request_id: requestId,
        status: 400,
        error: 'triage_text is required when no email triage file exists',
      })
    );
    return res
      .status(400)
      .json({ error: 'triage_text is required when no email triage file exists' });
  }
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'email-draft.accept', {
      request_id: requestId,
      to_present: recipient ? 'yes' : 'no',
      subject_len: subjectInput.length,
      tone,
      triage_len: triageText.length,
    })
  );
  try {
    const draft = await generateEmailReplyDraft({
      requestId,
      recipient,
      subjectInput,
      tone,
      triageText,
    });
    return res.status(201).json({
      ok: true,
      request_id: draft.request_id,
      backend: draft.backend,
      to: draft.to,
      subject: draft.subject,
      tone: draft.tone,
      body_markdown: draft.body_markdown,
      draft_markdown: draft.draft_markdown,
      draft_path: draft.draft_path,
      json_path: draft.json_path,
      triage_path: draft.triage_path,
    });
  } catch (error: any) {
    logger.warn(
      `[presence-studio] email draft generation failed: ${error?.message || String(error)}`
    );
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'email-draft.fail', {
        request_id: requestId,
        status: 500,
        error: error?.message || String(error),
      })
    );
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

presenceStudioData.app.post('/api/email-deliver', async (req, res) => {
  const parsed = presenceStudioEmailDeliverSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'email-deliver.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  const approved = presenceStudioData.toBoolean(parsed.data.approved);
  const body_markdown = parsed.data.body_markdown;
  const reply_mode = parsed.data.reply_mode || 'new';
  const draft_mode = presenceStudioData.toBoolean(parsed.data.draft_mode);
  const subject = parsed.data.subject || '';
  const to = parsed.data.to || '';
  const message_id = parsed.data.message_id || '';
  const account = parsed.data.account || 'auto';
  if (!draft_mode && !approved) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'email-deliver.reject', {
        status: 400,
        error: 'approval is required before sending an email',
        draft_mode,
      })
    );
    return res.status(400).json({ error: 'approval is required before sending an email' });
  }
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'email-deliver.accept', {
      status: 202,
      draft_mode,
      reply_mode,
      approved,
      to_present: to ? 'yes' : 'no',
      subject_len: subject.length,
      message_id_present: message_id ? 'yes' : 'no',
      account,
    })
  );

  try {
    const result = await executeEmailDelivery({
      approved,
      draft_mode,
      reply_mode,
      body_markdown,
      subject,
      to,
      message_id: message_id || undefined,
      account,
    });
    return res.status(201).json({
      ok: true,
      mode: draft_mode ? 'draft' : 'send',
      reply_mode,
      result,
    });
  } catch (error: any) {
    logger.warn(`[presence-studio] email delivery failed: ${error?.message || String(error)}`);
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'email-deliver.fail', {
        status: 500,
        error: error?.message || String(error),
      })
    );
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

presenceStudioData.app.post('/api/voice/native-listen', async (req, res) => {
  const parsed = presenceStudioVoiceNativeListenSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/native-listen.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  const requestId = parsed.data.request_id || randomUUID();
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'voice/native-listen.accept', {
      request_id: requestId,
      locale: parsed.data.locale || 'ja-JP',
      backend: parsed.data.backend || 'default',
      timeout_seconds: parsed.data.timeout_seconds || 8,
    })
  );

  try {
    const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/listen-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: requestId,
        locale: parsed.data.locale || 'ja-JP',
        device_id: parsed.data.device_id,
        backend: parsed.data.backend,
        timeout_seconds: parsed.data.timeout_seconds || 8,
        intent: parsed.data.intent || 'conversation',
        speaker: parsed.data.speaker || 'User',
        reflect_to_surface:
          parsed.data.reflect_to_surface === undefined
            ? true
            : presenceStudioData.toBoolean(parsed.data.reflect_to_surface),
        auto_reply:
          parsed.data.auto_reply === undefined
            ? true
            : presenceStudioData.toBoolean(parsed.data.auto_reply),
      }),
    });

    const contentType = response.headers.get('content-type') || '';
    const payload = await response.text();
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/native-listen.complete', {
        request_id: requestId,
        status: response.status,
      })
    );

    if (!contentType.includes('application/json')) {
      return res
        .status(502)
        .json({ ok: false, error: `Invalid content-type from voice-hub: ${contentType}` });
    }
    res.status(response.status).type('application/json').send(payload);
  } catch (error: any) {
    logger.error(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/native-listen.error', {
        request_id: requestId,
        error: error?.message || String(error),
      })
    );
    res.status(503).json({
      ok: false,
      error: `Voice hub connection failed: ${error?.message || String(error)}`,
    });
  }
});

presenceStudioData.app.get('/api/voice/selection', (_req, res) => {
  try {
    const snapshot = getVoiceSelectionSnapshot();
    // Keep the profile storage location internal; the UI only needs the selectable
    // candidates and effective preferences.
    const { storage_path: _storagePath, ...publicSnapshot } = snapshot;
    res.json({ ok: true, ...publicSnapshot });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

presenceStudioData.app.post('/api/voice/selection', (req, res) => {
  const parsed = presenceStudioVoiceSelectionSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/selection.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  try {
    const snapshot = saveVoiceSelectionPreferences(parsed.data);
    const { storage_path: _storagePath, ...publicSnapshot } = snapshot;
    logger.info(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/selection.complete', {
        status: 200,
        tts_engine_id: publicSnapshot.preferences.tts_engine_id,
        stt_backend: publicSnapshot.preferences.stt_backend,
      })
    );
    return res.json({ ok: true, ...publicSnapshot });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'voice/selection.reject', {
        status: 400,
        error: message,
      })
    );
    return res.status(400).json({ ok: false, error: message });
  }
});

presenceStudioData.app.get('/api/voice/input-devices', async (req, res) => {
  try {
    const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/input-devices`);
    const contentType = response.headers.get('content-type') || '';
    const payload = await response.text();
    if (!contentType.includes('application/json')) {
      return res
        .status(502)
        .json({ ok: false, error: `Invalid content-type from voice-hub: ${contentType}` });
    }
    res.status(response.status).type('application/json').send(payload);
  } catch (error: any) {
    res.status(503).json({
      ok: false,
      error: `Voice hub connection failed: ${error?.message || String(error)}`,
    });
  }
});

presenceStudioData.app.get('/api/voice/stt-backends', async (req, res) => {
  try {
    const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/stt/backends`);
    const contentType = response.headers.get('content-type') || '';
    const payload = await response.text();
    if (!contentType.includes('application/json')) {
      return res
        .status(502)
        .json({ ok: false, error: `Invalid content-type from voice-hub: ${contentType}` });
    }
    res.status(response.status).type('application/json').send(payload);
  } catch (error: any) {
    res.status(503).json({
      ok: false,
      error: `Voice hub connection failed: ${error?.message || String(error)}`,
    });
  }
});

presenceStudioData.app.get('/api/voice/speech-state', async (req, res) => {
  try {
    const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/speech/state`);
    const contentType = response.headers.get('content-type') || '';
    const payload = await response.text();
    if (!contentType.includes('application/json')) {
      return res
        .status(502)
        .json({ ok: false, error: `Invalid content-type from voice-hub: ${contentType}` });
    }
    res.status(response.status).type('application/json').send(payload);
  } catch (error: any) {
    res.status(503).json({
      ok: false,
      error: `Voice hub connection failed: ${error?.message || String(error)}`,
    });
  }
});

presenceStudioData.app.get('/api/context/location', (_req, res) => {
  res.json({ ok: true, location: presenceStudioData.latestLocationContext });
});

presenceStudioData.app.post('/api/context/location', (req, res) => {
  const parsed = presenceStudioLocationSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioData.presenceStudioAuditLine(req, 'context/location.reject', {
        status: 400,
        error: presenceStudioData.validationErrorMessage(parsed.error),
      })
    );
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  presenceStudioData.setLatestLocationContext({
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    accuracy: parsed.data.accuracy,
    timestamp: parsed.data.timestamp || new Date().toISOString(),
    source: 'browser_geolocation',
  });
  logger.info(
    presenceStudioData.presenceStudioAuditLine(req, 'context/location.accept', {
      status: 200,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      accuracy: parsed.data.accuracy ?? 'none',
    })
  );
  return res.json({ ok: true, location: presenceStudioData.latestLocationContext });
});

presenceStudioData.app.post('/api/voice/stop-speaking', async (req, res) => {
  const parsed = presenceStudioVoiceStopSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  const response = await fetch(`${presenceStudioData.VOICE_HUB_URL}/api/stop-speaking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reason: parsed.data.reason || 'manual_stop',
    }),
  });
  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

presenceStudioData.app.post('/api/demo/frame', (req, res) => {
  const parsed = presenceStudioDemoFrameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ ok: false, error: presenceStudioData.validationErrorMessage(parsed.error) });
  }
  const body = parsed.data;
  const messages = buildPresenceSurfaceFrame({
    surfaceId: body.surfaceId || 'presence-studio',
    agentId: body.agentId || 'presence-surface-agent',
    title: body.title || 'Presence Studio',
    status: body.status || 'speaking',
    expression: body.expression || 'joy',
    subtitle: body.subtitle || 'Hello from Kyberion.',
    transcript: body.transcript || [{ speaker: 'AI', text: 'Hello from Kyberion.' }],
  });
  for (const message of messages) presenceStudioData.applyA2UIMessage(message);
  presenceStudioData.emitState();
  res.json({ ok: true, messages });
});

presenceStudioData.app.post('/api/timeline/dispatch', (req, res) => {
  const timeline = validatePresenceTimeline(req.body);
  const result = presenceStudioData.playTimeline(timeline);
  return res.status(result.accepted ? 202 : 409).json({ ok: result.accepted, ...result });
});

presenceStudioData.app.get('/api/stimuli/tail', (_req, res) => {
  const safeStimuliPath = presenceStudioData.resolveSafeExistingFile(
    presenceStudioData.STIMULI_PATH
  );
  if (!safeStimuliPath) return res.json({ items: [] });
  const content = safeReadFile(safeStimuliPath, { encoding: 'utf8' }) as string;
  const items = presenceStudioData.parseStimuliTailContent(content);
  res.json({ items });
});

presenceStudioData.server.listen(presenceStudioData.PORT, presenceStudioData.HOST, () => {
  logger.info(
    `[presence-studio] listening on http://${presenceStudioData.HOST}:${presenceStudioData.PORT}`
  );
  setTimeout(() => {
    presenceStudioData.ensurePresenceBrowserConversationSession();
  }, 0);
});

setInterval(() => {
  void presenceStudioData.pollVoiceHubSpeechStateForSse();
}, presenceStudioData.SPEECH_STATE_POLL_MS);
