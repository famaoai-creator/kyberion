import express from 'express';
import { installProcessGuards } from '@agent/core/process-guards';
import {
  defineCatalog,
  getRegisteredEnvText,
  nowIso,
  parseSafeJsonObjectValue,
  setRegisteredEnv,
} from '@agent/core/foundation';
import { type VocabularyKey } from '@agent/core/t';
import { CloudflareOsSurface } from '@agent/core/cloudflare-os-surface';
import {
  createBrowserConversationSession,
  getActiveBrowserConversationSession,
  saveBrowserConversationSession,
} from '@agent/core/browser-conversation-session';
import {
  buildSurfaceLauncherNextActions,
  buildSurfaceLauncherRecommendations,
  getSurfaceDirectory,
  getSurfaceDirectorySummary,
  getSurfaceScenarioGuide,
} from '@agent/core/surface-ux';
import { getPresenceAvatarProfile } from '@agent/core/presence-avatar';
import { listDistillCandidateRecords } from '@agent/core/distill-candidate-registry';
import { listProjectRecords } from '@agent/core/project-registry';
import { listTaskSessions } from '@agent/core/task-session';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeLstat,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { toWireError } from '@agent/core/wire-error';
import { saveBrowserOnboardingVoiceSample } from '@agent/core/browser-onboarding';
import { startInRoomMinutesSession } from '@agent/core/in-room-minutes-recorder';
import { checkMeetingParticipationConsent } from '@agent/core/meeting-participation-coordinator';
import { createCompanionWebThemePack, webThemePackToCssVars } from '@agent/core/web-design-system';
import { installShellSpeechToTextBridgeIfAvailable } from '@agent/core/speech-to-text-bridge';
import { validateA2UIMessage as validateCoreA2UIMessage, type A2UIMessage } from '@agent/core/a2ui';
import { buildPresenceSurfaceFrame, type PresenceTimelineAdf } from '@agent/core/presence-surface';
import { parseGuspStimulusLine, type GuspStimulus } from '../../bridge/nexus-stimulus.js';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { z } from 'zod';
import {
  getPresenceStudioClientAddress,
  requirePresenceStudioAccess,
  requirePresenceStudioRateLimit,
  PresenceStudioViewerError,
  presenceStudioMinutesSessionStartSchema,
  narrowPresenceStudioTenant,
  presenceStudioHeadlessScope,
  resolvePresenceStudioViewerContext,
  validateLocalServiceUrl,
} from './security.js';
import {
  authorizePresenceOperation,
  buildPresenceOverviewA2UI,
  presenceManifestForViewer,
  presenceAvailableOperations,
  presenceEnvelope,
  readPresenceHeadlessOverview,
} from './headless.js';
import { probeMicCapture } from '@agent/core/mic-capture';
import { resolveEmailTriagePath } from '@agent/core/email-workflow';
import { collectDoctorReport } from '../../../scripts/run_doctor.js';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('presence-studio');

export type Client = express.Response;

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Project internal exceptions into the stable Presence Studio JSON boundary. */
export function presenceStudioWireError(error: unknown, status?: number) {
  const safe = toWireError(
    status === undefined ? error : { status, message: safeErrorMessage(error) }
  );
  return {
    ok: false,
    error: safe.message,
    error_code: safe.code,
    correlation_id: safe.correlation_id,
  };
}

export interface SurfaceSnapshot {
  catalogId?: string;
  title?: string;
  components: Array<{ id: string; type: string; props?: Record<string, unknown> }>;
  data: Record<string, unknown>;
}

export let surfaceLauncherCache: {
  fetchedAt: number;
  payload: Record<string, unknown>;
} | null = null;

