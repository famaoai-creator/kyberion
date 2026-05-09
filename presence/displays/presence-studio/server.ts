import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  buildPresenceSurfaceFrame,
  buildTrackGateReadinessSummaries,
  createBrowserConversationSession,
  createPresenceVoiceStimulus,
  decideApprovalRequest,
  getActiveBrowserConversationSession,
  getActiveTaskSession,
  getPresenceAvatarProfile,
  getSurfaceAgentCatalogEntry,
  listAgentRuntimeSnapshots,
  listApprovalRequests,
  listArtifactRecords,
  listBrowserConversationSessions,
  listDistillCandidateRecords,
  listMissionSeedRecords,
  listProjectRecords,
  listProjectTrackRecords,
  listServiceBindingRecords,
  listTaskSessions,
  listSurfaceAsyncRequests,
  listSurfaceNotifications,
  listSurfaceAgentCatalog,
  logger,
  pathResolver,
  resolveWorkDesign,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  saveBrowserConversationSession,
  type A2UIMessage,
  type PresenceTimelineAdf,
  validatePresenceTimeline,
  withExecutionContext,
} from '@agent/core';

type Client = express.Response;

interface SurfaceSnapshot {
  catalogId?: string;
  title?: string;
  components: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
  data: Record<string, unknown>;
}

function inferProjectIdForApprovalRecord(record: any): string | undefined {
  const projects = listProjectRecords();
  const missionId = record?.requestedByContext?.missionId;
  const serviceId = record?.target?.serviceId;
  if (missionId) {
    const byMission = projects.find((project) => (project.active_missions || []).includes(missionId));
    if (byMission) return byMission.project_id;
  }
  if (serviceId) {
    const byService = projects.find((project) => (project.service_bindings || []).some((bindingId) => bindingId.includes(serviceId)));
    if (byService) return byService.project_id;
  }
  return undefined;
}

function buildApprovalInboxItem(record: any) {
  const projectId = inferProjectIdForApprovalRecord(record);
  const learned = projectId
    ? listDistillCandidateRecords()
        .filter((candidate) => candidate.project_id === projectId && candidate.promoted_ref)
        .slice(0, 2)
        .map((candidate) => candidate.title)
    : [];
  const requestedEffects = Array.isArray(record?.justification?.requestedEffects)
    ? record.justification.requestedEffects.filter(Boolean)
    : [];
  const expectedOutcome = requestedEffects.length
    ? requestedEffects.join(' / ')
    : record?.target?.serviceId
      ? `Proceed with ${record.target.serviceId}`
      : 'Proceed with the requested work';
  return {
    ...record,
    expected_outcome: expectedOutcome,
    learned_titles: learned,
    project_id: projectId,
    work_loop: record?.work_loop,
  };
}

function buildOutcomeInboxItem(item: any) {
  const relatedCandidates = listDistillCandidateRecords()
    .filter((candidate) => (candidate.artifact_ids || []).includes(item.artifact_id))
    .slice(0, 3);
  return {
    ...item,
    downloadable: typeof item.path === 'string' && isAllowedArtifactDownloadPath(item.path) && safeExistsSync(item.path),
    distill_titles: relatedCandidates.map((candidate) => candidate.title),
    promoted_refs: relatedCandidates
      .map((candidate) => candidate.promoted_ref)
      .filter(Boolean),
    work_loop: item?.work_loop,
  };
}

interface PresenceStudioState {
  surfaces: Record<string, SurfaceSnapshot>;
  recentStimuli: Array<Record<string, unknown>>;
  lastUpdatedAt: string | null;
}

interface BrowserRuntimeSessionSummary {
  session_id: string;
  active_tab_id?: string;
  tabs?: Array<{
    tab_id: string;
    url?: string;
    title?: string;
    active?: boolean;
  }>;
  updated_at?: string;
  lease_status?: string;
  retained?: boolean;
}

interface BrowserSnapshotSummary {
  session_id: string;
  tab_id?: string;
  url?: string;
  title?: string;
  element_count?: number;
}

interface PresenceLocationContext {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: string;
  source: 'browser_geolocation';
}

interface TaskSessionArtifactShape {
  output_path?: string;
}

interface ArtifactRecordShape {
  artifact_id: string;
  kind: string;
  path?: string;
}

