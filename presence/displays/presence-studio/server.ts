import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import {
  getPresenceStudioClientAddress,
  requirePresenceStudioAccess,
  requirePresenceStudioRateLimit,
  presenceStudioEmailDeliverSchema,
  presenceStudioEmailDraftSchema,
  presenceStudioLocationSchema,
  presenceStudioBrowserBootstrapSchema,
  summarizePresenceStudioIdentity,
  summarizePresenceStudioState,
  presenceStudioVoiceMinutesSchema,
  presenceStudioVoiceIngestSchema,
  presenceStudioVoiceNativeListenSchema,
  presenceStudioVoiceStimulusSchema,
  validateLocalServiceUrl,
} from './security.js';
import {
  buildPresenceSurfaceFrame,
  buildTrackGateReadinessSummaries,
  createBrowserConversationSession,
  createPresenceVoiceStimulus,
  decideApprovalRequest,
  executeServicePreset,
  getReasoningBackend,
  getActiveBrowserConversationSession,
  getActiveTaskSession,
  getPresenceAvatarProfile,
  buildSurfaceLauncherNextActions,
  buildSurfaceLauncherRecommendations,
  getSurfaceAgentCatalogEntry,
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
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
  listSurfaceAsyncRequestsAcrossChannels,
  listSurfaceNotificationsAcrossChannels,
  listSurfaceAgentCatalog,
  logger,
  pathResolver,
  resolveWorkDesign,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeExec,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
  saveBrowserConversationSession,
  type A2UIMessage,
  type PresenceTimelineAdf,
  validatePresenceTimeline,
  createCompanionWebThemePack,
  webThemePackToCssVars,
  installShellSpeechToTextBridgeIfAvailable,
  probeMicCapture,
  startInRoomMinutesSession,
  withExecutionContext,
} from '@agent/core';
import {
  executeGmailDelivery,
  extractFirstJsonBlock,
  generateEmailReplyDraft,
  readEmailDraftArtifact as readSharedEmailDraftArtifact,
  readGwsAuthStatus,
  resolveEmailTriagePath,
} from '@agent/core/email-workflow';
import { collectDoctorReport } from '../../../scripts/run_doctor.js';

type Client = express.Response;

interface SurfaceSnapshot {
  catalogId?: string;
  title?: string;
  components: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
  data: Record<string, unknown>;
}

let surfaceLauncherCache: {
  fetchedAt: number;
  payload: Record<string, unknown>;
} | null = null;

async function loadSurfaceLauncherPayload(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (surfaceLauncherCache && now - surfaceLauncherCache.fetchedAt < 15_000) {
    return surfaceLauncherCache.payload;
  }

  const rows = getSurfaceDirectory();
  const summary = getSurfaceDirectorySummary();
  const doctor = await collectDoctorReport({ runtime: 'meeting' });
  const payload = {
    ok: true,
    summary,
    rows,
    scenarios: getSurfaceScenarioGuide(),
    recommendations: buildSurfaceLauncherRecommendations({
      rows,
      doctorSummaries: doctor.summaries,
    }),
    nextActions: buildSurfaceLauncherNextActions({
      summary,
      rows,
      doctorSummaries: doctor.summaries,
    }),
    doctor,
  };
  surfaceLauncherCache = { fetchedAt: now, payload };
  return payload;
}