export async function loadSurfaceLauncherPayload(): Promise<Record<string, unknown>> {
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

export function inferProjectIdForApprovalRecord(record: any): string | undefined {
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

export function buildApprovalInboxItem(record: any) {
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

export function buildOutcomeInboxItem(item: any) {
  const relatedCandidates = listDistillCandidateRecords()
    .filter((candidate) => (candidate.artifact_ids || []).includes(item.artifact_id))
    .slice(0, 3);
  return {
    ...item,
    downloadable:
      typeof item.path === 'string' &&
      isAllowedArtifactDownloadPath(item.path) &&
      resolveSafeExistingFile(item.path) !== null,
    distill_titles: relatedCandidates.map((candidate) => candidate.title),
    promoted_refs: relatedCandidates.map((candidate) => candidate.promoted_ref).filter(Boolean),
    work_loop: item?.work_loop,
  };
}

export interface PresenceStudioState {
  surfaces: Record<string, SurfaceSnapshot>;
  recentStimuli: Array<Record<string, unknown>>;
  lastUpdatedAt: string | null;
}

export interface BrowserRuntimeSessionSummary {
  session_id: string;
  active_tab_id?: string;
  cdp_url?: string;
  tabs?: Array<{
    tab_id: string;
    url?: string;
    title?: string;
    active?: boolean;
  }>;
  updated_at?: string;
  lease_status?: string;
  lease_expires_at?: string;
  retained?: boolean;
}

export interface BrowserSnapshotSummary {
  session_id: string;
  tab_id?: string;
  url?: string;
  title?: string;
  element_count?: number;
}

export interface PresenceBrowserRuntimeDataOptions {
  browserSessionDir?: string;
  browserSnapshotDir?: string;
}

const BROWSER_RUNTIME_SESSION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-runtime-session-summary.schema.json'
);
const BROWSER_SNAPSHOT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-snapshot-summary.schema.json'
);

function loadBrowserRuntimeRecordAtPath(
  filePath: string,
  schemaPath: string,
  catalogId: string
): Record<string, unknown> {
  const safePath = assertSafeRepositoryPath(filePath);
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`browser runtime record must be a regular file: ${filePath}`);
  }
  return defineCatalog<Record<string, unknown>>({
    id: catalogId,
    path: safePath,
    schema: schemaPath,
  }).load();
}

function optionalBrowserText(
  record: Record<string, unknown>,
  key: string
): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function parseBrowserRuntimeSessionSummary(value: unknown): BrowserRuntimeSessionSummary | null {
  let record: Record<string, unknown>;
  try {
    record = parseSafeJsonObjectValue(value, 'browser runtime session');
  } catch {
    return null;
  }

  const sessionId = record.session_id;
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const activeTabId = optionalBrowserText(record, 'active_tab_id');
  const cdpUrl = optionalBrowserText(record, 'cdp_url');
  const updatedAt = optionalBrowserText(record, 'updated_at');
  const leaseStatus = optionalBrowserText(record, 'lease_status');
  const leaseExpiresAt = optionalBrowserText(record, 'lease_expires_at');
  if (
    activeTabId === null ||
    cdpUrl === null ||
    updatedAt === null ||
    leaseStatus === null ||
    leaseExpiresAt === null
  ) {
    return null;
  }
  const retained =
    record.retained === undefined
      ? undefined
      : typeof record.retained === 'boolean'
        ? record.retained
        : null;
  if (retained === null) return null;

  let tabs: BrowserRuntimeSessionSummary['tabs'];
  if (record.tabs !== undefined) {
    if (!Array.isArray(record.tabs)) return null;
    tabs = [];
    for (const candidate of record.tabs) {
      let tab: Record<string, unknown>;
      try {
        tab = parseSafeJsonObjectValue(candidate, 'browser runtime session tab');
      } catch {
        return null;
      }
      if (typeof tab.tab_id !== 'string' || !tab.tab_id.trim()) return null;
      const url = optionalBrowserText(tab, 'url');
      const title = optionalBrowserText(tab, 'title');
      if (url === null || title === null) return null;
      const active =
        tab.active === undefined ? undefined : typeof tab.active === 'boolean' ? tab.active : null;
      if (active === null) return null;
      tabs.push({
        tab_id: tab.tab_id,
        ...(url === undefined ? {} : { url }),
        ...(title === undefined ? {} : { title }),
        ...(active === undefined ? {} : { active }),
      });
    }
  }

  return {
    session_id: sessionId,
    ...(activeTabId === undefined ? {} : { active_tab_id: activeTabId }),
    ...(cdpUrl === undefined ? {} : { cdp_url: cdpUrl }),
    ...(tabs === undefined ? {} : { tabs }),
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    ...(leaseStatus === undefined ? {} : { lease_status: leaseStatus }),
    ...(leaseExpiresAt === undefined ? {} : { lease_expires_at: leaseExpiresAt }),
    ...(retained === undefined ? {} : { retained }),
  };
}