interface StandardIntentCatalog {
  intents?: Array<{
    id?: string;
    category?: string;
    description?: string;
    surface_examples?: string[];
    plan_outline?: string[];
    outcome_ids?: string[];
    specialist_id?: string;
    resolution?: Record<string, unknown>;
  }>;
}

const app = express();
const server = createServer(app);
const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/presence-studio/static');
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const PORT = Number(process.env.PRESENCE_STUDIO_PORT || 3031);
const HOST = process.env.PRESENCE_STUDIO_HOST || '127.0.0.1';
const VOICE_HUB_URL = process.env.VOICE_HUB_URL || 'http://127.0.0.1:3032';
const sseClients = new Set<Client>();
const activeTimelineTimers = new Map<string, NodeJS.Timeout[]>();
const SPEECH_STATE_POLL_MS = Number(process.env.PRESENCE_STUDIO_SPEECH_STATE_POLL_MS || 400);
let latestSpeechSseState = 'idle';
let speechStatePollInFlight = false;

process.env.MISSION_ROLE ||= 'surface_runtime';

const state: PresenceStudioState = {
  surfaces: {},
  recentStimuli: [],
  lastUpdatedAt: null,
};
let latestLocationContext: PresenceLocationContext | null = null;

function findTaskSession(sessionId: string) {
  return listTaskSessions('presence').find((item) => item.session_id === sessionId) || null;
}

function isAllowedTaskArtifactPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoot = path.resolve(pathResolver.sharedTmp('surface-task-sessions'));
  return resolved.startsWith(`${allowedRoot}${path.sep}`) || resolved === allowedRoot;
}

function isAllowedArtifactDownloadPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoots = [
    path.resolve(pathResolver.sharedTmp()),
    path.resolve(pathResolver.active('missions/public')),
    path.resolve(pathResolver.active('missions/confidential')),
  ];
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function isAllowedRuntimeRefPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || '').replace(/^\/+/, '');
  if (!/^active\/projects\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.active('projects'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

function isAllowedKnowledgeRefPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || '').replace(/^\/+/, '');
  if (!/^knowledge\/(public|confidential|personal)\/common\/.+\/generated\/[^/]+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoots = [
    path.resolve(pathResolver.knowledge('public/common')),
    path.resolve(pathResolver.knowledge('confidential/common')),
    path.resolve(pathResolver.knowledge('personal/common')),
  ];
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function ensureStimuliDir(): void {
  const dir = path.dirname(STIMULI_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function rememberStimulus(stimulus: Record<string, unknown>): void {
  state.recentStimuli.push(stimulus);
  state.recentStimuli = state.recentStimuli.slice(-20);
  state.lastUpdatedAt = new Date().toISOString();
}

function applyA2UIMessage(message: A2UIMessage): void {
  if (message.createSurface) {
    const current = state.surfaces[message.createSurface.surfaceId] || { components: [], data: {} };
    state.surfaces[message.createSurface.surfaceId] = {
      ...current,
      catalogId: message.createSurface.catalogId,
      title: message.createSurface.title || current.title,
      components: current.components || [],
      data: current.data || {},
    };
  }

  if (message.updateComponents) {
    const current = state.surfaces[message.updateComponents.surfaceId] || { components: [], data: {} };
    state.surfaces[message.updateComponents.surfaceId] = {
      ...current,
      components: message.updateComponents.components || [],
    };
  }

  if (message.updateDataModel) {
    const current = state.surfaces[message.updateDataModel.surfaceId] || { components: [], data: {} };
    state.surfaces[message.updateDataModel.surfaceId] = {
      ...current,
      data: {
        ...(current.data || {}),
        ...(message.updateDataModel.data || {}),
      },
    };
  }

  if (message.deleteSurface) {
    delete state.surfaces[message.deleteSurface.surfaceId];
  }

  state.lastUpdatedAt = new Date().toISOString();
}

function getSurfaceData(surfaceId: string): Record<string, unknown> {
  return state.surfaces[surfaceId]?.data || {};
}

function rebuildPresenceSurface(surfaceId: string): void {
  const data = getSurfaceData(surfaceId);
  const avatarProfile = getPresenceAvatarProfile(typeof data.agentId === 'string' ? data.agentId : undefined);
  const messages = buildPresenceSurfaceFrame({
    surfaceId,
    agentId: typeof data.agentId === 'string' ? data.agentId : avatarProfile.agentId,
    title: typeof data.title === 'string' ? data.title : 'Presence Studio',
    status: typeof data.status === 'string' ? data.status : 'ready',
    expression: typeof data.expression === 'string' ? data.expression : 'neutral',
    subtitle: typeof data.subtitle === 'string' ? data.subtitle : '',
    avatarAssetPath: typeof data.avatarAssetPath === 'string' ? data.avatarAssetPath : avatarProfile.defaultAvatarAssetPath,
    expressionAvatarMap: data.expressionAvatarMap && typeof data.expressionAvatarMap === 'object'
      ? data.expressionAvatarMap as Record<string, string>
      : avatarProfile.expressionAvatarMap,
    transcript: Array.isArray(data.transcript) ? data.transcript as Array<{ speaker: string; text: string }> : [],
  });
  for (const message of messages) applyA2UIMessage(message);
}

function updatePresenceSurface(surfaceId: string, patch: Record<string, unknown>): void {
  const current = getSurfaceData(surfaceId);
  state.surfaces[surfaceId] = {
    ...(state.surfaces[surfaceId] || { components: [], data: {} }),
    data: {
      ...current,
      ...patch,
    },
  };
  rebuildPresenceSurface(surfaceId);
}

function clearTimeline(surfaceId: string): void {
  const timers = activeTimelineTimers.get(surfaceId) || [];
  for (const timer of timers) clearTimeout(timer);
  activeTimelineTimers.delete(surfaceId);
}

function applyTimelineEvent(surfaceId: string, timeline: PresenceTimelineAdf, event: PresenceTimelineAdf['events'][number]): void {
  const current = getSurfaceData(surfaceId);
  switch (event.op) {
    case 'set_agent': {
      const agentId = String(event.params?.agentId || 'presence-surface-agent');
      const profile = getPresenceAvatarProfile(agentId);
      updatePresenceSurface(surfaceId, {
        agentId,
        displayName: profile.displayName,
        avatarAssetPath: profile.defaultAvatarAssetPath,
        expressionAvatarMap: profile.expressionAvatarMap,
      });
      break;
    }
    case 'set_status':
      updatePresenceSurface(surfaceId, { status: String(event.params?.value || event.params?.status || 'ready') });
      break;
    case 'set_expression':
      updatePresenceSurface(surfaceId, { expression: String(event.params?.value || event.params?.expression || 'neutral') });
      break;
    case 'set_subtitle':
      updatePresenceSurface(surfaceId, { subtitle: String(event.params?.text || event.params?.value || '') });
      break;
    case 'clear_subtitle':
      updatePresenceSurface(surfaceId, { subtitle: '' });
      break;
    case 'append_transcript': {
      const transcript = Array.isArray(current.transcript) ? [...current.transcript as Array<{ speaker: string; text: string }>] : [];
      transcript.push({
        speaker: String(event.params?.speaker || 'AI'),
        text: String(event.params?.text || ''),
      });
      updatePresenceSurface(surfaceId, { transcript });
      break;
    }
    case 'clear_transcript':
      updatePresenceSurface(surfaceId, { transcript: [] });
      break;
    default:
      logger.warn(`[presence-studio] unsupported timeline op ${(event as any).op}`);
  }
  state.lastUpdatedAt = new Date().toISOString();
  emitState();
}

function playTimeline(timeline: PresenceTimelineAdf): { accepted: boolean; surfaceId: string; scheduled: number } {
  const surfaceId = timeline.surface_id || 'presence-studio';
  if (timeline.interrupt_policy === 'ignore' && activeTimelineTimers.has(surfaceId)) {
    return { accepted: false, surfaceId, scheduled: 0 };
  }
  clearTimeline(surfaceId);
  if (timeline.title) {
    updatePresenceSurface(surfaceId, { title: timeline.title });
  }
  const timers = timeline.events.map((event) => setTimeout(() => {
    applyTimelineEvent(surfaceId, timeline, event);
  }, event.at_ms));
  activeTimelineTimers.set(surfaceId, timers);
  return { accepted: true, surfaceId, scheduled: timeline.events.length };
}

function broadcast(event: string, payload: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(chunk);
  }
}

function emitState(): void {
  broadcast('state', state);
}

async function pollVoiceHubSpeechStateForSse(): Promise<void> {
  if (speechStatePollInFlight) return;
  speechStatePollInFlight = true;
  try {
    const response = await fetch(`${VOICE_HUB_URL}/api/speech/state`);
    if (!response.ok) return;
    const payload = await response.json() as { speech?: { status?: string } };
    const nextState = String(payload?.speech?.status || 'idle');
    if (nextState === latestSpeechSseState) return;
    latestSpeechSseState = nextState;
    broadcast('speech_state', {
      ok: true,
      speech: payload?.speech || { status: nextState },
    });
  } catch {
    // Best effort only.
  } finally {
    speechStatePollInFlight = false;
  }
}

function listBrowserRuntimeSessions(): BrowserRuntimeSessionSummary[] {
  const dir = pathResolver.shared('runtime/browser/sessions');
  return safeExistsSync(dir)
    ? safeReaddir(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => JSON.parse(safeReadFile(path.join(dir, entry), { encoding: 'utf8' }) as string) as BrowserRuntimeSessionSummary)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    : [];
}

function loadBrowserSnapshotSummary(sessionId: string): BrowserSnapshotSummary | null {
  const filePath = pathResolver.shared(`runtime/browser/snapshots/${sessionId}.json`);
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as BrowserSnapshotSummary;
}

function pickPresenceBrowserRuntimeSession(items: BrowserRuntimeSessionSummary[]): BrowserRuntimeSessionSummary | null {
  const now = Date.now();
  const scored = items
    .map((item) => {
      const tabs = item.tabs || [];
      const preferredTab = tabs.find((tab) => tab.active && tab.url && tab.url !== 'about:blank')
        || tabs.find((tab) => tab.tab_id === item.active_tab_id && tab.url && tab.url !== 'about:blank')
        || tabs.find((tab) => tab.url && tab.url !== 'about:blank');
      const snapshot = loadBrowserSnapshotSummary(item.session_id);
      const snapshotLooksUseful = Boolean(snapshot && snapshot.url && snapshot.url !== 'about:blank' && Number(snapshot.element_count || 0) > 0);
      const hasReconnectPath = Boolean((item as any).cdp_url);
      const leaseExpiresAt = typeof (item as any).lease_expires_at === 'string'
        ? Date.parse((item as any).lease_expires_at)
        : Number.NaN;
      const leaseIsFresh = !Number.isFinite(leaseExpiresAt) || leaseExpiresAt >= now;
      const likelySyntheticSession = /^browser-(admin|cdp|cdp-reconnect|lease|pause|passkey|passkey-flow|profile|test|video|video-lease)$/.test(item.session_id);
      let score = 0;
      if (preferredTab) score += 4;
      if (snapshotLooksUseful) score += 3;
      if (hasReconnectPath && leaseIsFresh) score += 2;
      if (item.lease_status === 'active' && leaseIsFresh) score += 1;
      if (item.retained !== false && leaseIsFresh) score += 1;
      if (!leaseIsFresh) score -= 3;
      if (likelySyntheticSession && !snapshotLooksUseful) score -= 2;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.updated_at || '').localeCompare(String(a.item.updated_at || '')));

  return scored[0]?.item || null;
}

function ensurePresenceBrowserConversationSession(): ReturnType<typeof getActiveBrowserConversationSession> {
  const existing = getActiveBrowserConversationSession('presence');
  const browserSession = pickPresenceBrowserRuntimeSession(listBrowserRuntimeSessions());
  if (existing && (!browserSession || existing.target?.browser_session_id === browserSession.session_id)) {
    return existing;
  }
  if (!browserSession) return null;

  try {
    const activeTab = (browserSession.tabs || []).find((tab) => tab.active && tab.url && tab.url !== 'about:blank')
      || browserSession.tabs?.find((tab) => tab.tab_id === browserSession.active_tab_id && tab.url && tab.url !== 'about:blank')
      || browserSession.tabs?.find((tab) => tab.url && tab.url !== 'about:blank')
      || browserSession.tabs?.[0];
    const session = createBrowserConversationSession({
      sessionId: `BCS-presence-${browserSession.session_id}`,
      surface: 'presence',
      goal: {
        summary: activeTab?.title || browserSession.session_id,
        success_condition: 'Complete the requested browser step safely.',
      },
      target: {
        app: 'browser',
        window_title: activeTab?.title,
        url: activeTab?.url,
        tab_id: activeTab?.tab_id || browserSession.active_tab_id,
        browser_session_id: browserSession.session_id,
      },
    });
    saveBrowserConversationSession(session);
    return session;
  } catch (error: any) {
    logger.warn(`[presence-studio] failed to auto-bootstrap browser conversation session for ${browserSession.session_id}: ${error?.message || String(error)}`);
    return null;
  }
}

function bootstrapState(): void {
  const messages = buildPresenceSurfaceFrame({
    agentId: 'presence-surface-agent',
    title: 'Presence Studio',
    status: 'ready',
    expression: 'neutral',
    subtitle: 'Surface ready. Send A2UI or voice stimuli.',
    transcript: [],
  });
  for (const message of messages) applyA2UIMessage(message);
}

bootstrapState();
ensureStimuliDir();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(staticDir));

// Browsers always probe /favicon.ico — return 204 to silence noisy console 404.
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/api/identity', (_req, res) => {
  try {
    const personalDir = pathResolver.knowledge('personal');
    const idPath = path.join(personalDir, 'my-identity.json');
    const agentPath = path.join(personalDir, 'agent-identity.json');
    const visionPath = path.join(personalDir, 'my-vision.md');
    const result = withExecutionContext('ecosystem_architect', () => {
      const sovereign = safeExistsSync(idPath)
        ? JSON.parse(safeReadFile(idPath, { encoding: 'utf8' }) as string)
        : null;
      const agent = safeExistsSync(agentPath)
        ? JSON.parse(safeReadFile(agentPath, { encoding: 'utf8' }) as string)
        : null;
      const visionRaw = safeExistsSync(visionPath)
        ? (safeReadFile(visionPath, { encoding: 'utf8' }) as string)
        : null;
      const vision = visionRaw
        ? visionRaw.replace(/^#[^\n]*\n+/, '').trim().slice(0, 600)
        : null;
      return { sovereign, agent, vision };
    });
    res.json({
      ok: true,
      onboarded: Boolean(result.sovereign && result.agent),
      sovereign: result.sovereign,
      agent: result.agent,
      vision: result.vision,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    surfaces: Object.keys(state.surfaces).length,
    recentStimuli: state.recentStimuli.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/state', (_req, res) => {
  res.json(state);
});

app.get('/api/surface-agents', (_req, res) => {
  const currentAgentId = typeof state.surfaces['presence-studio']?.data?.agentId === 'string'
    ? state.surfaces['presence-studio']?.data?.agentId as string
    : 'presence-surface-agent';
  const currentRuntime = listAgentRuntimeSnapshots().find((entry) => entry.agent.agentId === currentAgentId);
  const providerResolution = currentRuntime?.agent?.metadata && typeof currentRuntime.agent.metadata === 'object'
    ? (currentRuntime.agent.metadata.provider_resolution as Record<string, unknown> | undefined)
    : undefined;
  const currentCatalogEntry = getSurfaceAgentCatalogEntry(currentAgentId);
  res.json({
    ok: true,
    currentAgentId,
    current: currentCatalogEntry ? {
      ...currentCatalogEntry,
      resolvedProvider: currentRuntime?.agent?.provider,
      resolvedModelId: currentRuntime?.agent?.modelId,
      providerResolution: providerResolution ? {
        preferredProvider: typeof providerResolution.preferredProvider === 'string' ? providerResolution.preferredProvider : undefined,
        preferredModelId: typeof providerResolution.preferredModelId === 'string' ? providerResolution.preferredModelId : undefined,
        strategy: typeof providerResolution.strategy === 'string' ? providerResolution.strategy : undefined,
      } : undefined,
    } : null,
    agents: listSurfaceAgentCatalog(),
  });
});

app.get('/api/standard-intents', (_req, res) => {
  try {
    const filePath = pathResolver.knowledge('public/governance/standard-intents.json');
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as StandardIntentCatalog;
    const items = Array.isArray(parsed?.intents)
      ? parsed.intents
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
              resultShape: typeof intent.resolution?.result_shape === 'string' ? intent.resolution.result_shape : undefined,
              primary_specialist: design.primary_specialist,
              conversation_agent: design.conversation_agent,
              team_roles: design.team_roles,
              outcomes: design.outcomes,
              reusable_refs: design.reusable_refs,
            };
          })
      : [];
    res.json({ ok: true, items });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get('/api/projects', (_req, res) => {
  res.json({
    ok: true,
    items: listProjectRecords(),
  });
});

app.get('/api/project-tracks', (_req, res) => {
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

app.get('/api/service-bindings', (_req, res) => {
  res.json({
    ok: true,
    items: listServiceBindingRecords(),
  });
});

app.get('/api/mission-seeds', (_req, res) => {
  res.json({
    ok: true,
    items: listMissionSeedRecords(),
  });
});

app.get('/api/distill-candidates', (_req, res) => {
  res.json({
    ok: true,
    items: listDistillCandidateRecords(),
  });
});

app.get('/api/async-requests', (_req, res) => {
  res.json({
    ok: true,
    items: listSurfaceAsyncRequests('presence'),
  });
});

app.get('/api/notifications', (_req, res) => {
  res.json({
    ok: true,
    items: listSurfaceNotifications('presence'),
  });
});

app.get('/api/approvals', (_req, res) => {
  res.json({
    ok: true,
    items: listApprovalRequests({ status: 'pending' }).slice(0, 10).map(buildApprovalInboxItem),
  });
});

app.post('/api/approvals/:requestId/decision', (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  const decision = String(req.body?.decision || '').trim();
  if (!requestId) {
    return res.status(400).json({ ok: false, error: 'requestId is required' });
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    return res.status(400).json({ ok: false, error: 'decision must be approved or rejected' });
  }

  const record = listApprovalRequests({ status: 'pending' }).find((item) => item.id === requestId);
  if (!record) {
    return res.status(404).json({ ok: false, error: `approval request not found: ${requestId}` });
  }

  try {
    const updated = decideApprovalRequest('surface_runtime', {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId,
      decision,
      decidedBy: 'presence-studio',
      decidedByRole: 'sovereign',
      authMethod: 'surface_session',
      note: 'Decision captured from Presence Studio approval inbox.',
    });
    return res.json({ ok: true, item: updated });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get('/api/outcomes', (_req, res) => {
  const items = listArtifactRecords()
    .slice(-10)
    .reverse()
    .map(buildOutcomeInboxItem);
  res.json({ ok: true, items });
});

app.get('/api/knowledge-ref', (req, res) => {
  const logicalPath = String(req.query.path || '').trim();
  if (!logicalPath) {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (!isAllowedKnowledgeRefPath(logicalPath)) {
    return res.status(403).json({ ok: false, error: `knowledge ref is not accessible: ${logicalPath}` });
  }
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) {
    return res.status(404).json({ ok: false, error: `knowledge ref not found: ${logicalPath}` });
  }
  if (logicalPath.endsWith('.json')) {
    res.type('application/json');
  } else {
    res.type('text/markdown; charset=utf-8');
  }
  return res.send(safeReadFile(resolved, { encoding: 'utf8' }));
});

app.get('/api/runtime-ref', (req, res) => {
  const logicalPath = String(req.query.path || '').trim();
  if (!logicalPath) {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (!isAllowedRuntimeRefPath(logicalPath)) {
    return res.status(403).json({ ok: false, error: `runtime ref is not accessible: ${logicalPath}` });
  }
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) {
    return res.status(404).json({ ok: false, error: `runtime ref not found: ${logicalPath}` });
  }
  res.type(logicalPath.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8');
  return res.send(safeReadFile(resolved, { encoding: 'utf8' }));
});

app.get('/api/artifacts/:artifactId', (req, res) => {
  const artifactId = String(req.params.artifactId || '').trim();
  const artifact = listArtifactRecords().find((item) => item.artifact_id === artifactId) as ArtifactRecordShape | undefined;
  if (!artifact) {
    return res.status(404).json({ ok: false, error: `artifact not found: ${artifactId}` });
  }
  const artifactPath = typeof artifact.path === 'string' ? artifact.path : '';
  if (!artifactPath || !safeExistsSync(artifactPath) || !isAllowedArtifactDownloadPath(artifactPath)) {
    return res.status(403).json({ ok: false, error: `artifact path is not accessible: ${artifactId}` });
  }
  return res.download(artifactPath, path.basename(artifactPath));
});

app.get('/api/browser-conversation-sessions', (_req, res) => {
  const active = ensurePresenceBrowserConversationSession();
  res.json({
    ok: true,
    active,
    items: listBrowserConversationSessions().filter((session) => session.surface === 'presence'),
  });
});

app.get('/api/browser-sessions', (_req, res) => {
  const items = listBrowserRuntimeSessions();
  res.json({ ok: true, items });
});

app.get('/api/task-sessions', (_req, res) => {
  res.json({
    ok: true,
    active: getActiveTaskSession('presence'),
    items: listTaskSessions('presence').slice(0, 10),
  });
});

app.get('/api/task-sessions/:sessionId', (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const session = findTaskSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: `task session not found: ${sessionId}` });
  }
  return res.json({ ok: true, item: session });
});

app.get('/api/task-sessions/:sessionId/artifact', (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  const session = findTaskSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: `task session not found: ${sessionId}` });
  }
  const artifact = (session.artifact || {}) as TaskSessionArtifactShape;
  const outputPath = typeof artifact.output_path === 'string' ? artifact.output_path : '';
  if (!outputPath) {
    return res.status(404).json({ ok: false, error: `artifact not found for task session: ${sessionId}` });
  }
  if (!isAllowedTaskArtifactPath(outputPath) || !safeExistsSync(outputPath)) {
    return res.status(403).json({ ok: false, error: `artifact path is not accessible: ${sessionId}` });
  }
  return res.download(outputPath, path.basename(outputPath));
});

app.post('/api/browser-conversation-sessions/bootstrap', (req, res) => {
  const browserSessionId = typeof req.body?.browser_session_id === 'string' ? req.body.browser_session_id.trim() : '';
  if (!browserSessionId) {
    return res.status(400).json({ ok: false, error: 'browser_session_id is required' });
  }

  try {
    const browserSession = listBrowserRuntimeSessions().find((item) => item.session_id === browserSessionId);
    if (!browserSession) {
      return res.status(404).json({ ok: false, error: `browser session not found: ${browserSessionId}` });
    }
    const activeTab = (browserSession.tabs || []).find((tab) => tab.active && tab.url && tab.url !== 'about:blank')
      || browserSession.tabs?.find((tab) => tab.tab_id === browserSession.active_tab_id && tab.url && tab.url !== 'about:blank')
      || browserSession.tabs?.find((tab) => tab.url && tab.url !== 'about:blank')
      || browserSession.tabs?.[0];
    const session = createBrowserConversationSession({
      sessionId: `BCS-presence-${browserSessionId}`,
      surface: 'presence',
      goal: {
        summary: typeof req.body?.goal_summary === 'string' ? req.body.goal_summary : (activeTab?.title || browserSessionId),
        success_condition: typeof req.body?.success_condition === 'string' ? req.body.success_condition : 'Complete the requested browser step safely.',
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
    return res.json({ ok: true, session });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  res.write(`event: speech_state\ndata: ${JSON.stringify({ ok: true, speech: { status: latestSpeechSseState } })}\n\n`);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/a2ui/dispatch', (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    applyA2UIMessage(message as A2UIMessage);
  }
  emitState();
  res.json({ ok: true, applied: messages.length });
});

app.post('/api/voice/stimuli', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();

  const stimulus = createPresenceVoiceStimulus(
    text,
    typeof req.body?.intent === 'string' ? req.body.intent : 'conversation',
    typeof req.body?.source_id === 'string' ? req.body.source_id : 'presence-studio',
    requestId,
  );
  safeAppendFileSync(STIMULI_PATH, `${JSON.stringify(stimulus)}\n`, 'utf8');
  rememberStimulus(stimulus as unknown as Record<string, unknown>);
  emitState();
  return res.status(201).json({ ok: true, request_id: requestId, stimulus });
});

app.post('/api/voice/ingest', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();

  const response = await fetch(`${VOICE_HUB_URL}/api/ingest-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      text,
      intent: typeof req.body?.intent === 'string' ? req.body.intent : 'conversation',
      source_id: typeof req.body?.source_id === 'string' ? req.body.source_id : 'browser-mic',
      speaker: typeof req.body?.speaker === 'string' ? req.body.speaker : 'User',
      reflect_to_surface: req.body?.reflect_to_surface !== false,
      auto_reply: req.body?.auto_reply !== false,
    }),
  });

  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.post('/api/voice/native-listen', async (req, res) => {
  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();

  const response = await fetch(`${VOICE_HUB_URL}/api/listen-once`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: requestId,
      locale: typeof req.body?.locale === 'string' ? req.body.locale : 'ja-JP',
      device_id: typeof req.body?.device_id === 'string' ? req.body.device_id : undefined,
      backend: typeof req.body?.backend === 'string' ? req.body.backend : undefined,
      timeout_seconds: Number.isFinite(req.body?.timeout_seconds) ? Number(req.body.timeout_seconds) : 8,
      intent: typeof req.body?.intent === 'string' ? req.body.intent : 'conversation',
      speaker: typeof req.body?.speaker === 'string' ? req.body.speaker : 'User',
      reflect_to_surface: req.body?.reflect_to_surface !== false,
      auto_reply: req.body?.auto_reply !== false,
    }),
  });

  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.get('/api/voice/input-devices', async (_req, res) => {
  const response = await fetch(`${VOICE_HUB_URL}/api/input-devices`);
  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.get('/api/voice/stt-backends', async (_req, res) => {
  const response = await fetch(`${VOICE_HUB_URL}/api/stt/backends`);
  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.get('/api/voice/speech-state', async (_req, res) => {
  const response = await fetch(`${VOICE_HUB_URL}/api/speech/state`);
  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.get('/api/context/location', (_req, res) => {
  res.json({ ok: true, location: latestLocationContext });
});

app.post('/api/context/location', (req, res) => {
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  const accuracy = req.body?.accuracy == null ? undefined : Number(req.body.accuracy);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ ok: false, error: 'latitude and longitude are required' });
  }
  latestLocationContext = {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
    timestamp: typeof req.body?.timestamp === 'string' ? req.body.timestamp : new Date().toISOString(),
    source: 'browser_geolocation',
  };
  return res.json({ ok: true, location: latestLocationContext });
});

app.post('/api/voice/stop-speaking', async (req, res) => {
  const response = await fetch(`${VOICE_HUB_URL}/api/stop-speaking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reason: typeof req.body?.reason === 'string' ? req.body.reason : 'manual_stop',
    }),
  });
  const payload = await response.text();
  res.status(response.status).type('application/json').send(payload);
});

app.post('/api/demo/frame', (req, res) => {
  const messages = buildPresenceSurfaceFrame({
    surfaceId: typeof req.body?.surfaceId === 'string' ? req.body.surfaceId : 'presence-studio',
    agentId: typeof req.body?.agentId === 'string' ? req.body.agentId : 'presence-surface-agent',
    title: typeof req.body?.title === 'string' ? req.body.title : 'Presence Studio',
    status: typeof req.body?.status === 'string' ? req.body.status : 'speaking',
    expression: typeof req.body?.expression === 'string' ? req.body.expression : 'joy',
    subtitle: typeof req.body?.subtitle === 'string' ? req.body.subtitle : 'Hello from Kyberion.',
    transcript: Array.isArray(req.body?.transcript) ? req.body.transcript : [{ speaker: 'AI', text: 'Hello from Kyberion.' }],
  });
  for (const message of messages) applyA2UIMessage(message);
  emitState();
  res.json({ ok: true, messages });
});

app.post('/api/timeline/dispatch', (req, res) => {
  const timeline = validatePresenceTimeline(req.body);
  const result = playTimeline(timeline);
  return res.status(result.accepted ? 202 : 409).json({ ok: result.accepted, ...result });
});

app.get('/api/stimuli/tail', (_req, res) => {
  if (!safeExistsSync(STIMULI_PATH)) return res.json({ items: [] });
  const content = safeReadFile(STIMULI_PATH, { encoding: 'utf8' }) as string;
  const items = content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-20)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return { raw: line };
      }
    });
  res.json({ items });
});

server.listen(PORT, HOST, () => {
  logger.info(`[presence-studio] listening on http://${HOST}:${PORT}`);
  setTimeout(() => {
    ensurePresenceBrowserConversationSession();
  }, 0);
});

setInterval(() => {
  void pollVoiceHubSpeechStateForSse();
}, SPEECH_STATE_POLL_MS);