function inferProjectIdForApprovalRecord(record: any): string | undefined {
  const projects = listProjectRecords();
  const missionId = record?.requestedByContext?.missionId;
  const serviceId = record?.target?.serviceId;
  if (missionId) {
    const byMission = projects.find((project) =>
      (project.active_missions || []).includes(missionId)
    );
    if (byMission) return byMission.project_id;
  }
  if (serviceId) {
    const byService = projects.find((project) =>
      (project.service_bindings || []).some((bindingId) => bindingId.includes(serviceId))
    );
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
    downloadable:
      typeof item.path === 'string' &&
      isAllowedArtifactDownloadPath(item.path) &&
      safeExistsSync(item.path),
    distill_titles: relatedCandidates.map((candidate) => candidate.title),
    promoted_refs: relatedCandidates.map((candidate) => candidate.promoted_ref).filter(Boolean),
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

interface VoiceMinutesArtifact {
  title: string;
  summary: string;
  decisions: string[];
  action_items: string[];
  open_questions: string[];
  minutes_markdown: string;
}

interface EmailTriageArtifact {
  exists: boolean;
  path: string;
  updated_at: string | null;
  content: string;
}

function validationErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message || 'Invalid request body';
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function presenceStudioAuditLine(
  req: Pick<express.Request, 'method' | 'path' | 'url' | 'socket'>,
  action: string,
  fields: Record<string, string | number | boolean | null | undefined>
): string {
  const parts = [
    `[presence-studio][${action}]`,
    `method=${String(req.method || 'UNKNOWN').toUpperCase()}`,
    `path=${String(req.path || req.url || '')}`,
    `client=${getPresenceStudioClientAddress(req)}`,
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}

const app = express();
const server = createServer(app);
const staticDir = path.join(pathResolver.rootDir(), 'presence/displays/presence-studio/static');
const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const PORT = Number(process.env.PRESENCE_STUDIO_PORT || 3031);
const HOST = process.env.PRESENCE_STUDIO_HOST || '127.0.0.1';
const VOICE_HUB_URL = validateLocalServiceUrl(
  process.env.VOICE_HUB_URL || 'http://127.0.0.1:3032',
  'VOICE_HUB_URL'
);
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
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
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
  if (
    !/^knowledge\/(public|confidential|personal)\/common\/.+\/generated\/[^/]+\.(md|json)$/i.test(
      normalized
    )
  ) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoots = [
    path.resolve(pathResolver.knowledge('public/common')),
    path.resolve(pathResolver.knowledge('confidential/common')),
    path.resolve(pathResolver.knowledge('personal/common')),
  ];
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
}

function ensureStimuliDir(): void {
  const dir = path.dirname(STIMULI_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function toLineItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\n+/)
      .map((item) => item.replace(/^[\s*-]+/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function buildFallbackMinutesMarkdown(input: {
  title: string;
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  sourceText: string;
}): string {
  const topSummary =
    input.summary.trim() ||
    input.sourceText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' ');
  const sourcePreview = input.sourceText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join('\n');
  return [
    `# ${input.title}`,
    '',
    '## Summary',
    topSummary || 'No summary available.',
    '',
    '## Decisions',
    ...(input.decisions.length ? input.decisions.map((item) => `- ${item}`) : ['- None captured.']),
    '',
    '## Action Items',
    ...(input.actionItems.length
      ? input.actionItems.map((item) => `- ${item}`)
      : ['- None captured.']),
    '',
    '## Open Questions',
    ...(input.openQuestions.length
      ? input.openQuestions.map((item) => `- ${item}`)
      : ['- None captured.']),
    '',
    '## Source Notes',
    sourcePreview || input.sourceText,
    '',
  ].join('\n');
}

function resolveVoiceMinutesDir(missionId?: string): string {
  if (missionId) {
    const missionDir = pathResolver.missionEvidenceDir(missionId);
    if (missionDir) return missionDir;
  }
  return pathResolver.shared('runtime/presence-studio/voice-notes');
}

function readEmailTriageArtifact(): EmailTriageArtifact {
  const path = resolveEmailTriagePath();
  if (!safeExistsSync(path)) {
    return {
      exists: false,
      path,
      updated_at: null,
      content: '',
    };
  }
  const content = String(safeReadFile(path, { encoding: 'utf8' }) || '');
  return {
    exists: true,
    path,
    updated_at: new Date().toISOString(),
    content,
  };
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
    const current = state.surfaces[message.updateComponents.surfaceId] || {
      components: [],
      data: {},
    };
    state.surfaces[message.updateComponents.surfaceId] = {
      ...current,
      components: message.updateComponents.components || [],
    };
  }

  if (message.updateDataModel) {
    const current = state.surfaces[message.updateDataModel.surfaceId] || {
      components: [],
      data: {},
    };
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
  const avatarProfile = getPresenceAvatarProfile(
    typeof data.agentId === 'string' ? data.agentId : undefined
  );
  const messages = buildPresenceSurfaceFrame({
    surfaceId,
    agentId: typeof data.agentId === 'string' ? data.agentId : avatarProfile.agentId,
    title: typeof data.title === 'string' ? data.title : 'Presence Studio',
    status: typeof data.status === 'string' ? data.status : 'ready',
    expression: typeof data.expression === 'string' ? data.expression : 'neutral',
    subtitle: typeof data.subtitle === 'string' ? data.subtitle : '',
    avatarAssetPath:
      typeof data.avatarAssetPath === 'string'
        ? data.avatarAssetPath
        : avatarProfile.defaultAvatarAssetPath,
    expressionAvatarMap:
      data.expressionAvatarMap && typeof data.expressionAvatarMap === 'object'
        ? (data.expressionAvatarMap as Record<string, string>)
        : avatarProfile.expressionAvatarMap,
    transcript: Array.isArray(data.transcript)
      ? (data.transcript as Array<{ speaker: string; text: string }>)
      : [],
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

function applyTimelineEvent(
  surfaceId: string,
  timeline: PresenceTimelineAdf,
  event: PresenceTimelineAdf['events'][number]
): void {
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
      updatePresenceSurface(surfaceId, {
        status: String(event.params?.value || event.params?.status || 'ready'),
      });
      break;
    case 'set_expression':
      updatePresenceSurface(surfaceId, {
        expression: String(event.params?.value || event.params?.expression || 'neutral'),
      });
      break;
    case 'set_subtitle':
      updatePresenceSurface(surfaceId, {
        subtitle: String(event.params?.text || event.params?.value || ''),
      });
      break;
    case 'clear_subtitle':
      updatePresenceSurface(surfaceId, { subtitle: '' });
      break;
    case 'append_transcript': {
      const transcript = Array.isArray(current.transcript)
        ? [...(current.transcript as Array<{ speaker: string; text: string }>)]
        : [];
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

function playTimeline(timeline: PresenceTimelineAdf): {
  accepted: boolean;
  surfaceId: string;
  scheduled: number;
} {
  const surfaceId = timeline.surface_id || 'presence-studio';
  if (timeline.interrupt_policy === 'ignore' && activeTimelineTimers.has(surfaceId)) {
    return { accepted: false, surfaceId, scheduled: 0 };
  }
  clearTimeline(surfaceId);
  if (timeline.title) {
    updatePresenceSurface(surfaceId, { title: timeline.title });
  }
  const timers = timeline.events.map((event) =>
    setTimeout(() => {
      applyTimelineEvent(surfaceId, timeline, event);
    }, event.at_ms)
  );
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
    const payload = (await response.json()) as { speech?: { status?: string } };
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
        .map(
          (entry) =>
            JSON.parse(
              safeReadFile(path.join(dir, entry), { encoding: 'utf8' }) as string
            ) as BrowserRuntimeSessionSummary
        )
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    : [];
}

function loadBrowserSnapshotSummary(sessionId: string): BrowserSnapshotSummary | null {
  const filePath = pathResolver.shared(`runtime/browser/snapshots/${sessionId}.json`);
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(
    safeReadFile(filePath, { encoding: 'utf8' }) as string
  ) as BrowserSnapshotSummary;
}

function pickPresenceBrowserRuntimeSession(
  items: BrowserRuntimeSessionSummary[]
): BrowserRuntimeSessionSummary | null {
  const now = Date.now();
  const scored = items
    .map((item) => {
      const tabs = item.tabs || [];
      const preferredTab =
        tabs.find((tab) => tab.active && tab.url && tab.url !== 'about:blank') ||
        tabs.find(
          (tab) => tab.tab_id === item.active_tab_id && tab.url && tab.url !== 'about:blank'
        ) ||
        tabs.find((tab) => tab.url && tab.url !== 'about:blank');
      const snapshot = loadBrowserSnapshotSummary(item.session_id);
      const snapshotLooksUseful = Boolean(
        snapshot &&
        snapshot.url &&
        snapshot.url !== 'about:blank' &&
        Number(snapshot.element_count || 0) > 0
      );
      const hasReconnectPath = Boolean((item as any).cdp_url);
      const leaseExpiresAt =
        typeof (item as any).lease_expires_at === 'string'
          ? Date.parse((item as any).lease_expires_at)
          : Number.NaN;
      const leaseIsFresh = !Number.isFinite(leaseExpiresAt) || leaseExpiresAt >= now;
      const likelySyntheticSession =
        /^browser-(admin|cdp|cdp-reconnect|lease|pause|passkey|passkey-flow|profile|test|video|video-lease)$/.test(
          item.session_id
        );
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
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(b.item.updated_at || '').localeCompare(String(a.item.updated_at || ''))
    );

  return scored[0]?.item || null;
}

function ensurePresenceBrowserConversationSession(): ReturnType<
  typeof getActiveBrowserConversationSession
> {
  const existing = getActiveBrowserConversationSession('presence');
  const browserSession = pickPresenceBrowserRuntimeSession(listBrowserRuntimeSessions());
  if (
    existing &&
    (!browserSession || existing.target?.browser_session_id === browserSession.session_id)
  ) {
    return existing;
  }
  if (!browserSession) return null;

  try {
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
    logger.warn(
      `[presence-studio] failed to auto-bootstrap browser conversation session for ${browserSession.session_id}: ${error?.message || String(error)}`
    );
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
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(staticDir));
app.use(['/api', '/a2ui'], requirePresenceStudioRateLimit(), requirePresenceStudioAccess());

// Browsers always probe /favicon.ico — return 204 to silence noisy console 404.
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

// --- In-room minutes recording (マイク録音 → 自動議事録) -------------------
let inRoomMinutesSession: Awaited<ReturnType<typeof startInRoomMinutesSession>> | null = null;
let inRoomMinutesMissionId: string | null = null;

app.post('/api/minutes/session/start', async (req, res) => {
  try {
    if (inRoomMinutesSession) {
      res.status(409).json({ ok: false, error: `既に録音中です (${inRoomMinutesMissionId})` });
      return;
    }
    const missionId = String(req.body?.missionId || '').trim();
    if (!missionId) {
      res.status(400).json({ ok: false, error: 'missionId が必要です' });
      return;
    }
    const probe = probeMicCapture();
    if (!probe.available) {
      res.status(503).json({ ok: false, error: probe.reason || 'マイクが利用できません' });
      return;
    }
    installShellSpeechToTextBridgeIfAvailable();
    inRoomMinutesSession = await startInRoomMinutesSession({
      missionId,
      meetingTitle: typeof req.body?.title === 'string' ? req.body.title : undefined,
      language: typeof req.body?.language === 'string' ? req.body.language : 'ja',
      mic: { device: typeof req.body?.device === 'string' ? req.body.device : undefined },
      onTranscriptChunk: (chunk) => {
        broadcast('minutes-transcript', chunk);
      },
    });
    inRoomMinutesMissionId = missionId.toUpperCase();
    broadcast('minutes-session', { status: 'recording', missionId: inRoomMinutesMissionId });
    res.json({
      ok: true,
      missionId: inRoomMinutesMissionId,
      transcriptPath: inRoomMinutesSession.transcriptPath,
      backend: probe.backend,
    });
  } catch (err: any) {
    inRoomMinutesSession = null;
    inRoomMinutesMissionId = null;
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/minutes/session/stop', async (_req, res) => {
  try {
    if (!inRoomMinutesSession) {
      res.status(409).json({ ok: false, error: '録音中のセッションがありません' });
      return;
    }
    const session = inRoomMinutesSession;
    inRoomMinutesSession = null;
    const missionId = inRoomMinutesMissionId;
    inRoomMinutesMissionId = null;
    const result = await session.stop();
    broadcast('minutes-session', {
      status: 'completed',
      missionId,
      minutesPath: result.minutesPath,
      transcriptPath: result.transcriptPath,
      segments: result.segments,
    });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/api/minutes/session', (_req, res) => {
  res.json({
    ok: true,
    recording: Boolean(inRoomMinutesSession),
    missionId: inRoomMinutesMissionId,
  });
});

// DS-01: canonical design tokens for this face — the companion theme pack
// rendered as --kb-* CSS vars. Loaded after the static design-tokens.css so
// the canonical values win while the static file remains the fallback.
app.get('/api/design-tokens.css', (_req, res) => {
  const cssVars = webThemePackToCssVars(createCompanionWebThemePack());
  // The shared derivation targets dark surfaces (panel = primary @ 0.82);
  // the companion theme is light, so keep panels as a faint primary tint.
  cssVars['--kb-panel-bg'] = 'rgba(19, 52, 59, 0.05)';
  const body = `:root {\n${Object.entries(cssVars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')}\n}\n`;
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    surfaces: Object.keys(state.surfaces).length,
    recentStimuli: state.recentStimuli.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/state', (_req, res) => {
  res.json(summarizePresenceStudioState(state));
});

app.get('/api/email-triage', (_req, res) => {
  res.json(readEmailTriageArtifact());
});

app.get('/api/email-draft', (_req, res) => {
  res.json(readSharedEmailDraftArtifact());
});

app.get('/api/email-auth-status', (_req, res) => {
  res.json(readGwsAuthStatus());
});

app.get('/api/surface-agents', (_req, res) => {
  const currentAgentId =
    typeof state.surfaces['presence-studio']?.data?.agentId === 'string'
      ? (state.surfaces['presence-studio']?.data?.agentId as string)
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

app.get('/api/standard-intents', (_req, res) => {
  try {
    const filePath = pathResolver.knowledge('product/governance/standard-intents.json');
    const parsed = JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as StandardIntentCatalog;
    const items = Array.isArray(parsed?.intents)
      ? parsed.intents
          .filter((intent) => intent?.category === 'surface')
          .map((intent) => {
            const design = resolveWorkDesign({
              intentId: intent.id,
              shape:
                typeof intent.resolution?.shape === 'string' ? intent.resolution.shape : undefined,
              outcomeIds: Array.isArray(intent.outcome_ids) ? intent.outcome_ids : [],
            });
            return {
              id: intent.id || 'unknown',
              description: intent.description || '',
              examples: Array.isArray(intent.surface_examples) ? intent.surface_examples : [],
              planOutline: Array.isArray(intent.plan_outline) ? intent.plan_outline : [],
              shape:
                typeof intent.resolution?.shape === 'string' ? intent.resolution.shape : undefined,
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
    items: listSurfaceAsyncRequestsAcrossChannels().slice(0, 20),
  });
});

app.get('/api/notifications', (_req, res) => {
  res.json({
    ok: true,
    items: listSurfaceNotificationsAcrossChannels().slice(0, 20),
  });
});

app.get('/api/surface-launcher', async (_req, res) => {
  try {
    res.json(await loadSurfaceLauncherPayload());
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
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
    logger.warn(
      presenceStudioAuditLine(req, 'approvals/decision.reject', {
        status: 400,
        error: 'requestId is required',
      })
    );
    return res.status(400).json({ ok: false, error: 'requestId is required' });
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    logger.warn(
      presenceStudioAuditLine(req, 'approvals/decision.reject', {
        request_id: requestId,
        status: 400,
        error: 'decision must be approved or rejected',
      })
    );
    return res.status(400).json({ ok: false, error: 'decision must be approved or rejected' });
  }

  const record = listApprovalRequests({ status: 'pending' }).find((item) => item.id === requestId);
  if (!record) {
    logger.warn(
      presenceStudioAuditLine(req, 'approvals/decision.reject', {
        request_id: requestId,
        status: 404,
        error: 'approval request not found',
      })
    );
    return res.status(404).json({ ok: false, error: `approval request not found: ${requestId}` });
  }

  try {
    logger.info(
      presenceStudioAuditLine(req, 'approvals/decision.accept', {
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
      presenceStudioAuditLine(req, 'approvals/decision.complete', {
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

app.get('/api/outcomes', (_req, res) => {
  const items = listArtifactRecords().slice(-10).reverse().map(buildOutcomeInboxItem);
  res.json({ ok: true, items });
});

app.get('/api/knowledge-ref', (req, res) => {
  const logicalPath = String(req.query.path || '').trim();
  if (!logicalPath) {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  if (!isAllowedKnowledgeRefPath(logicalPath)) {
    return res
      .status(403)
      .json({ ok: false, error: `knowledge ref is not accessible: ${logicalPath}` });
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
    return res
      .status(403)
      .json({ ok: false, error: `runtime ref is not accessible: ${logicalPath}` });
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
  const artifact = listArtifactRecords().find((item) => item.artifact_id === artifactId) as
    | ArtifactRecordShape
    | undefined;
  if (!artifact) {
    return res.status(404).json({ ok: false, error: `artifact not found: ${artifactId}` });
  }
  const artifactPath = typeof artifact.path === 'string' ? artifact.path : '';
  if (
    !artifactPath ||
    !safeExistsSync(artifactPath) ||
    !isAllowedArtifactDownloadPath(artifactPath)
  ) {
    return res
      .status(403)
      .json({ ok: false, error: `artifact path is not accessible: ${artifactId}` });
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
    return res
      .status(404)
      .json({ ok: false, error: `artifact not found for task session: ${sessionId}` });
  }
  if (!isAllowedTaskArtifactPath(outputPath) || !safeExistsSync(outputPath)) {
    return res
      .status(403)
      .json({ ok: false, error: `artifact path is not accessible: ${sessionId}` });
  }
  return res.download(outputPath, path.basename(outputPath));
});

app.post('/api/browser-conversation-sessions/bootstrap', (req, res) => {
  const parsed = presenceStudioBrowserBootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'browser-bootstrap.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }
  const browserSessionId = parsed.data.browser_session_id;
  logger.info(
    presenceStudioAuditLine(req, 'browser-bootstrap.accept', {
      browser_session_id: browserSessionId,
      goal_summary_len: parsed.data.goal_summary?.length || 0,
      success_condition_len: parsed.data.success_condition?.length || 0,
    })
  );

  try {
    const browserSession = listBrowserRuntimeSessions().find(
      (item) => item.session_id === browserSessionId
    );
    if (!browserSession) {
      logger.warn(
        presenceStudioAuditLine(req, 'browser-bootstrap.reject', {
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
      presenceStudioAuditLine(req, 'browser-bootstrap.complete', {
        browser_session_id: browserSessionId,
        session_id: session.session_id,
        status: 200,
      })
    );
    return res.json({ ok: true, session });
  } catch (error: any) {
    logger.warn(
      presenceStudioAuditLine(req, 'browser-bootstrap.fail', {
        browser_session_id: browserSessionId,
        status: 500,
        error: error?.message || String(error),
      })
    );
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
  res.write(
    `event: speech_state\ndata: ${JSON.stringify({ ok: true, speech: { status: latestSpeechSseState } })}\n\n`
  );
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/a2ui/dispatch', (req, res) => {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  logger.info(
    presenceStudioAuditLine(req, 'a2ui/dispatch.accept', {
      messages: messages.length,
      body_kind: Array.isArray(body) ? 'array' : typeof body,
    })
  );
  for (const message of messages) {
    applyA2UIMessage(message as A2UIMessage);
  }
  emitState();
  logger.info(
    presenceStudioAuditLine(req, 'a2ui/dispatch.complete', {
      messages: messages.length,
      status: 200,
    })
  );
  res.json({ ok: true, applied: messages.length });
});

app.post('/api/voice/stimuli', (req, res) => {
  const parsed = presenceStudioVoiceStimulusSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'voice/stimuli.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }

  const requestId = parsed.data.request_id || randomUUID();
  logger.info(
    presenceStudioAuditLine(req, 'voice/stimuli.accept', {
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
  safeAppendFileSync(STIMULI_PATH, `${JSON.stringify(stimulus)}\n`, 'utf8');
  rememberStimulus(stimulus as unknown as Record<string, unknown>);
  emitState();
  logger.info(
    presenceStudioAuditLine(req, 'voice/stimuli.complete', {
      request_id: requestId,
      status: 201,
    })
  );
  return res.status(201).json({ ok: true, request_id: requestId, stimulus });
});

app.post('/api/voice/ingest', async (req, res) => {
  const parsed = presenceStudioVoiceIngestSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'voice/ingest.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }

  const requestId = parsed.data.request_id || randomUUID();
  logger.info(
    presenceStudioAuditLine(req, 'voice/ingest.accept', {
      request_id: requestId,
      text_len: parsed.data.text.length,
      intent: parsed.data.intent || 'conversation',
      source_id: parsed.data.source_id || 'browser-mic',
    })
  );

  const response = await fetch(`${VOICE_HUB_URL}/api/ingest-text`, {
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
          : toBoolean(parsed.data.reflect_to_surface),
      auto_reply: parsed.data.auto_reply === undefined ? true : toBoolean(parsed.data.auto_reply),
    }),
  });

  const payload = await response.text();
  logger.info(
    presenceStudioAuditLine(req, 'voice/ingest.complete', {
      request_id: requestId,
      status: response.status,
    })
  );
  res.status(response.status).type('application/json').send(payload);
});

app.post('/api/voice/minutes', async (req, res) => {
  const parsed = presenceStudioVoiceMinutesSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'voice/minutes.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }

  const sourceText = parsed.data.text;
  const requestId = parsed.data.request_id || randomUUID();
  const missionId = parsed.data.mission_id || undefined;
  const title = parsed.data.title || 'Voice Notes Minutes';
  const language = parsed.data.language || 'ja';
  const attendees = toLineItems(parsed.data.attendees);
  logger.info(
    presenceStudioAuditLine(req, 'voice/minutes.accept', {
      request_id: requestId,
      mission_id: missionId || 'none',
      text_len: sourceText.length,
      attendees: attendees.length,
      language,
    })
  );
  const outputDir = resolveVoiceMinutesDir(missionId);
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
  let artifact: VoiceMinutesArtifact | null = null;
  try {
    const raw = await backend.delegateTask(prompt, `voice-minutes:${requestId}`);
    backendName = (backend as any)?.name || backendName;
    const parsed = extractFirstJsonBlock(raw);
    if (parsed) {
      artifact = {
        title:
          typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : title,
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
        decisions: toLineItems(parsed.decisions),
        action_items: toLineItems(parsed.action_items),
        open_questions: toLineItems(parsed.open_questions),
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
    buildFallbackMinutesMarkdown({
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
    presenceStudioAuditLine(req, 'voice/minutes.complete', {
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

app.post('/api/email-draft', async (req, res) => {
  const parsed = presenceStudioEmailDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'email-draft.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }

  const requestId = parsed.data.request_id || randomUUID();
  const recipient = parsed.data.to || '';
  const subjectInput = parsed.data.subject || '';
  const tone = parsed.data.tone || 'clear and concise';
  const triageInput = parsed.data.triage_text || '';
  const triageText = triageInput || readEmailTriageArtifact().content.trim();
  if (!triageText) {
    logger.warn(
      presenceStudioAuditLine(req, 'email-draft.reject', {
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
    presenceStudioAuditLine(req, 'email-draft.accept', {
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
      presenceStudioAuditLine(req, 'email-draft.fail', {
        request_id: requestId,
        status: 500,
        error: error?.message || String(error),
      })
    );
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

app.post('/api/email-deliver', async (req, res) => {
  const parsed = presenceStudioEmailDeliverSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'email-deliver.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }
  const approved = toBoolean(parsed.data.approved);
  const body_markdown = parsed.data.body_markdown;
  const reply_mode = parsed.data.reply_mode || 'new';
  const draft_mode = toBoolean(parsed.data.draft_mode);
  const subject = parsed.data.subject || '';
  const to = parsed.data.to || '';
  const message_id = parsed.data.message_id || '';
  if (!draft_mode && !approved) {
    logger.warn(
      presenceStudioAuditLine(req, 'email-deliver.reject', {
        status: 400,
        error: 'approval is required before sending an email',
        draft_mode,
      })
    );
    return res.status(400).json({ error: 'approval is required before sending an email' });
  }
  logger.info(
    presenceStudioAuditLine(req, 'email-deliver.accept', {
      status: 202,
      draft_mode,
      reply_mode,
      approved,
      to_present: to ? 'yes' : 'no',
      subject_len: subject.length,
      message_id_present: message_id ? 'yes' : 'no',
    })
  );

  try {
    const result = await executeGmailDelivery({
      approved,
      draft_mode,
      reply_mode,
      body_markdown,
      subject,
      to,
      message_id: message_id || undefined,
    });
    return res.status(201).json({
      ok: true,
      mode: draft_mode ? 'draft' : 'send',
      reply_mode,
      result,
    });
  } catch (error: any) {
    logger.warn(`[presence-studio] gmail delivery failed: ${error?.message || String(error)}`);
    logger.warn(
      presenceStudioAuditLine(req, 'email-deliver.fail', {
        status: 500,
        error: error?.message || String(error),
      })
    );
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

app.post('/api/voice/native-listen', async (req, res) => {
  const parsed = presenceStudioVoiceNativeListenSchema.safeParse({
    ...req.body,
    timeout_seconds: Number.isFinite(req.body?.timeout_seconds)
      ? Number(req.body.timeout_seconds)
      : undefined,
  });
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'voice/native-listen.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }
  const requestId = parsed.data.request_id || randomUUID();
  logger.info(
    presenceStudioAuditLine(req, 'voice/native-listen.accept', {
      request_id: requestId,
      locale: parsed.data.locale || 'ja-JP',
      backend: parsed.data.backend || 'default',
      timeout_seconds: parsed.data.timeout_seconds || 8,
    })
  );

  const response = await fetch(`${VOICE_HUB_URL}/api/listen-once`, {
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
          : toBoolean(parsed.data.reflect_to_surface),
      auto_reply: parsed.data.auto_reply === undefined ? true : toBoolean(parsed.data.auto_reply),
    }),
  });

  const payload = await response.text();
  logger.info(
    presenceStudioAuditLine(req, 'voice/native-listen.complete', {
      request_id: requestId,
      status: response.status,
    })
  );
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
  const parsed = presenceStudioLocationSchema.safeParse({
    latitude: Number(req.body?.latitude),
    longitude: Number(req.body?.longitude),
    accuracy: req.body?.accuracy == null ? undefined : Number(req.body.accuracy),
    timestamp: typeof req.body?.timestamp === 'string' ? req.body.timestamp : undefined,
  });
  if (!parsed.success) {
    logger.warn(
      presenceStudioAuditLine(req, 'context/location.reject', {
        status: 400,
        error: validationErrorMessage(parsed.error),
      })
    );
    return res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
  }
  latestLocationContext = {
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    accuracy: parsed.data.accuracy,
    timestamp: parsed.data.timestamp || new Date().toISOString(),
    source: 'browser_geolocation',
  };
  logger.info(
    presenceStudioAuditLine(req, 'context/location.accept', {
      status: 200,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      accuracy: parsed.data.accuracy ?? 'none',
    })
  );
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
    transcript: Array.isArray(req.body?.transcript)
      ? req.body.transcript
      : [{ speaker: 'AI', text: 'Hello from Kyberion.' }],
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