function parseBrowserSnapshotSummary(value: unknown): BrowserSnapshotSummary | null {
  let record: Record<string, unknown>;
  try {
    record = parseSafeJsonObjectValue(value, 'browser snapshot');
  } catch {
    return null;
  }

  if (typeof record.session_id !== 'string' || !record.session_id.trim()) return null;
  const tabId = optionalBrowserText(record, 'tab_id');
  const url = optionalBrowserText(record, 'url');
  const title = optionalBrowserText(record, 'title');
  if (tabId === null || url === null || title === null) return null;
  const elementCount =
    record.element_count === undefined
      ? undefined
      : typeof record.element_count === 'number' &&
          Number.isInteger(record.element_count) &&
          record.element_count >= 0
        ? record.element_count
        : null;
  if (elementCount === null) return null;
  return {
    session_id: record.session_id,
    ...(tabId === undefined ? {} : { tab_id: tabId }),
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(elementCount === undefined ? {} : { element_count: elementCount }),
  };
}

export interface PresenceLocationContext {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: string;
  source: 'browser_geolocation';
}

export interface TaskSessionArtifactShape {
  output_path?: string;
}

export interface ArtifactRecordShape {
  artifact_id: string;
  kind: string;
  path?: string;
}

export interface VoiceMinutesArtifact {
  title: string;
  summary: string;
  decisions: string[];
  action_items: string[];
  open_questions: string[];
  minutes_markdown: string;
}

export interface EmailTriageArtifact {
  exists: boolean;
  path: string;
  updated_at: string | null;
  content: string;
}

export function validationErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message || 'Invalid request body';
}

export function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

export function presenceStudioAuditLine(
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

export const app: express.Express = express();
export const server = createServer(app);
export const staticDir = path.join(
  pathResolver.rootDir(),
  'presence/displays/presence-studio/static'
);
export const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
export const PORT = Number(getRegisteredEnvText('PRESENCE_STUDIO_PORT') || 3031);
export const HOST = getRegisteredEnvText('PRESENCE_STUDIO_HOST') || '127.0.0.1';
export const VOICE_HUB_URL = validateLocalServiceUrl(
  getRegisteredEnvText('VOICE_HUB_URL') || 'http://127.0.0.1:3032',
  'VOICE_HUB_URL'
);
export const sseClients = new Set<Client>();
export const activeTimelineTimers = new Map<string, NodeJS.Timeout[]>();
export const SPEECH_STATE_POLL_MS = Number(
  getRegisteredEnvText('PRESENCE_STUDIO_SPEECH_STATE_POLL_MS') || 400
);
export let latestSpeechSseState = 'idle';
export let speechStatePollInFlight = false;

export interface VoiceHubSpeechState {
  status: 'idle' | 'speaking';
  text?: string;
  startedAt?: number;
  pid?: number;
  engine_id?: string;
}

export interface VoiceHubSpeechStateResponse {
  ok: true;
  speech: VoiceHubSpeechState;
}

function isSafeRecord(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.keys(value as Record<string, unknown>).some((key) =>
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
  );
}

export function parseVoiceHubSpeechStateResponse(
  value: unknown
): VoiceHubSpeechStateResponse | undefined {
  if (!isSafeRecord(value) || value.ok !== true || !isSafeRecord(value.speech)) return undefined;
  const speech = value.speech;
  if (speech.status !== 'idle' && speech.status !== 'speaking') return undefined;
  const result: VoiceHubSpeechState = { status: speech.status };
  for (const key of ['text', 'engine_id'] as const) {
    if (speech[key] !== undefined && typeof speech[key] !== 'string') return undefined;
    if (typeof speech[key] === 'string') result[key] = speech[key];
  }
  for (const key of ['startedAt', 'pid'] as const) {
    if (speech[key] !== undefined) {
      if (
        typeof speech[key] !== 'number' ||
        !Number.isFinite(speech[key]) ||
        (key === 'pid' && (!Number.isInteger(speech[key]) || speech[key] < 1))
      )
        return undefined;
      result[key] = speech[key];
    }
  }
  return { ok: true, speech: result };
}

export function parseStimuliTailContent(content: string, limit = 20): GuspStimulus[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-Math.max(1, Math.floor(limit)))
    .map(parseGuspStimulusLine)
    .filter((stimulus): stimulus is GuspStimulus => stimulus !== undefined);
}

if (!getRegisteredEnvText('MISSION_ROLE')) {
  setRegisteredEnv('MISSION_ROLE', 'surface_runtime');
}
export const cloudflareOsSurface = new CloudflareOsSurface();

export const state: PresenceStudioState = {
  surfaces: {},
  recentStimuli: [],
  lastUpdatedAt: null,
};
export let latestLocationContext: PresenceLocationContext | null = null;

export function setLatestLocationContext(value: PresenceLocationContext | null): void {
  latestLocationContext = value;
}

export function findTaskSession(sessionId: string) {
  return listTaskSessions('presence').find((item) => item.session_id === sessionId) || null;
}

export function isAllowedTaskArtifactPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoot = path.resolve(pathResolver.sharedTmp('surface-task-sessions'));
  return resolved.startsWith(`${allowedRoot}${path.sep}`) || resolved === allowedRoot;
}

export function isAllowedArtifactDownloadPath(filePath: string): boolean {
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

export function isAllowedRuntimeRefPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || '').replace(/^\/+/, '');
  if (!/^active\/projects\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.active('projects'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

export function isAllowedKnowledgeRefPath(logicalPath: string): boolean {
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

/** Resolve an existing repository file only after rechecking its real entry type. */
export function resolveSafeExistingFile(filePath: string): string | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    return safeExistsSync(safePath) && safeLstat(safePath).isFile() ? safePath : null;
  } catch {
    return null;
  }
}

export function ensureStimuliDir(): void {
  const dir = path.dirname(STIMULI_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

export function toLineItems(value: unknown): string[] {
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

export function buildFallbackMinutesMarkdown(input: {
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

export function resolveVoiceMinutesDir(missionId?: string): string {
  if (missionId) {
    const missionDir = pathResolver.missionEvidenceDir(missionId);
    if (missionDir) return missionDir;
  }
  return pathResolver.shared('runtime/presence-studio/voice-notes');
}

export function readEmailTriageArtifact(): EmailTriageArtifact {
  const path = resolveEmailTriagePath();
  const safePath = resolveSafeExistingFile(path);
  if (!safePath) {
    return {
      exists: false,
      path,
      updated_at: null,
      content: '',
    };
  }
  const content = String(safeReadFile(safePath, { encoding: 'utf8' }) || '');
  return {
    exists: true,
    path,
    updated_at: nowIso(),
    content,
  };
}

export function rememberStimulus(stimulus: Record<string, unknown>): void {
  state.recentStimuli.push(stimulus);
  state.recentStimuli = state.recentStimuli.slice(-20);
  state.lastUpdatedAt = nowIso();
}

export function validateA2UIMessage(value: unknown): A2UIMessage {
  return validateCoreA2UIMessage(value);
}

export function applyA2UIMessage(message: A2UIMessage): void {
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

  state.lastUpdatedAt = nowIso();
}

export function getSurfaceData(surfaceId: string): Record<string, unknown> {
  return state.surfaces[surfaceId]?.data || {};
}

export function rebuildPresenceSurface(surfaceId: string): void {
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

export function updatePresenceSurface(surfaceId: string, patch: Record<string, unknown>): void {
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

export function clearTimeline(surfaceId: string): void {
  const timers = activeTimelineTimers.get(surfaceId) || [];
  for (const timer of timers) clearTimeout(timer);
  activeTimelineTimers.delete(surfaceId);
}

export function applyTimelineEvent(
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
      logger.warn(`[presence-studio] unsupported timeline op ${event.op}`);
  }
  state.lastUpdatedAt = nowIso();
  emitState();
}

export function playTimeline(timeline: PresenceTimelineAdf): {
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

export function broadcast(event: string, payload: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(chunk);
  }
}

export function emitState(): void {
  broadcast('state', state);
}

export async function pollVoiceHubSpeechStateForSse(): Promise<void> {
  if (speechStatePollInFlight) return;
  speechStatePollInFlight = true;
  try {
    const response = await fetch(`${VOICE_HUB_URL}/api/speech/state`);
    if (!response.ok) return;
    const payload = parseVoiceHubSpeechStateResponse(await response.json().catch(() => null));
    if (!payload) return;
    const nextState = payload.speech.status;
    if (nextState === latestSpeechSseState) return;
    latestSpeechSseState = nextState;
    broadcast('speech_state', {
      ok: true,
      speech: payload.speech,
    });
  } catch {
    // Best effort only.
  } finally {
    speechStatePollInFlight = false;
  }
}

export function listBrowserRuntimeSessions(
  options: PresenceBrowserRuntimeDataOptions = {}
): BrowserRuntimeSessionSummary[] {
  const dir = options.browserSessionDir || pathResolver.shared('runtime/browser/sessions');
  try {
    const safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
    if (!safeExistsSync(safeDir) || !safeLstat(safeDir).isDirectory()) return [];
    return safeReaddir(safeDir)
      .filter((entry) => entry.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const filePath = assertSafeRepositoryPath(path.join(safeDir, entry));
          if (!safeLstat(filePath).isFile()) return [];
          const session = parseBrowserRuntimeSessionSummary(
            loadBrowserRuntimeRecordAtPath(
              filePath,
              BROWSER_RUNTIME_SESSION_SCHEMA_PATH,
              'browser-runtime-session-summary'
            )
          );
          return session ? [session] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  } catch {
    return [];
  }
}

export function loadBrowserSnapshotSummary(
  sessionId: string,
  options: PresenceBrowserRuntimeDataOptions = {}
): BrowserSnapshotSummary | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sessionId)) return null;
  try {
    const dir = options.browserSnapshotDir || pathResolver.shared('runtime/browser/snapshots');
    const filePath = assertSafeRepositoryPath(path.join(dir, `${sessionId}.json`));
    if (!safeLstat(filePath).isFile()) return null;
    return parseBrowserSnapshotSummary(
      loadBrowserRuntimeRecordAtPath(
        filePath,
        BROWSER_SNAPSHOT_SCHEMA_PATH,
        'browser-snapshot-summary'
      )
    );
  } catch {
    return null;
  }
}

export function pickPresenceBrowserRuntimeSession(
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
      const hasReconnectPath = Boolean(item.cdp_url);
      const leaseExpiresAt =
        typeof item.lease_expires_at === 'string' ? Date.parse(item.lease_expires_at) : Number.NaN;
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

export function ensurePresenceBrowserConversationSession(): ReturnType<
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

export function bootstrapState(): void {
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

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.post(
  '/api/onboarding/voice-sample',
  requirePresenceStudioRateLimit(),
  requirePresenceStudioAccess(),
  express.raw({
    type: ['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4'],
    limit: '12mb',
  }),
  (req, res) => {
    try {
      const profileId = String(req.query.profile_id || '').trim();
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = saveBrowserOnboardingVoiceSample({
        profileId,
        contentType: String(req.headers['content-type'] || ''),
        data,
      });
      logger.info(
        presenceStudioAuditLine(req, 'onboarding/voice-sample.complete', {
          profile_id: profileId,
          bytes: result.bytes,
          status: 201,
        })
      );
      res.status(201).json({ ok: true, ...result });
    } catch (error: any) {
      logger.warn(
        presenceStudioAuditLine(req, 'onboarding/voice-sample.reject', {
          status: 400,
          error: error?.message || String(error),
        })
      );
      res.status(400).json(presenceStudioWireError(error, 400));
    }
  }
);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(staticDir));
app.use(['/api', '/a2ui'], requirePresenceStudioRateLimit(), requirePresenceStudioAccess());

app.get('/api/headless/manifest', (req, res) => {
  try {
    const viewer = resolvePresenceStudioViewerContext(req);
    res.json({
      ok: true,
      manifest: presenceManifestForViewer(viewer),
      viewer: {
        scope: presenceStudioHeadlessScope(viewer),
        available_operations: presenceAvailableOperations(viewer),
      },
    });
  } catch (error) {
    const status = error instanceof PresenceStudioViewerError ? error.status : 500;
    res.status(status).json(presenceStudioWireError(error, status));
  }
});

app.get('/api/headless/overview', (req, res) => {
  try {
    const viewer = resolvePresenceStudioViewerContext(req);
    const requestedTenant = typeof req.query.tenant === 'string' ? req.query.tenant : undefined;
    authorizePresenceOperation(viewer, 'presence.overview.read', {
      tenantSlug: requestedTenant,
    });
    const scoped = narrowPresenceStudioTenant(viewer, requestedTenant);
    const scopedViewer = { ...viewer, tenantSlugs: scoped };
    res.json(
      presenceEnvelope('overview', readPresenceHeadlessOverview(scopedViewer), scopedViewer)
    );
  } catch (error) {
    const status = error instanceof PresenceStudioViewerError ? error.status : 500;
    res.status(status).json(presenceStudioWireError(error, status));
  }
});

app.get('/api/headless/a2ui/overview', (req, res) => {
  try {
    const viewer = resolvePresenceStudioViewerContext(req);
    const requestedTenant = typeof req.query.tenant === 'string' ? req.query.tenant : undefined;
    authorizePresenceOperation(viewer, 'presence.overview.a2ui', {
      tenantSlug: requestedTenant,
    });
    const scoped = narrowPresenceStudioTenant(viewer, requestedTenant);
    const scopedViewer = { ...viewer, tenantSlugs: scoped };
    const overview = readPresenceHeadlessOverview(scopedViewer);
    res.json(
      presenceEnvelope(
        'overview',
        { source_resource: 'overview', a2ui: buildPresenceOverviewA2UI(overview) },
        scopedViewer
      )
    );
  } catch (error) {
    const status = error instanceof PresenceStudioViewerError ? error.status : 500;
    res.status(status).json(presenceStudioWireError(error, status));
  }
});

app.get('/onboarding', (_req, res) => {
  res.sendFile(path.join(staticDir, 'onboarding.html'));
});

// Browsers always probe /favicon.ico — return 204 to silence noisy console 404.
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

// --- In-room minutes recording (マイク録音 → 自動議事録) -------------------
export let inRoomMinutesSession: Awaited<ReturnType<typeof startInRoomMinutesSession>> | null =
  null;
export let inRoomMinutesMissionId: string | null = null;

app.post('/api/minutes/session/start', async (req, res) => {
  try {
    if (inRoomMinutesSession) {
      res.status(409).json({ ok: false, error: `既に録音中です (${inRoomMinutesMissionId})` });
      return;
    }
    const parsed = presenceStudioMinutesSessionStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: validationErrorMessage(parsed.error) });
      return;
    }
    const { missionId, title, language, device } = parsed.data;
    const probe = probeMicCapture();
    if (!probe.available) {
      res.status(503).json({ ok: false, error: probe.reason || 'マイクが利用できません' });
      return;
    }
    const consent = checkMeetingParticipationConsent({
      mission_id: missionId,
      purpose: 'recording',
    });
    if (!consent.allowed) {
      res.status(412).json({
        ok: false,
        error: consent.reason || 'recording consent is required',
        nextAction: `pnpm meeting:consent grant --mission ${missionId} --operator <handle>`,
      });
      return;
    }
    installShellSpeechToTextBridgeIfAvailable();
    try {
      const targetDir = pathResolver.missionDir(missionId);
      const evidenceDir = path.join(targetDir, 'evidence');
      safeMkdir(evidenceDir, { recursive: true });
      const consentPath = path.join(evidenceDir, 'voice-consent.json');
      safeWriteFile(
        consentPath,
        JSON.stringify(
          {
            consent: 'granted',
            mission_id: missionId,
            operator_handle: 'presence-studio-user',
            granted_at: nowIso(),
          },
          null,
          2
        ),
        { encoding: 'utf8' }
      );
    } catch (err) {
      logger.warn(`[presence-studio] failed to write voice consent: ${err}`);
    }
    inRoomMinutesSession = await startInRoomMinutesSession({
      missionId,
      meetingTitle: title,
      language: language || 'ja',
      mic: { device },
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
    res.status(500).json(presenceStudioWireError(err, 500));
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
    res.status(500).json(presenceStudioWireError(err, 500));
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
  // The shared derivation is now theme-aware (light themes get a faint ink
  // tint instead of the dark-console panel), so the local --kb-panel-bg
  // override this used to carry is no longer needed.
  const cssVars = webThemePackToCssVars(createCompanionWebThemePack());
  const body = `:root {\n${Object.entries(cssVars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')}\n}\n`;
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
});

export const PRESENCE_STUDIO_VOCABULARY_KEYS = [
  'presence_studio:record_mission_placeholder',
  'presence_studio:record_start',
  'presence_studio:record_stop',
  'presence_studio:live_transcript',
  'presence_studio:record_hint',
  'presence_studio:record_panel_label',
  'presence_studio:notes_panel_label',
  'presence_studio:notes_placeholder',
  'presence_studio:meeting_title_placeholder',
  'presence_studio:create_minutes',
  'presence_studio:copy_notes',
  'presence_studio:restore_draft',
  'presence_studio:clear_notes',
  'presence_studio:notes_hint',
  'presence_studio:email_triage_label',
  'presence_studio:email_triage_empty',
  'presence_studio:refresh_triage',
  'presence_studio:copy_draft',
  'presence_studio:email_triage_hint',
  'presence_studio:email_reply_label',
  'presence_studio:email_auth_checking',
  'presence_studio:account_auto',
  'presence_studio:recipient_placeholder',
  'presence_studio:subject_placeholder',
  'presence_studio:tone_clear',
  'presence_studio:tone_warm',
  'presence_studio:tone_firm',
  'presence_studio:reply_message_id_placeholder',
  'presence_studio:mode_new',
  'presence_studio:mode_reply',
  'presence_studio:mode_reply_all',
  'presence_studio:email_draft_empty',
  'presence_studio:create_reply_draft',
  'presence_studio:create_account_draft',
  'presence_studio:send_approved_email',
  'presence_studio:refresh_auth',
  'presence_studio:reload_draft',
  'presence_studio:copy_reply',
  'presence_studio:email_draft_hint',
  'presence_studio:approval_label',
  'presence_studio:outcomes_label',
  'presence_studio:requested_work_label',
  'presence_studio:browser_label',
  'presence_studio:prepare_browser',
  'presence_studio:browser_task_hint',
  'presence_studio:recording_started',
  'presence_studio:recording_stopping',
  'presence_studio:minutes_created',
  'presence_studio:recording_short',
  'tui:tui_cockpit_authority_autonomous',
  'tui:tui_cockpit_authority_approval',
  'tui:tui_cockpit_authority_clarification',
  'tui:tui_cockpit_outcome_answer',
  'tui:tui_cockpit_outcome_artifact',
  'tui:tui_cockpit_outcome_approval_ready_plan',
  'tui:tui_cockpit_outcome_service_change',
  'tui:tui_cockpit_outcome_status_report',
] as const satisfies readonly VocabularyKey[];
