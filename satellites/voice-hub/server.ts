import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import {
  buildPresenceAssistantReplyTimeline,
  applyBrowserConversationCommand,
  attachArtifactRecordToTaskSession,
  buildProjectBootstrapWorkItems,
  classifyBrowserConversationCommand,
  classifySurfaceQueryIntent,
  classifyTaskSessionIntent,
  confirmBrowserConversationCandidate,
  createTaskSession,
  createBrowserConversationCommand,
  executeBrowserConversationAction,
  createArtifactRecord,
  createDistillCandidateRecord,
  listServiceBindingRecords,
  buildPresenceVoiceIngressTimeline,
  createSurfaceAsyncRequest,
  createPresenceVoiceStimulus,
  deriveSurfaceDelegationReceiver,
  enqueueSurfaceNotification,
  estimateSpeechDurationMs,
  extractSurfaceBlocks,
  getSurfaceAgentCatalogEntry,
  getSurfaceAsyncRequest,
  getVoiceTtsLanguageConfig,
  getActiveBrowserConversationSession,
  getActiveTaskSession,
  getSurfaceQueryProviderConfig,
  extractSurfaceKnowledgeQuery,
  extractSurfaceWebSearchQuery,
  listAgentRuntimeSnapshots,
  listDistillCandidateRecords,
  loadProjectRecord,
  resolveProjectRecordForText,
  saveProjectRecord,
  saveMissionSeedRecord,
  saveServiceBindingRecord,
  listSurfaceAsyncRequests,
  listSurfaceNotifications,
  loadSurfaceManifest,
  loadSurfaceState,
  logger,
  parseSurfaceActionRoutingDecision,
  normalizeSurfaceDefinition,
  pathResolver,
  parseVoiceSttBackend,
  probeSurfaceHealth,
  readSurfaceLogTail,
  reflectPresenceAgentReply,
  resolveWorkDesign,
  resolveVoiceSttBackendOrder,
  resolveVoiceSttServerConfig,
  runSurfaceConversation,
  safeExec,
  safeReadFile,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  updateSurfaceAsyncRequest,
  safeWriteFile,
  saveArtifactRecord,
  saveDistillCandidateRecord,
  updateTaskSession,
  saveTaskSession,
  recordTaskSessionHistory,
  createBrowserConversationSession,
  saveBrowserConversationSession,
} from '@agent/core';

interface VoiceHubRecord {
  id: string;
  request_id?: string;
  text: string;
  source_id: string;
  intent: string;
  ts: string;
}

interface VoiceHubResponseRecord {
  statusCode: number;
  body: Record<string, unknown>;
  createdAt: number;
}

interface SpeechPlaybackState {
  status: 'idle' | 'speaking';
  text?: string;
  startedAt?: number;
  pid?: number;
}

interface RecentSpeechGuardState {
  text?: string;
  finishedAt?: number;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface PresenceLocationContext {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: string;
  source?: string;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

interface TaskSessionShape {
  session_id: string;
  surface: 'presence' | 'slack' | 'terminal' | 'chronos' | 'web';
  task_type: string;
  status: string;
  goal: {
    summary: string;
    success_condition: string;
  };
  project_context?: {
    project_id?: string;
    project_name?: string;
    tier?: 'personal' | 'confidential' | 'public';
    service_bindings?: string[];
    locale?: string;
  };
  requirements?: {
    missing?: string[];
    collected?: Record<string, unknown>;
  };
  control: {
    interruptible: boolean;
    requires_approval: boolean;
    awaiting_user_input: boolean;
  };
  history: Array<{
    ts: string;
    type: string;
    text: string;
  }>;
  payload?: Record<string, unknown>;
}

function inferDistillTargetKind(taskType: string): 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template' {
  if (taskType === 'presentation_deck' || taskType === 'workbook_wbs') return 'pattern';
  if (taskType === 'report_document') return 'report_template';
  if (taskType === 'service_operation') return 'sop_candidate';
  return 'knowledge_hint';
}

function buildDistillCandidateMetadata(session: TaskSessionShape, previewText: string, artifactId: string): Record<string, unknown> {
  const payload = session.payload || {};
  const projectName = session.project_context?.project_name || 'current project';
  if (session.task_type === 'analysis' && payload.bootstrap_kind === 'project_bootstrap') {
    const projectId = String(session.project_context?.project_id || '').trim();
    const project = projectId ? loadProjectRecord(projectId) : null;
    const workItems = Array.isArray(project?.bootstrap_work_items) ? project.bootstrap_work_items : [];
    const nextWork = workItems.find((item) => item.status === 'active') || workItems[1] || workItems[0] || null;
    const seedTitles = workItems
      .filter((item) => item.kind === 'mission_seed')
      .map((item) => item.title)
      .filter(Boolean);
    const kickoffBrief = String(payload.project_brief || project?.kickoff_brief || '').trim();
    return {
      preview_text: previewText,
      task_type: session.task_type,
      bootstrap_kind: 'project_bootstrap',
      project_name: projectName,
      project_brief: kickoffBrief,
      hint_scope: 'project bootstrap',
      hint_triggers: [
        session.goal?.summary || 'project kickoff',
        kickoffBrief,
        projectName,
      ].filter(Boolean),
      recommended_refs: [
        `task_session:${session.session_id}`,
        `artifact:${artifactId}`,
        ...(projectId ? [`project:${projectId}`] : []),
        ...seedTitles.map((title) => `mission_seed:${title}`),
      ],
      applicability: [
        'project bootstrap',
        projectName,
        session.project_context?.tier || 'confidential',
      ],
      reusable_steps: [
        'Capture the project brief, audience, and first deliverable.',
        'Translate the brief into the first bounded work items.',
        'Promote durable work candidates for architecture, implementation, and verification.',
      ],
      expected_outcome: nextWork
        ? `${projectName} kickoff completes with ${nextWork.title} as the next active work.`
        : previewText || `${projectName} kickoff is structured for follow-on work.`,
      template_sections: [
        'Project Goal',
        'Audience',
        'Initial Deliverable',
        'Bootstrap Work Items',
        'Next Durable Work',
      ],
      audience: 'project lead and leadership',
      output_format: 'project kickoff brief',
    };
  }
  if (session.task_type === 'presentation_deck') {
    const purpose = String(payload.deck_purpose || 'proposal');
    return {
      preview_text: previewText,
      task_type: session.task_type,
      project_name: projectName,
      applicability: [
        'presentation delivery',
        purpose,
        projectName,
      ],
      reusable_steps: [
        'Capture the user goal, audience, and success condition.',
        'Translate the request into an executive slide storyline.',
        'Generate the PPTX artifact and verify the result.',
      ],
      expected_outcome: previewText || 'A reusable presentation artifact is delivered.',
    };
  }
  if (session.task_type === 'workbook_wbs') {
    return {
      preview_text: previewText,
      task_type: session.task_type,
      project_name: projectName,
      applicability: [
        'work breakdown structure',
        String(payload.granularity || 'work_package'),
        projectName,
      ],
      reusable_steps: [
        'Resolve the project scope and desired WBS granularity.',
        'Translate the work into a structured workbook layout.',
        'Generate the XLSX artifact and confirm it can be reused.',
      ],
      expected_outcome: previewText || 'A reusable workbook artifact is delivered.',
    };
  }
  if (session.task_type === 'report_document') {
    const reportKind = String(payload.report_kind || 'summary');
    const format = String(payload.format || 'docx');
    return {
      preview_text: previewText,
      task_type: session.task_type,
      project_name: projectName,
      template_sections: reportKind === 'status'
        ? ['Summary', 'Current Status', 'Risks', 'Next Actions']
        : reportKind === 'spec'
          ? ['Overview', 'Requirements', 'Constraints', 'Acceptance Criteria']
          : reportKind === 'proposal'
            ? ['Summary', 'Context', 'Recommendation', 'Next Step']
            : ['Summary', 'Findings', 'Implications', 'Next Actions'],
      audience: reportKind === 'proposal' ? 'decision makers' : 'internal stakeholders',
      output_format: format,
    };
  }
  if (session.task_type === 'service_operation') {
    const operation = String(payload.operation || 'status');
    const serviceName = String(payload.service_name || 'service');
    return {
      preview_text: previewText,
      task_type: session.task_type,
      project_name: projectName,
      procedure_steps: operation === 'logs'
        ? [
            `Resolve the managed surface for ${serviceName}.`,
            'Read the latest governed logs.',
            'Summarize the most relevant operational signal.',
          ]
        : operation === 'status'
          ? [
              `Resolve the managed surface for ${serviceName}.`,
              'Inspect runtime state and health evidence.',
              'Summarize the observed service status.',
            ]
          : [
              `Resolve the managed surface for ${serviceName}.`,
              `Request the controlled ${operation} action.`,
              'Confirm the post-action state and report the outcome.',
            ],
      safety_notes: [
        'Require explicit approval for start, stop, or restart actions.',
        'Capture before/after evidence and keep the summary concise.',
      ],
      escalation_conditions: [
        'Managed surface could not be resolved.',
        'The runtime action failed or timed out.',
        'The post-action state does not match the requested operation.',
      ],
    };
  }
  return {
    preview_text: previewText,
    task_type: session.task_type,
    project_name: projectName,
    artifact_id: artifactId,
    hint_scope: session.task_type,
    hint_triggers: [
      session.goal?.summary || session.task_type,
      session.history[0]?.text || '',
    ].filter(Boolean),
    recommended_refs: [
      `task_session:${session.session_id}`,
      `artifact:${artifactId}`,
    ],
  };
}

function maybeCreateDistillCandidate(session: TaskSessionShape, artifactId: string, previewText: string) {
  const title = session.task_type === 'presentation_deck'
    ? 'Promote reusable presentation workflow'
    : session.task_type === 'report_document'
      ? 'Promote reusable reporting workflow'
      : session.task_type === 'workbook_wbs'
        ? 'Promote reusable workbook workflow'
        : session.task_type === 'service_operation'
          ? 'Promote operational service handling guidance'
          : 'Promote reusable work pattern';
  const summary = session.task_type === 'service_operation'
    ? `${session.goal?.summary || session.task_type} produced operational output that may be worth promoting into a governed SOP candidate.`
    : `${session.goal?.summary || session.task_type} completed successfully and may be reusable as a governed ${inferDistillTargetKind(session.task_type)}.`;
  const candidate = createDistillCandidateRecord({
    source_type: 'task_session',
    tier: session.project_context?.tier || 'confidential',
    project_id: session.project_context?.project_id,
    task_session_id: session.session_id,
    artifact_ids: [artifactId],
    title,
    summary,
    status: 'proposed',
    target_kind: inferDistillTargetKind(session.task_type),
    specialist_id: resolveWorkDesign({
      taskType: session.task_type,
      shape: 'task_session',
      tier: session.project_context?.tier || 'confidential',
    }).primary_specialist?.id,
    locale: session.project_context?.locale,
    evidence_refs: [`task_session:${session.session_id}`, `artifact:${artifactId}`],
    metadata: buildDistillCandidateMetadata(session, previewText, artifactId),
  });
  saveDistillCandidateRecord(candidate);
}

function buildLearnedHintText(input: {
  language: 'ja' | 'en';
  reusableRefs?: Array<{ title?: string }>;
  projectId?: string;
}): string {
  const designRefs = Array.isArray(input.reusableRefs) ? input.reusableRefs : [];
  const projectRefs = input.projectId
    ? listDistillCandidateRecords()
        .filter((candidate) => candidate.project_id === input.projectId && candidate.promoted_ref)
        .slice(0, 2)
        .map((candidate) => ({ title: candidate.title }))
    : [];
  const titles = [...designRefs, ...projectRefs]
    .map((item) => String(item.title || '').trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 2);
  if (titles.length === 0) return '';
  if (input.language === 'ja') {
    return `過去の learned pattern（${titles.join('、')}）も参照して進めます。`;
  }
  return `I will also reuse learned patterns such as ${titles.join(', ')}. `;
}

interface SurfaceRouterContext {
  sessionKey: string;
}

interface HeuristicSurfaceRoutingCandidate {
  decision: ReturnType<typeof buildFallbackSurfaceRoutingDecision>;
  reason: string;
}

const app = express();
const server = createServer(app);

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const NATIVE_STT_SCRIPT = pathResolver.resolve('satellites/voice-hub/native-stt.swift');
const WHISPER_CPP_DIR = pathResolver.resolve('active/shared/tmp/whisper.cpp');
const WHISPER_CLI_PATH = pathResolver.resolve('active/shared/tmp/whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL_PATH = pathResolver.resolve('active/shared/tmp/whisper.cpp/models/ggml-small.bin');
const PORT = Number(process.env.VOICE_HUB_PORT || 3032);
const HOST = process.env.VOICE_HUB_HOST || '127.0.0.1';
const PRESENCE_STUDIO_URL = process.env.PRESENCE_STUDIO_URL || 'http://127.0.0.1:3031';
const PRESENCE_SURFACE_WARMUP_QUERY = 'Reply with exactly: Ready.';

process.env.MISSION_ROLE ||= 'surface_runtime';

const recent: VoiceHubRecord[] = [];
const recentResponses = new Map<string, VoiceHubResponseRecord>();
const inflightResponses = new Map<string, Promise<VoiceHubResponseRecord>>();
const conversationMemory = new Map<string, ConversationTurn[]>();
const activeTaskExecutions = new Set<string>();
let activeSpeechProcess: ChildProcessWithoutNullStreams | null = null;
let activeSpeechState: SpeechPlaybackState = { status: 'idle' };
let recentSpeechGuardState: RecentSpeechGuardState = {};

function normalizeSpeechEchoText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[「」『』（）()［］\[\]【】.,!?！？。、・:：;；"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldSuppressEchoTranscript(text: string): boolean {
  const normalizedInput = normalizeSpeechEchoText(text);
  if (!normalizedInput) return false;

  const activeSpeechText = normalizeSpeechEchoText(activeSpeechState.text || '');
  if (activeSpeechState.status === 'speaking' && activeSpeechText && (
    normalizedInput === activeSpeechText ||
    activeSpeechText.includes(normalizedInput) ||
    normalizedInput.includes(activeSpeechText)
  )) {
    return true;
  }

  const recentSpeechText = normalizeSpeechEchoText(recentSpeechGuardState.text || '');
  const finishedAt = recentSpeechGuardState.finishedAt || 0;
  if (recentSpeechText && finishedAt > 0 && Date.now() - finishedAt < 8000 && (
    normalizedInput === recentSpeechText ||
    recentSpeechText.includes(normalizedInput) ||
    normalizedInput.includes(recentSpeechText)
  )) {
    return true;
  }

  return false;
}

function requestFingerprint(input: { text: string; intent: string; sourceId: string; speaker: string }): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

function conversationSessionKey(sourceId: string, speaker: string): string {
  return `${sourceId}::${speaker}`;
}

function rememberConversationTurn(sessionKey: string, role: 'user' | 'assistant', text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const turns = conversationMemory.get(sessionKey) || [];
  turns.push({ role, text: trimmed });
  conversationMemory.set(sessionKey, turns.slice(-8));
}

function formatConversationHistory(sessionKey: string): string {
  const turns = conversationMemory.get(sessionKey) || [];
  if (turns.length === 0) return 'No prior conversation turns.';
  return turns
    .slice(-6)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n');
}

function buildPresenceConversationPrompt(userText: string, sessionKey: string): string {
  return [
    'You are replying on the live voice surface as the primary conversational agent.',
    'Return only the final spoken reply.',
    'Answer the user directly in their language.',
    'Keep it concise, natural, and useful for speech playback.',
    'Maintain conversational continuity with the recent turns when relevant.',
    'Do not restate the user text unless explicitly helpful.',
    'Do not say "I heard you say" or paraphrase the input mechanically.',
    'If the request clearly needs heavier execution, say that briefly.',
    'Do not claim that another agent will handle the request unless the system has already routed it asynchronously.',
    'If live data or external lookup is unavailable on this surface, say that plainly instead of pretending to fetch it.',
    '',
    'Recent conversation:',
    formatConversationHistory(sessionKey),
    '',
    `User: ${userText}`,
  ].join('\n');
}

function buildSurfaceRoutingPrompt(
  userText: string,
  context: SurfaceRouterContext,
  candidates: HeuristicSurfaceRoutingCandidate[],
): string {
  const browserSession = getActiveBrowserConversationSession('presence');
  const taskSession = getActiveTaskSession('presence') as TaskSessionShape | null;
  const browserContext = browserSession
    ? `Active browser session: ${browserSession.target?.url || 'unknown url'} (${browserSession.goal.summary}).`
    : 'Active browser session: none.';
  const taskContext = taskSession
    ? `Active task session: ${taskSession.task_type} (${taskSession.status}).`
    : 'Active task session: none.';

  return [
    'You are the routing brain for a realtime surface.',
    'Decide which operator should handle the user utterance.',
    'Return JSON only. No prose. No markdown besides optional json fence.',
    'Use this exact schema:',
    '{"kind":"surface_action_routing","intent":"conversation|browser_open_site|browser_step|task_session|surface_query|async_delegate","confidence":0.0,"target_operator":"presence-surface-agent|browser-operator|task-session|surface-query|chronos-mirror|nerve-agent","browser":{"url":"optional","site_query":"optional"},"task":{"task_type":"optional"},"query":{"query_type":"location|weather|knowledge_search|web_search","text":"optional"},"delegate":{"receiver":"chronos-mirror|nerve-agent","reason":"optional"}}',
    'Rules:',
    '- browser_open_site: open a site, launch/open browser, navigate to a website, search and show a website.',
    '- browser_step: click/fill/press/continue/that/first item style instructions for an already visible browser session.',
    '- task_session: durable work like creating PowerPoint, report, WBS, photo capture, service operations.',
    '- surface_query: weather, location, web search, knowledge search.',
    '- async_delegate: deep mission/state work for chronos-mirror or nerve-agent.',
    '- conversation: everything else.',
    '- If the user mentions a site or publication name without a URL, prefer browser_open_site with browser.site_query.',
    '- If there is an active browser session and the utterance sounds like a step on the current page, prefer browser_step.',
    '- Prefer the heuristic top candidate unless conversation context strongly contradicts it.',
    '',
    browserContext,
    taskContext,
    'Heuristic candidates:',
    candidates.length > 0
      ? candidates.map((entry, index) => `${index + 1}. ${entry.decision?.intent} because ${entry.reason}`).join('\n')
      : 'none',
    'Recent conversation:',
    formatConversationHistory(context.sessionKey),
    '',
    `User: ${userText}`,
  ].join('\n');
}

async function routeSurfaceActionWithLlm(
  userText: string,
  context: SurfaceRouterContext,
  candidates: HeuristicSurfaceRoutingCandidate[],
) {
  try {
    const response = await Promise.race([
      runSurfaceConversation({
        agentId: 'sovereign-brain',
        query: buildSurfaceRoutingPrompt(userText, context, candidates),
        senderAgentId: 'kyberion:voice-hub',
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('surface_action_routing_timeout')), 3500);
      }),
    ]);
    const parsed = parseSurfaceActionRoutingDecision(response.text || '');
    logger.info(`[voice-hub] surface action router result: ${JSON.stringify({
      userText,
      candidates: candidates.map((entry) => entry.decision?.intent),
      parsed,
    })}`);
    return parsed;
  } catch (error: any) {
    logger.warn(`[voice-hub] surface action routing failed: ${error?.message || error}`);
    return null;
  }
}

function buildFallbackSurfaceRoutingDecision(userText: string) {
  const trimmed = userText.trim();
  const queryIntent = classifySurfaceQueryIntent(trimmed);
  if (queryIntent) {
    return {
      kind: 'surface_action_routing' as const,
      intent: 'surface_query' as const,
      confidence: 0.55,
      target_operator: 'surface-query' as const,
      query: {
        query_type: queryIntent,
        text: trimmed,
      },
    };
  }

  const taskIntent = classifyTaskSessionIntent(trimmed);
  if (taskIntent) {
    return {
      kind: 'surface_action_routing' as const,
      intent: 'task_session' as const,
      confidence: 0.6,
      target_operator: 'task-session' as const,
      task: {
        task_type: taskIntent.taskType,
      },
    };
  }

  const activeBrowserSession = getActiveBrowserConversationSession('presence');
  if (activeBrowserSession && /(クリック|押して|開いて|入力|入れて|選んで|1つ目|一つ目|それ|続けて|enter|click|press|fill|type|open that)/i.test(trimmed)) {
    return {
      kind: 'surface_action_routing' as const,
      intent: 'browser_step' as const,
      confidence: 0.55,
      target_operator: 'browser-operator' as const,
    };
  }

  if (/(ブラウザ|browser).*(開いて|立ち上げ|表示|見て)|サイトを見て|サイトを開いて|webサイト|website|open .*site|show .*site|go to/i.test(trimmed)) {
    const urlMatch = trimmed.match(/https?:\/\/\S+/i)?.[0];
    const siteQuery = normalizeBrowserSiteQuery(trimmed);
    return {
      kind: 'surface_action_routing' as const,
      intent: 'browser_open_site' as const,
      confidence: 0.5,
      target_operator: 'browser-operator' as const,
      browser: {
        url: urlMatch,
        site_query: siteQuery || trimmed,
      },
    };
  }

  const receiver = deriveSurfaceDelegationReceiver(trimmed);
  if (receiver) {
    return {
      kind: 'surface_action_routing' as const,
      intent: 'async_delegate' as const,
      confidence: 0.5,
      target_operator: receiver,
      delegate: {
        receiver,
      },
    };
  }

  return null;
}

function buildHeuristicSurfaceRoutingCandidates(userText: string): HeuristicSurfaceRoutingCandidate[] {
  const candidates: HeuristicSurfaceRoutingCandidate[] = [];
  const fallback = buildFallbackSurfaceRoutingDecision(userText);
  if (fallback) {
    candidates.push({
      decision: fallback,
      reason: 'fast deterministic classification from current utterance and active sessions',
    });
  }

  const trimmed = userText.trim();
  if (/(新聞|nikkei|日経|サイト|website|webサイト)/i.test(trimmed)) {
    const siteQuery = normalizeBrowserSiteQuery(trimmed);
    candidates.unshift({
      decision: {
        kind: 'surface_action_routing',
        intent: 'browser_open_site',
        confidence: 0.72,
        target_operator: 'browser-operator',
        browser: {
          url: undefined,
          site_query: siteQuery || trimmed,
        },
      },
      reason: 'site/publication mention implies browser navigation',
    });
  }

  const activeBrowserSession = getActiveBrowserConversationSession('presence');
  if (activeBrowserSession && /(押して|クリック|それ|1つ目|一つ目|入力|enter|click|press|type|fill)/i.test(trimmed)) {
    candidates.unshift({
      decision: {
        kind: 'surface_action_routing',
        intent: 'browser_step',
        confidence: 0.75,
        target_operator: 'browser-operator',
      },
      reason: 'active browser session plus step-like utterance',
    });
  }

  const deduped: HeuristicSurfaceRoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of candidates) {
    if (!entry.decision) continue;
    const key = JSON.stringify(entry.decision);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function pruneRecentResponses(now = Date.now()): void {
  for (const [requestId, record] of recentResponses.entries()) {
    if (now - record.createdAt > 60_000) {
      recentResponses.delete(requestId);
    }
  }
}

async function listNativeInputDevices(): Promise<{ ok: boolean; devices: Array<{ id: number; uid: string; name: string; isDefault: boolean }>; defaultDeviceUID?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('swift', [NATIVE_STT_SCRIPT, '--list-devices'], {
      cwd: pathResolver.rootDir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const raw = stdout.trim();
      if (!raw) return reject(new Error(stderr.trim() || `native_device_list_failed_${code}`));
      try {
        resolve(JSON.parse(raw));
      } catch (error: any) {
        reject(new Error(`native_device_list_invalid_json: ${error?.message || error}: ${raw}`));
      }
    });
  });
}

async function runNativeStt(locale: string, timeoutSeconds: number, deviceId?: string): Promise<{ ok: boolean; text?: string; error?: string; isFinal?: boolean; locale: string }> {
  return new Promise((resolve, reject) => {
    const args = [NATIVE_STT_SCRIPT, '--locale', locale, '--timeout', String(timeoutSeconds)];
    if (deviceId) {
      args.push('--device-id', deviceId);
    }
    const child = spawn('swift', args, {
      cwd: pathResolver.rootDir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const raw = stdout.trim();
      if (!raw) {
        return reject(new Error(stderr.trim() || `native_stt_failed_${code}`));
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (error: any) {
        reject(new Error(`native_stt_invalid_json: ${error?.message || error}: ${raw}`));
      }
    });
  });
}

async function recordNativeWav(locale: string, timeoutSeconds: number, deviceId: string | undefined, outputPath: string): Promise<{ ok: boolean; outputPath: string; error?: string; elapsedMs?: number }> {
  return new Promise((resolve, reject) => {
    const args = [NATIVE_STT_SCRIPT, '--record-wav', '--locale', locale, '--timeout', String(timeoutSeconds), '--output', outputPath];
    if (deviceId) {
      args.push('--device-id', deviceId);
    }
    const child = spawn('swift', args, {
      cwd: pathResolver.rootDir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const raw = stdout.trim();
      if (!raw) return reject(new Error(stderr.trim() || `native_record_failed_${code}`));
      try {
        resolve(JSON.parse(raw));
      } catch (error: any) {
        reject(new Error(`native_record_invalid_json: ${error?.message || error}: ${raw}`));
      }
    });
  });
}

async function convertWavForWhisper(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inputPath, outputPath], {
      cwd: pathResolver.rootDir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `afconvert_failed_${code}`));
    });
  });
}

function parseWhisperText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('whisper_'))
    .filter((line) => !line.startsWith('ggml_'))
    .filter((line) => !line.startsWith('system_info:'))
    .filter((line) => !line.startsWith('main: processing'))
    .join(' ')
    .trim();
}

async function transcribeWithWhisperCpp(inputPath: string, locale: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const lang = locale.toLowerCase().startsWith('ja') ? 'ja' : 'auto';
    const child = spawn(WHISPER_CLI_PATH, [
      '-m', WHISPER_MODEL_PATH,
      '-f', inputPath,
      '-l', lang,
      '--no-timestamps',
      '--suppress-nst',
      '-nth', '0.8',
      '-bs', '8',
    ], {
      cwd: WHISPER_CPP_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const text = parseWhisperText(`${stdout}\n${stderr}`);
      if (code === 0) {
        return resolve({ ok: true, text });
      }
      reject(new Error(text || stderr.trim() || stdout.trim() || `whisper_cli_failed_${code}`));
    });
  });
}

async function transcribeWithOpenAiCompatibleServer(
  inputPath: string,
  locale: string,
): Promise<{ ok: boolean; text?: string; error?: string; backend: string }> {
  const serverConfig = resolveVoiceSttServerConfig(process.env);
  if (!serverConfig) {
    return {
      ok: false,
      error: 'stt_server_not_configured',
      backend: 'openai_compatible_server',
    };
  }

  const audio = safeReadFile(inputPath, { encoding: null }) as Buffer;
  const audioBytes = new Uint8Array(audio);
  const form = new FormData();
  form.append('file', new Blob([audioBytes], { type: 'audio/wav' }), path.basename(inputPath));
  form.append('model', serverConfig.model);
  if (locale.toLowerCase().startsWith('ja')) {
    form.append('language', 'ja');
  }

  const headers: Record<string, string> = {};
  if (serverConfig.apiKey) {
    headers.Authorization = `Bearer ${serverConfig.apiKey}`;
  }

  const response = await fetch(`${serverConfig.baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `stt_server_http_${response.status}`,
      backend: serverConfig.provider,
    };
  }

  const payload = await response.json() as { text?: string };
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  return {
    ok: text.length > 0,
    text,
    error: text.length > 0 ? undefined : 'empty_transcript',
    backend: serverConfig.provider,
  };
}

function getAvailableSttBackends() {
  return {
    server: resolveVoiceSttServerConfig(process.env) !== null,
    whisperCpp: safeExistsSync(WHISPER_CLI_PATH) && safeExistsSync(WHISPER_MODEL_PATH),
    nativeSpeech: safeExistsSync(NATIVE_STT_SCRIPT),
  };
}

async function transcribeRecordedAudio(
  inputPath: string,
  locale: string,
  backendOrder: string[],
): Promise<{ ok: boolean; text?: string; error?: string; backend?: string }> {
  let lastError = 'no_stt_backend_available';
  for (const backend of backendOrder) {
    try {
      if (backend === 'server') {
        const result = await transcribeWithOpenAiCompatibleServer(inputPath, locale);
        if (result.ok) return result;
        lastError = result.error || lastError;
        continue;
      }

      if (backend === 'whisper_cpp') {
        const result = await transcribeWithWhisperCpp(inputPath, locale);
        if (result.ok) return { ...result, backend: 'whisper_cpp' };
        lastError = result.error || lastError;
        continue;
      }
    } catch (error: any) {
      lastError = error?.message || String(error);
    }
  }

  return {
    ok: false,
    error: lastError,
  };
}

function getSpeechPlaybackState(): SpeechPlaybackState {
  if (activeSpeechProcess && activeSpeechProcess.exitCode === null && !activeSpeechProcess.killed) {
    return { ...activeSpeechState };
  }
  return { status: 'idle' };
}

async function stopSpeechPlayback(reason: string): Promise<{ ok: boolean; stopped: boolean; reason: string }> {
  if (!activeSpeechProcess) {
    activeSpeechState = { status: 'idle' };
    return { ok: true, stopped: false, reason };
  }

  const child = activeSpeechProcess;
  activeSpeechProcess = null;
  activeSpeechState = { status: 'idle' };
  try {
    child.kill('SIGTERM');
  } catch (_) {
    return { ok: true, stopped: false, reason };
  }
  return { ok: true, stopped: true, reason };
}

async function speakReplyManaged(text: string): Promise<void> {
  await stopSpeechPlayback('replace_reply');

  if (process.platform !== 'darwin') return;

  const language = detectReplyLanguage(text);
  const profile = getVoiceTtsLanguageConfig(language);
  const normalized = normalizeTextForTts(text, language);
  const args = ['-v', profile.voice, '-r', String(profile.rate), normalized];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/say', args, {
      cwd: pathResolver.rootDir(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    activeSpeechProcess = child;
    activeSpeechState = {
      status: 'speaking',
      text: normalized,
      startedAt: Date.now(),
      pid: child.pid,
    };

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (activeSpeechProcess === child) {
        activeSpeechProcess = null;
        activeSpeechState = { status: 'idle' };
      }
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (activeSpeechProcess === child) {
        activeSpeechProcess = null;
        recentSpeechGuardState = {
          text: normalized,
          finishedAt: Date.now(),
        };
        activeSpeechState = { status: 'idle' };
      }
      if (code === 0 || signal === 'SIGTERM') {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `say_failed_${code || signal || 'unknown'}`));
    });
  });
}

async function processIngest(input: {
  requestId: string;
  text: string;
  intent: string;
  sourceId: string;
  speaker: string;
  reflect: boolean;
  autoReply: boolean;
}) {
  const { requestId, text, intent, sourceId, speaker, reflect, autoReply } = input;
  if (shouldSuppressEchoTranscript(text)) {
    return {
      statusCode: 202,
      body: {
        ok: true,
        request_id: requestId,
        ignored: true,
        reason: 'echo_suppressed',
      },
    };
  }
  pruneRecentResponses();
  const existingResponse = recentResponses.get(requestId);
  if (existingResponse) {
    return {
      statusCode: existingResponse.statusCode,
      body: {
        ...existingResponse.body,
        deduplicated: true,
        request_id: requestId,
      },
    };
  }

  const inflight = inflightResponses.get(requestId);
  if (inflight) {
    const shared = await inflight;
    return {
      statusCode: shared.statusCode,
      body: {
        ...shared.body,
        deduplicated: true,
        request_id: requestId,
      },
    };
  }

  const processing = (async (): Promise<VoiceHubResponseRecord> => {
    stopSpeechPlayback('barge_in').catch((error: any) => {
      logger.warn(`[voice-hub] Failed to stop active speech: ${error?.message || error}`);
    });

    const stimulus = createPresenceVoiceStimulus(text, intent, sourceId, requestId);
    safeAppendFileSync(STIMULI_PATH, `${JSON.stringify(stimulus)}\n`, 'utf8');

    recent.push({
      id: stimulus.id,
      request_id: requestId,
      text,
      source_id: sourceId,
      intent,
      ts: stimulus.ts,
    });
    while (recent.length > 20) recent.shift();

    const sessionKey = conversationSessionKey(sourceId, speaker);
    rememberConversationTurn(sessionKey, 'user', text);

    let reflected = false;
    let reflectError: string | undefined;
    if (reflect) {
      try {
        await reflectToPresenceSurface(text, speaker);
        reflected = true;
      } catch (error: any) {
        reflectError = error?.message || String(error);
        logger.warn(`[voice-hub] Failed to reflect to presence surface: ${reflectError}`);
      }
    }

    let replyText: string | undefined;
    let replied = false;
    let replyError: string | undefined;
    let spoken = false;
    let speechError: string | undefined;
    if (autoReply) {
      try {
        replyText = await generateReply(text, { sessionKey });
        rememberConversationTurn(sessionKey, 'assistant', replyText);
        const speakingMs = estimateSpeechDurationMs(replyText);
        try {
          await reflectTimeline(buildPresenceAssistantReplyTimeline({
            agentId: 'presence-surface-agent',
            text: replyText,
            speaking_ms: speakingMs,
          }));
        } catch (timelineError: any) {
          logger.warn(`[voice-hub] Failed to dispatch assistant reply timeline: ${timelineError?.message || timelineError}`);
        }
        speakReplyManaged(replyText).then(() => {
          logger.info('[voice-hub] assistant reply spoken successfully');
        }).catch((error: any) => {
          logger.warn(`[voice-hub] speech playback failed: ${error?.message || error}`);
        });
        replied = true;
        spoken = true;
      } catch (error: any) {
        replyError = error?.message || String(error);
        logger.warn(`[voice-hub] Failed to emit assistant reply timeline: ${replyError}`);
        speechError = replyError;
      }
    }

    const responseBody = {
      ok: true,
      request_id: requestId,
      stimulus,
      reflected,
      reflectError,
      replied,
      replyText,
      replyError,
      spoken,
      speechError,
    };
    return {
      statusCode: 201,
      body: responseBody,
      createdAt: Date.now(),
    };
  })();

  inflightResponses.set(requestId, processing);
  try {
    const record = await processing;
    recentResponses.set(requestId, record);
    return { statusCode: record.statusCode, body: record.body };
  } finally {
    inflightResponses.delete(requestId);
  }
}

function ensureStimuliDir(): void {
  const dir = path.dirname(STIMULI_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

async function reflectToPresenceSurface(text: string, speaker = 'User'): Promise<void> {
  const timeline = buildPresenceVoiceIngressTimeline({
    agentId: 'presence-surface-agent',
    text,
    speaker,
  });
  const response = await fetch(`${PRESENCE_STUDIO_URL}/api/timeline/dispatch`, {
    method: 'POST',
    signal: withTimeoutSignal(2500),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(timeline),
  });
  if (!response.ok) {
    throw new Error(`presence-studio returned HTTP ${response.status}`);
  }
}

async function reflectTimeline(timeline: object): Promise<void> {
  const response = await fetch(`${PRESENCE_STUDIO_URL}/api/timeline/dispatch`, {
    method: 'POST',
    signal: withTimeoutSignal(2500),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(timeline),
  });
  if (!response.ok) {
    throw new Error(`presence-studio returned HTTP ${response.status}`);
  }
}

function warmPresenceSurfaceAgent(): void {
  void runSurfaceConversation({
    agentId: 'presence-surface-agent',
    query: PRESENCE_SURFACE_WARMUP_QUERY,
    senderAgentId: 'kyberion:voice-hub',
  }).then((result) => {
    logger.info(`[voice-hub] presence surface warmup completed: ${JSON.stringify((result.text || '').trim())}`);
  }).catch((error: any) => {
    logger.warn(`[voice-hub] presence surface warmup failed: ${error?.message || error}`);
  });
}

function detectReplyLanguage(text: string): 'ja' | 'en' {
  return /[ぁ-んァ-ン一-龯]/.test(text) ? 'ja' : 'en';
}

function normalizeTextForTts(text: string, language: 'ja' | 'en'): string {
  const profile = getVoiceTtsLanguageConfig(language);
  const compact = text
    .replace(/\s+/g, ' ')
    .replace(/REQ-[A-Z0-9-]+/g, profile.requestIdToken || (language === 'ja' ? 'リクエストID' : 'request id'))
    .replace(/https?:\/\/\S+/g, profile.urlToken || (language === 'ja' ? 'URL' : 'link'))
    .trim();

  if (!compact) return text;

  if (language === 'ja') {
    return compact
      .replace(/([。！？])/g, '$1 ')
      .replace(/、/g, '、 ')
      .replace(/([0-9])件/g, '$1 件')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return compact
    .replace(/([.!?])/g, '$1 ')
    .replace(/,/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCapabilityReply(language: 'ja' | 'en'): string {
  const profile = getSurfaceAgentCatalogEntry('presence-surface-agent');
  const capabilities = (profile?.capabilities || ['presence', 'surface', 'conversation', 'realtime']).join(', ');
  if (language === 'ja') {
    return `この surface では短い会話、リアルタイム応答、状態案内ができます。主な capability は ${capabilities} です。重い実行や durable な作業は Chronos など別の runtime に回します。`;
  }
  return `On this surface I can handle short conversation, realtime replies, and status guidance. My main capabilities here are ${capabilities}. Heavier execution and durable work should be routed to Chronos or another runtime.`;
}

function buildVoiceFallbackReply(userText: string): string {
  const language = detectReplyLanguage(userText);
  const trimmed = userText.trim();
  const normalized = trimmed.toLowerCase();

  if (language === 'ja') {
    if (/^(こんにちは|こんばんは|おはよう|やあ|もしもし)/.test(trimmed)) {
      return 'こんにちは。ここでは短い会話や状態案内ができます。必要なら Chronos や他の runtime に回します。';
    }
    if (/(何ができる|なにができる|できること|何できる|何をしてくれる)/.test(trimmed)) {
      return buildCapabilityReply('ja');
    }
    if (/(ありがとう|助かった|了解)/.test(trimmed)) {
      return '了解です。続けてどうぞ。短い相談ならこのまま返せます。';
    }
    if (/[?？]$/.test(trimmed)) {
      return '質問は受け取れています。ここでは短く答えつつ、必要なら適切な runtime に案内します。もう少し具体的に聞いてください。';
    }
    return '受け取りました。この surface では短い会話と案内ができます。必要なら次の一歩を一緒に整理します。';
  }

  if (/^(hello|hi|hey)\b/.test(normalized)) {
    return 'Hello. I can handle short conversation and quick guidance here, and route heavier work if needed.';
  }
  if (/\b(what can you do|capabilities|help)\b/.test(normalized)) {
    return buildCapabilityReply('en');
  }
  if (/\b(thanks|thank you)\b/.test(normalized)) {
    return 'Understood. Continue whenever you are ready.';
  }
  if (/[?]$/.test(trimmed)) {
    return 'I can help with short conversation and quick guidance here. Ask a more specific question and I will answer directly or route it properly.';
  }
  return 'I received that. I can handle short conversation and quick guidance here, and route heavier work when needed.';
}

function withTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/');
}

function normalizeSearchResultUrl(rawUrl: string): string {
  const trimmed = decodeHtmlEntities(rawUrl).trim();
  if (!trimmed) return trimmed;
  const withProtocol = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(withProtocol);
    const uddg = parsed.searchParams.get('uddg');
    if (parsed.hostname.includes('duckduckgo.com') && uddg) {
      return decodeURIComponent(uddg);
    }
    return parsed.toString();
  } catch {
    return withProtocol;
  }
}

function normalizeBrowserSiteQuery(text: string): string {
  return text
    .replace(/https?:\/\/\S+/ig, '')
    .replace(/(ブラウザ|browser|サイト|site|webサイト|website|web|開いて|立ち上げて|立ち上げ|表示して|表示|見せて|見て|開く|go to|open|show|欲しい|ほしい|もらっていい|してもらえる|見たい|アクセス|移動|行って)/ig, ' ')
    .replace(/[のをへにで]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPresenceLocationContext(): Promise<PresenceLocationContext | null> {
  try {
    const response = await fetch(`${PRESENCE_STUDIO_URL}/api/context/location`, {
      signal: withTimeoutSignal(2500),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { location?: PresenceLocationContext | null };
    if (!payload?.location) return null;
    if (!Number.isFinite(payload.location.latitude) || !Number.isFinite(payload.location.longitude)) return null;
    return payload.location;
  } catch {
    return null;
  }
}

async function tryBuildLocationReply(userText: string): Promise<string | null> {
  const config = getSurfaceQueryProviderConfig().location;
  if (config?.enabled === false) return null;
  const location = await fetchPresenceLocationContext();
  const isJapanese = detectReplyLanguage(userText) === 'ja';
  if (!location) {
    return isJapanese
      ? 'この surface では現在地の共有がまだありません。ブラウザの位置情報許可を与えると答えられます。'
      : 'This surface does not have a current location yet. Allow browser location access and I can answer that.';
  }
  const lat = location.latitude.toFixed(4);
  const lon = location.longitude.toFixed(4);
  if (isJapanese) {
    return `現在地の共有コンテキストは緯度 ${lat}、経度 ${lon} です。取得時刻は ${location.timestamp} です。`;
  }
  return `The current shared location context is latitude ${lat}, longitude ${lon}, captured at ${location.timestamp}.`;
}

function weatherCodeLabel(code: number, language: 'ja' | 'en'): string {
  const table: Record<number, [string, string]> = {
    0: ['快晴', 'clear'],
    1: ['おおむね晴れ', 'mostly clear'],
    2: ['一部くもり', 'partly cloudy'],
    3: ['くもり', 'overcast'],
    45: ['霧', 'fog'],
    48: ['着氷性の霧', 'depositing rime fog'],
    51: ['弱い霧雨', 'light drizzle'],
    53: ['霧雨', 'drizzle'],
    55: ['強い霧雨', 'dense drizzle'],
    61: ['弱い雨', 'light rain'],
    63: ['雨', 'rain'],
    65: ['強い雨', 'heavy rain'],
    71: ['弱い雪', 'light snow'],
    73: ['雪', 'snow'],
    75: ['強い雪', 'heavy snow'],
    80: ['にわか雨', 'rain showers'],
    81: ['雨のにわか', 'rain showers'],
    82: ['激しいにわか雨', 'violent rain showers'],
    95: ['雷雨', 'thunderstorm'],
  };
  const found = table[code];
  return found ? found[language === 'ja' ? 0 : 1] : (language === 'ja' ? '不明' : 'unknown');
}

async function tryBuildWeatherReply(userText: string): Promise<string | null> {
  const config = getSurfaceQueryProviderConfig().weather;
  if (config?.enabled === false) return null;
  const location = await fetchPresenceLocationContext();
  const isJapanese = detectReplyLanguage(userText) === 'ja';
  if (!location) {
    return isJapanese
      ? '天気を答えるには現在地が必要です。ブラウザの位置情報を共有すると取得できます。'
      : 'I need your current location to answer the weather. Share browser location and I can fetch it.';
  }

  const timeoutMs = config?.timeoutMs || 5000;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', 'auto');

  try {
    const response = await fetch(url, { signal: withTimeoutSignal(timeoutMs) });
    if (!response.ok) throw new Error(`weather_http_${response.status}`);
    const payload = await response.json() as any;
    const currentTemp = payload?.current?.temperature_2m;
    const weatherCode = Number(payload?.current?.weather_code ?? -1);
    const maxTemp = payload?.daily?.temperature_2m_max?.[0];
    const minTemp = payload?.daily?.temperature_2m_min?.[0];
    const rainChance = payload?.daily?.precipitation_probability_max?.[0];
    const label = weatherCodeLabel(weatherCode, isJapanese ? 'ja' : 'en');
    if (isJapanese) {
      return `今日の天気は ${label} です。現在 ${currentTemp} 度、予想最高 ${maxTemp} 度、最低 ${minTemp} 度、降水確率は最大 ${rainChance}% です。`;
    }
    return `Today's weather is ${label}. It is currently ${currentTemp} degrees, with a high of ${maxTemp}, a low of ${minTemp}, and up to ${rainChance}% precipitation chance.`;
  } catch (error: any) {
    logger.warn(`[voice-hub] weather lookup failed: ${error?.message || error}`);
    return isJapanese
      ? '天気情報の取得に失敗しました。少し時間を置いてもう一度試してください。'
      : 'Weather lookup failed. Try again in a moment.';
  }
}

async function searchWeb(query: string): Promise<WebSearchResult[]> {
  const config = getSurfaceQueryProviderConfig().web_search;
  if (config?.enabled === false) return [];
  const maxResults = config?.maxResults || 3;
  const timeoutMs = config?.timeoutMs || 5000;
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    signal: withTimeoutSignal(timeoutMs),
    headers: {
      'User-Agent': 'Kyberion Surface Search/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`web_search_http_${response.status}`);
  }
  const html = await response.text();
  const matches = Array.from(html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)).slice(0, maxResults);
  return matches.map((match) => ({
    url: normalizeSearchResultUrl(match[1]),
    title: decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim()),
  })).filter((entry) => entry.title && entry.url);
}

async function tryBuildWebSearchReply(userText: string): Promise<string | null> {
  const query = extractSurfaceWebSearchQuery(userText);
  if (!query) return null;
  const isJapanese = detectReplyLanguage(userText) === 'ja';
  try {
    const results = await searchWeb(query);
    if (results.length === 0) {
      return isJapanese
        ? `Web 検索では「${query}」に対する有力な結果を見つけられませんでした。`
        : `I could not find strong web results for "${query}".`;
    }
    const lines = results.map((entry, index) => `${index + 1}. ${entry.title}`);
    if (isJapanese) {
      return `「${query}」の Web 検索上位です。${lines.join('、')}。必要なら次にどれを開くか絞れます。`;
    }
    return `Top web results for "${query}" are ${lines.join(', ')}. If you want, I can narrow down which one to open next.`;
  } catch (error: any) {
    logger.warn(`[voice-hub] web search failed: ${error?.message || error}`);
    return isJapanese
      ? 'Web 検索に失敗しました。少し時間を置いて再試行してください。'
      : 'Web search failed. Try again in a moment.';
  }
}

function loadBrowserRuntimeSessionForVoiceHub(sessionId: string): Record<string, any> | null {
  const filePath = pathResolver.shared(`runtime/browser/sessions/${sessionId}.json`);
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as Record<string, any>;
}

function listBrowserRuntimeSessionsForVoiceHub(): Array<Record<string, any>> {
  const dirPath = pathResolver.shared('runtime/browser/sessions');
  if (!safeExistsSync(dirPath)) return [];
  return safeReaddir(dirPath)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadBrowserRuntimeSessionForVoiceHub(entry.replace(/\.json$/, '')))
    .filter((entry): entry is Record<string, any> => Boolean(entry));
}

async function isReachableBrowserCdpUrl(cdpUrl?: string): Promise<boolean> {
  if (!cdpUrl) return false;
  try {
    const response = await fetch(`${String(cdpUrl).replace(/\/$/, '')}/json/version`, {
      signal: withTimeoutSignal(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function scoreBrowserRuntimeSessionForVoiceHub(session: Record<string, any>): number {
  const activeTab = (session.tabs || []).find((tab: any) => tab.active) || session.tabs?.[0];
  const url = String(activeTab?.url || '');
  let score = 0;
  if (session.cdp_url) score += 40;
  if (session.lease_status === 'active') score += 20;
  if (url && url !== 'about:blank' && url !== 'chrome://new-tab-page/') score += 25;
  if (/^https?:\/\//i.test(url)) score += 10;
  if (/^presence-/i.test(String(session.session_id || ''))) score += 15;
  if (/^browser-(profile|cdp-reconnect)$/i.test(String(session.session_id || ''))) score -= 15;
  return score;
}

async function resolveBrowserSessionForOpen(preferredSessionId?: string): Promise<{
  browserSessionId: string;
  runtimeSession: Record<string, any> | null;
}> {
  const preferredRuntimeSession = preferredSessionId
    ? loadBrowserRuntimeSessionForVoiceHub(preferredSessionId)
    : null;
  if (preferredSessionId && preferredRuntimeSession && await isReachableBrowserCdpUrl(preferredRuntimeSession.cdp_url)) {
    return {
      browserSessionId: preferredSessionId,
      runtimeSession: preferredRuntimeSession,
    };
  }

  const sessions = listBrowserRuntimeSessionsForVoiceHub()
    .sort((a, b) => scoreBrowserRuntimeSessionForVoiceHub(b) - scoreBrowserRuntimeSessionForVoiceHub(a));
  for (const session of sessions) {
    if (await isReachableBrowserCdpUrl(session.cdp_url)) {
      return {
        browserSessionId: String(session.session_id || preferredSessionId || 'default'),
        runtimeSession: session,
      };
    }
  }

  return {
    browserSessionId: preferredSessionId || 'default',
    runtimeSession: preferredRuntimeSession,
  };
}

async function executeBrowserOpenSite(params: {
  userText: string;
  url?: string;
  siteQuery?: string;
}): Promise<string | null> {
  const activeConversation = getActiveBrowserConversationSession('presence');
  const resolvedBrowserSession = await resolveBrowserSessionForOpen(activeConversation?.target?.browser_session_id || 'default');
  const browserSessionId = resolvedBrowserSession.browserSessionId;
  let targetUrl = params.url?.trim();
  logger.info(`[voice-hub] browser_open_site start: ${JSON.stringify({
    userText: params.userText,
    browserSessionId,
    activeConversationId: activeConversation?.session_id,
    activeConversationTarget: activeConversation?.target,
    url: params.url,
    siteQuery: params.siteQuery,
  })}`);

  if (!targetUrl && params.siteQuery?.trim()) {
    const results = await searchWeb(params.siteQuery.trim());
    logger.info(`[voice-hub] browser_open_site search results: ${JSON.stringify({
      siteQuery: params.siteQuery.trim(),
      resultCount: results.length,
      topResult: results[0] || null,
    })}`);
    targetUrl = results[0]?.url;
  }
  if (!targetUrl) {
    logger.warn(`[voice-hub] browser_open_site could not resolve target URL for: ${JSON.stringify({
      userText: params.userText,
      siteQuery: params.siteQuery,
    })}`);
    return null;
  }

  const runtimeSession = resolvedBrowserSession.runtimeSession || loadBrowserRuntimeSessionForVoiceHub(browserSessionId);
  logger.info(`[voice-hub] browser_open_site runtime session before goto: ${JSON.stringify({
    browserSessionId,
    runtimeSession,
  })}`);
  const tmpPath = pathResolver.sharedTmp(`browser-conversation/open-site-${Date.now().toString(36)}.json`);
  const payload = {
    action: 'pipeline',
    session_id: browserSessionId,
    options: {
      headless: false,
      keep_alive: false,
      connect_over_cdp: Boolean(runtimeSession?.cdp_url),
      cdp_url: runtimeSession?.cdp_url,
      cdp_port: runtimeSession?.cdp_port,
    },
    steps: [
      {
        type: 'capture',
        op: 'goto',
        params: {
          url: targetUrl,
          waitUntil: 'domcontentloaded',
        },
      },
      {
        type: 'capture',
        op: 'tabs',
        params: {},
      },
      {
        type: 'capture',
        op: 'snapshot',
        params: {
          export_as: 'last_snapshot',
          max_elements: 200,
        },
      },
    ],
  };
  safeWriteFile(tmpPath, JSON.stringify(payload, null, 2));
  try {
    safeExec('node', [
      'dist/libs/actuators/browser-actuator/src/index.js',
      '--input',
      tmpPath,
    ], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 60_000,
    });
  } catch (error: any) {
    logger.warn(`[voice-hub] browser_open_site goto failed: ${error?.message || error}`);
    throw error;
  }

  const updatedRuntimeSession = loadBrowserRuntimeSessionForVoiceHub(browserSessionId);
  const activeTab = (updatedRuntimeSession?.tabs || []).find((tab: any) => tab.active)
    || (updatedRuntimeSession?.tabs || []).find((tab: any) => tab.url === targetUrl)
    || updatedRuntimeSession?.tabs?.[0];
  logger.info(`[voice-hub] browser_open_site runtime session after goto: ${JSON.stringify({
    browserSessionId,
    updatedRuntimeSession,
    activeTab,
    targetUrl,
  })}`);
  if (!activeTab?.url || activeTab.url === 'about:blank' || activeTab.url === 'chrome://new-tab-page/') {
    logger.warn(`[voice-hub] browser_open_site navigation incomplete: ${JSON.stringify({
      browserSessionId,
      activeTab,
      targetUrl,
    })}`);
    throw new Error(`browser_open_site_navigation_incomplete:${targetUrl}`);
  }

  const nextConversation = activeConversation || createBrowserConversationSession({
    sessionId: `BCS-presence-${browserSessionId}`,
    surface: 'presence',
    goal: {
      summary: activeTab?.title || params.siteQuery || 'Browser session',
      success_condition: 'Complete the requested browser step safely.',
    },
    target: {
      app: 'browser',
      browser_session_id: browserSessionId,
      tab_id: activeTab?.tab_id,
      url: activeTab?.url || targetUrl,
      window_title: activeTab?.title,
    },
  });
  nextConversation.target = {
    app: 'browser',
    browser_session_id: browserSessionId,
    tab_id: activeTab?.tab_id || nextConversation.target?.tab_id,
    url: activeTab?.url || targetUrl,
    window_title: activeTab?.title || nextConversation.target?.window_title,
  };
  nextConversation.goal.summary = activeTab?.title || params.siteQuery || nextConversation.goal.summary;
  nextConversation.status = 'awaiting_instruction';
  nextConversation.updated_at = new Date().toISOString();
  saveBrowserConversationSession(nextConversation);
  logger.info(`[voice-hub] browser_open_site conversation updated: ${JSON.stringify({
    sessionId: nextConversation.session_id,
    target: nextConversation.target,
    goal: nextConversation.goal,
  })}`);

  const label = activeTab?.title || params.siteQuery || targetUrl;
  return detectReplyLanguage(params.userText) === 'ja'
    ? `${label} をブラウザで開きました。`
    : `Opened ${label} in the browser.`;
}

async function tryBuildKnowledgeReply(userText: string): Promise<string | null> {
  const extracted = extractSurfaceKnowledgeQuery(userText);
  if (!extracted) return null;
  const config = getSurfaceQueryProviderConfig().knowledge;
  if (config?.enabled === false) return null;
  const query = extracted;
  try {
    const output = safeExec('node', [
      'dist/scripts/context_ranker.js',
      '--intent', query,
      '--role', config?.role || 'presence_surface_agent',
      '--phase', config?.phase || 'alignment',
      '--scope', config?.scope || 'repository',
      '--limit', String(config?.limit || 4),
      '--json',
    ], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 12_000,
    });
    const payload = JSON.parse(output) as { results?: Array<{ path: string; title: string; score: number }> };
    const results = Array.isArray(payload.results) ? payload.results.slice(0, 3) : [];
    if (results.length === 0) {
      return detectReplyLanguage(userText) === 'ja'
        ? `蓄積ナレッジから「${query}」に近い項目は見つかりませんでした。`
        : `I could not find stored knowledge closely matching "${query}".`;
    }

    const knowledgeBlocks = results.map((entry) => {
      const absolutePath = pathResolver.knowledge(entry.path);
      const raw = safeReadFile(absolutePath, { encoding: 'utf8' }) as string;
      const excerpt = raw
        .replace(/^---[\s\S]*?---\n?/, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 12)
        .join('\n')
        .slice(0, 900);
      return `Source: knowledge/${entry.path}\nTitle: ${entry.title}\nExcerpt:\n${excerpt}`;
    }).join('\n\n');

    const prompt = [
      'You are answering a live voice query using retrieved Kyberion knowledge.',
      'Return only the final spoken answer.',
      'Answer in the user language.',
      'Be concise but actually answer the question.',
      'If useful, mention the most relevant knowledge file names briefly.',
      '',
      `User question: ${query}`,
      '',
      'Retrieved knowledge:',
      knowledgeBlocks,
    ].join('\n');
    const response = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: prompt,
      senderAgentId: 'kyberion:voice-hub',
    });
    const text = (response.text || '').trim();
    if (text) return text;
    const fallbackTitles = results.map((entry) => entry.title).join('、');
    return detectReplyLanguage(userText) === 'ja'
      ? `関連ナレッジとして ${fallbackTitles} が見つかりました。必要ならその観点で掘り下げます。`
      : `Relevant stored knowledge includes ${fallbackTitles}. I can drill into those if you want.`;
  } catch (error: any) {
    logger.warn(`[voice-hub] knowledge search failed: ${error?.message || error}`);
    return detectReplyLanguage(userText) === 'ja'
      ? 'ナレッジ検索に失敗しました。少し時間を置いて再試行してください。'
      : 'Knowledge search failed. Try again in a moment.';
  }
}

function tryHandleBrowserConversation(userText: string): string | null {
  const session = getActiveBrowserConversationSession('presence');
  if (!session) return null;

  if (session.conversation_context.pending_confirmation) {
    const confirmed = confirmBrowserConversationCandidate(session.session_id, userText);
    if (confirmed) return confirmed.feedback.message;
  }

  const resolution = classifyBrowserConversationCommand(userText);
  if (!resolution) return null;

  const command = createBrowserConversationCommand({
    sessionId: session.session_id,
    utterance: userText,
    resolution,
  });
  const feedback = applyBrowserConversationCommand(session.session_id, command);
  if (!feedback) return null;
  if (feedback.status === 'progress' && session.candidate_targets?.length !== undefined) {
    const refreshed = getActiveBrowserConversationSession('presence');
    if (refreshed && refreshed.session_id === session.session_id && refreshed.candidate_targets.length === 1 && refreshed.active_step?.kind === 'click') {
      const executed = executeBrowserConversationAction(session.session_id);
      return executed?.feedback.message || feedback.message;
    }
  }
  return feedback.message;
}

function extractQuotedValue(text: string): string | undefined {
  return text.match(/「(.+?)」|\"(.+?)\"|『(.+?)』/)?.slice(1).find(Boolean)?.trim();
}

function extractServiceName(text: string): string | undefined {
  return text.match(/([A-Za-z0-9._-]+)\s*(?:の|を)?\s*(再起動|restart|起動|停止|status|状態|ログ)/i)?.[1]
    || text.match(/service\s+([A-Za-z0-9._-]+)/i)?.[1]
    || undefined;
}

function isAffirmativeApproval(text: string): boolean {
  return /^(はい|ok|okay|yes|yep|実行|進めて|お願いします|承認|confirm)/i.test(text.trim());
}

function isNegativeApproval(text: string): boolean {
  return /^(いいえ|no|cancel|stop|やめて|中止|見送り)/i.test(text.trim());
}

function inferTaskRequirementUpdate(session: TaskSessionShape, utterance: string): {
  requirements?: TaskSessionShape['requirements'];
  payload?: Record<string, unknown>;
} | null {
  const trimmed = utterance.trim();
  if (!trimmed) return null;
  const missing = new Set(session.requirements?.missing || []);
  const collected = { ...(session.requirements?.collected || {}) };
  const payload = { ...(session.payload || {}) };

  if (session.task_type === 'analysis' && payload.bootstrap_kind === 'project_bootstrap' && missing.has('project_brief')) {
    payload.project_brief = trimmed;
    collected.project_brief = trimmed;
    missing.delete('project_brief');
  }

  if (session.task_type === 'capture_photo' && missing.has('camera_intent')) {
    if (/ocr/i.test(trimmed)) payload.camera_intent = 'ocr_source';
    else if (/共有|share/i.test(trimmed)) payload.camera_intent = 'share';
    else if (/記録|record|reference/i.test(trimmed)) payload.camera_intent = 'record';
    if (payload.camera_intent) {
      collected.camera_intent = payload.camera_intent;
      missing.delete('camera_intent');
    }
  }

  if (session.task_type === 'workbook_wbs' && missing.has('project_name')) {
    const projectName = extractQuotedValue(trimmed) || trimmed.replace(/^(この|その)?\s*(プロジェクト|案件|project)(の)?/i, '').replace(/(で|を).*/, '').trim();
    if (projectName) {
      payload.project_name = projectName;
      collected.project_name = projectName;
      missing.delete('project_name');
    }
  }

  if (session.task_type === 'presentation_deck' && missing.has('deck_purpose')) {
    const purpose =
      /営業|marketing/i.test(trimmed) ? 'marketing' :
        /社内共有|internal/i.test(trimmed) ? 'internal_share' :
          /briefing|説明/i.test(trimmed) ? 'briefing' :
            /提案|proposal/i.test(trimmed) ? 'proposal' :
              undefined;
    if (purpose) {
      payload.deck_purpose = purpose;
      collected.deck_purpose = purpose;
      missing.delete('deck_purpose');
    }
  }

  if (session.task_type === 'report_document' && missing.has('report_kind')) {
    const reportKind =
      /仕様|spec/i.test(trimmed) ? 'spec' :
        /提案|proposal/i.test(trimmed) ? 'proposal' :
          /進捗|status/i.test(trimmed) ? 'status' :
            /要約|summary/i.test(trimmed) ? 'summary' :
              undefined;
    if (reportKind) {
      payload.report_kind = reportKind;
      collected.report_kind = reportKind;
      missing.delete('report_kind');
    }
  }

  if (session.task_type === 'service_operation' && missing.has('service_name')) {
    const serviceName = extractServiceName(trimmed);
    if (serviceName) {
      payload.service_name = serviceName;
      collected.service_name = serviceName;
      missing.delete('service_name');
      if (payload.approval_required === true) {
        missing.add('approval_confirmation');
      }
    }
  }

  if (session.task_type === 'service_operation' && missing.has('approval_confirmation')) {
    if (isAffirmativeApproval(trimmed)) {
      payload.approval_confirmed = true;
      collected.approval_confirmation = 'approved';
      missing.delete('approval_confirmation');
    }
  }

  return {
    requirements: {
      missing: [...missing],
      collected,
    },
    payload,
  };
}

function buildTaskSessionAcceptedReply(session: TaskSessionShape, language: 'ja' | 'en'): string {
  const taskLabelJa: Record<string, string> = {
    analysis: 'プロジェクト整理',
    capture_photo: '写真撮影',
    workbook_wbs: 'WBS 作成',
    presentation_deck: 'PowerPoint 資料作成',
    report_document: 'レポート作成',
    service_operation: 'サービス操作',
  };
  const label = taskLabelJa[session.task_type] || session.task_type;
  const missing = session.requirements?.missing || [];
  const workDesign = resolveWorkDesign({
    taskType: session.task_type,
    shape: 'task_session',
    outcomeIds: session.task_type === 'presentation_deck'
      ? ['artifact:pptx']
      : session.task_type === 'report_document'
        ? ['artifact:docx']
        : session.task_type === 'workbook_wbs'
          ? ['artifact:xlsx']
          : session.task_type === 'service_operation'
            ? ['service_summary']
            : [],
  });
  const specialistLabel = workDesign.primary_specialist?.label || 'Kyberion';
  const learnedHint = buildLearnedHintText({
    language,
    reusableRefs: workDesign.reusable_refs,
    projectId: session.project_context?.project_id,
  });
  if (language === 'ja') {
    if (session.task_type === 'analysis' && session.payload?.bootstrap_kind === 'project_bootstrap') {
      return `${session.project_context?.project_name || 'プロジェクト'} の立ち上げを受け取りました。${specialistLabel} が担当します。${learnedHint}まず、何を作るか、誰向けか、最初の成果物をまとめて教えてください。`;
    }
    if (missing.includes('approval_confirmation')) {
      return `${label} の依頼を受け取りました。${specialistLabel} が担当します。${learnedHint}実行前に確認が必要です。続けてよければ「はい」と返してください。`;
    }
    if (missing.length > 0) {
      return `${label} の依頼を受け取りました。${specialistLabel} が担当します。${learnedHint}進めるには ${missing.join('、')} が必要です。わかったらそのまま教えてください。`;
    }
    return `${label} の依頼を受け取りました。${specialistLabel} を中心に進め方を固めて実行し、完了したら結果を返します。${learnedHint}`.trim();
  }
  if (session.task_type === 'analysis' && session.payload?.bootstrap_kind === 'project_bootstrap') {
    return `I started the project kickoff. ${specialistLabel} will handle it. ${learnedHint}Tell me what you want to build, who it is for, and the first deliverable.`;
  }
  if (missing.includes('approval_confirmation')) {
    return `I received the ${label} request. ${specialistLabel} will handle it. ${learnedHint}This action needs confirmation first. Reply yes to continue.`;
  }
  if (missing.length > 0) {
    return `I received the ${label} request. ${specialistLabel} will handle it. ${learnedHint}I still need ${missing.join(', ')}. Tell me when you're ready.`;
  }
  return `I received the ${label} request. ${specialistLabel} will plan it, run it, and report back when it's done. ${learnedHint}`.trim();
}

function buildTaskSessionProgressReply(session: TaskSessionShape, language: 'ja' | 'en'): string {
  const missing = session.requirements?.missing || [];
  const workDesign = resolveWorkDesign({
    taskType: session.task_type,
    shape: 'task_session',
    tier: session.project_context?.tier || 'confidential',
  });
  const learnedHint = buildLearnedHintText({
    language,
    reusableRefs: workDesign.reusable_refs,
    projectId: session.project_context?.project_id,
  });
  if (language === 'ja') {
    if (session.task_type === 'analysis' && session.payload?.bootstrap_kind === 'project_bootstrap' && missing.length === 0) {
      return `初期要件を受け取りました。${learnedHint}ここから最初の work plan を固めて返します。`;
    }
    if (missing.includes('approval_confirmation')) {
      return '確認が必要です。実行してよければ「はい」と返してください。';
    }
    if (missing.length > 0) {
      return `依頼内容を更新しました。残りは ${missing.join('、')} です。`;
    }
    return `依頼内容が揃いました。${learnedHint}ここから実行して、終わったら結果を返します。`;
  }
  if (session.task_type === 'analysis' && session.payload?.bootstrap_kind === 'project_bootstrap' && missing.length === 0) {
    return `I captured the kickoff requirements. ${learnedHint}I will turn them into the first work plan now.`;
  }
  if (missing.includes('approval_confirmation')) {
    return 'This action needs confirmation. Reply yes to continue.';
  }
  if (missing.length > 0) {
    return `Updated. Remaining requirements: ${missing.join(', ')}.`;
  }
  return `I have enough to proceed now. ${learnedHint}I'll report back with the result.`;
}

function taskSessionArtifactBase(sessionId: string): string {
  return pathResolver.sharedTmp(`surface-task-sessions/${sessionId}`);
}

function ensureTaskSessionExecutionDir(sessionId: string): string {
  const dir = taskSessionArtifactBase(sessionId);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  return dir;
}

function resolvePreferredLocale(input: {
  session?: TaskSessionShape;
  project?: { primary_locale?: string | null } | null;
}): string {
  const sessionLocale = String(input.session?.payload?.locale || input.session?.project_context?.locale || '').trim();
  if (sessionLocale) return sessionLocale;
  const projectLocale = String(input.project?.primary_locale || '').trim();
  if (projectLocale) return projectLocale;
  return String(process.env.KYBERION_DEFAULT_LOCALE || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US');
}

function buildPresentationDeckBrief(session: TaskSessionShape): any {
  const payload = session.payload || {};
  const purpose = String(payload.deck_purpose || 'proposal');
  const reusableRefs = resolveWorkDesign({
    intentId: 'generate-presentation',
    taskType: session.task_type,
    shape: 'task_session',
    outcomeIds: ['artifact:pptx'],
    tier: session.project_context?.tier || 'confidential',
  }).reusable_refs;
  return {
    kind: 'document-brief',
    artifact_family: 'presentation',
    document_type: 'proposal',
    document_profile: 'executive-proposal',
    render_target: 'pptx',
    locale: resolvePreferredLocale({ session }),
    layout_template_id: 'executive-neutral',
    payload: {
      title: session.goal.summary || 'Presentation Deck',
      client: 'Kyberion',
      objective: session.goal.success_condition || 'Summarize the requested proposal clearly.',
      audience: purpose === 'marketing' ? ['Prospective Customer', 'Executive Buyer'] : ['Project Stakeholder', 'Decision Maker'],
      story: {
        core_message: purpose === 'marketing'
          ? 'This deck explains the value proposition and next action clearly.'
          : 'This deck explains the proposal, rationale, and next action clearly.',
        chapters: ['Overview', 'Current context', 'Recommended approach', 'Next steps'],
        tone: purpose === 'internal_share' ? 'concise and operational' : 'executive and evidence-based',
        closing_cta: 'Review the proposal and confirm the next step.'
      },
      evidence: [
        { title: 'Request Source', point: session.history[0]?.text || session.goal.summary },
        { title: 'Purpose', point: purpose },
        { title: 'Success Condition', point: session.goal.success_condition },
        { title: 'Session', point: session.session_id }
      ],
      required_sections: ['executive-summary', 'recommendation', 'plan'],
      reusable_refs: reusableRefs,
    }
  };
}

function buildReportDocumentBrief(session: TaskSessionShape): any {
  const payload = session.payload || {};
  const reportKind = String(payload.report_kind || 'summary');
  const format = String(payload.format || 'docx');
  const reusableRefs = resolveWorkDesign({
    intentId: 'generate-report',
    taskType: session.task_type,
    shape: 'task_session',
    outcomeIds: [format === 'pdf' ? 'artifact:pdf' : 'artifact:docx'],
    tier: session.project_context?.tier || 'confidential',
  }).reusable_refs;
  return {
    kind: 'document-brief',
    artifact_family: 'document',
    document_type: 'report',
    document_profile: 'summary-report',
    render_target: format === 'pdf' ? 'pdf' : 'docx',
    locale: resolvePreferredLocale({ session }),
    payload: {
      title: session.goal.summary || 'Report',
      summary: session.goal.success_condition || 'Generated from the surface task session.',
      reusable_refs: reusableRefs,
      sections: [
        {
          heading: 'Request',
          body: [session.history[0]?.text || session.goal.summary],
          bullets: [
            `report kind: ${reportKind}`,
            `session id: ${session.session_id}`,
          ]
        },
        {
          heading: 'Current Understanding',
          body: [
            session.goal.summary,
            session.goal.success_condition,
          ],
          bullets: Object.entries(session.requirements?.collected || {}).map(([key, value]) => `${key}: ${String(value)}`)
        }
      ]
    }
  };
}

function buildMediaPipelineForBrief(briefPath: string, outputPath: string, kind: 'presentation_deck' | 'report_document'): any {
  if (kind === 'presentation_deck') {
    return {
      action: 'pipeline',
      steps: [
        {
          type: 'capture',
          op: 'json_read',
          params: { path: briefPath, export_as: 'document_brief' },
        },
        {
          type: 'transform',
          op: 'proposal_storyline_from_brief',
          params: { from: 'document_brief', export_as: 'proposal_storyline' },
        },
        {
          type: 'transform',
          op: 'proposal_content_from_storyline',
          params: { from: 'proposal_storyline', export_as: 'proposal_content_data' },
        },
        {
          type: 'transform',
          op: 'apply_theme',
          params: { theme: '{{document_brief.layout_template_id}}' },
        },
        {
          type: 'transform',
          op: 'merge_content',
          params: { content_data: '{{proposal_content_data}}', output_format: 'pptx' },
        },
        {
          type: 'apply',
          op: 'pptx_render',
          params: { design_from: 'last_pptx_design', path: outputPath },
        },
      ],
    };
  }

  return {
    action: 'pipeline',
    steps: [
      {
        type: 'capture',
        op: 'json_read',
        params: { path: briefPath, export_as: 'document_brief' },
      },
      {
        type: 'transform',
        op: 'document_report_design_from_brief',
        params: { from: 'document_brief', export_as: 'last_docx_design' },
      },
      {
        type: 'apply',
        op: outputPath.endsWith('.pdf') ? 'pdf_render' : 'docx_render',
        params: { path: outputPath },
      },
    ],
  };
}

function normalizeSurfaceName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function resolveManagedSurfaceId(serviceName: string): string | null {
  const normalizedRequested = normalizeSurfaceName(serviceName);
  const manifest = loadSurfaceManifest();
  const exact = manifest.surfaces.find((surface) => normalizeSurfaceName(surface.id) === normalizedRequested);
  if (exact) return exact.id;
  const fuzzy = manifest.surfaces.find((surface) => normalizeSurfaceName(surface.id).includes(normalizedRequested) || normalizedRequested.includes(normalizeSurfaceName(surface.id)));
  return fuzzy?.id || null;
}

function buildServiceOperationSummary(params: {
  surfaceId: string;
  operation: string;
  status?: string;
  detail?: string;
  health?: string;
  pid?: number;
  logTail?: string[];
}): string {
  const lines = [
    `surface: ${params.surfaceId}`,
    `operation: ${params.operation}`,
  ];
  if (params.status) lines.push(`status: ${params.status}`);
  if (params.health) lines.push(`health: ${params.health}`);
  if (params.pid) lines.push(`pid: ${params.pid}`);
  if (params.detail) lines.push(`detail: ${params.detail}`);
  if (params.logTail?.length) {
    lines.push('recent_log_tail:');
    lines.push(...params.logTail.map((line) => `  ${line}`));
  }
  return `${lines.join('\n')}\n`;
}

function buildProjectBootstrapSummary(params: {
  projectName: string;
  projectId: string;
  brief: string;
  workItems: Array<{ work_id: string; title: string; status: string; kind: string }>;
}): string {
  return [
    `project: ${params.projectName}`,
    `project_id: ${params.projectId}`,
    '',
    'brief:',
    params.brief,
    '',
    'bootstrap_work_items:',
    ...params.workItems.map((item) => `- ${item.work_id} [${item.status}] ${item.kind}: ${item.title}`),
    '',
  ].join('\n');
}

function inferMissionTypeHintFromBootstrapWork(item: { title?: string; summary?: string; work_id?: string }): string {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  if (/architect|設計/.test(text)) return 'architecture';
  if (/build|実装/.test(text)) return 'implementation';
  if (/verify|試験|launch|運用/.test(text)) return 'verification';
  return 'general';
}

async function executeProjectBootstrapKickoffTask(session: TaskSessionShape): Promise<{ outputPath: string; previewText: string }> {
  const projectId = String(session.project_context?.project_id || '').trim();
  if (!projectId) throw new Error('project_id is required');
  const project = loadProjectRecord(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  const workItems = Array.isArray(project.bootstrap_work_items)
    ? [...project.bootstrap_work_items]
    : [];
  if (workItems[0]) workItems[0] = { ...workItems[0], status: 'completed' };
  if (workItems[1] && workItems[1].status === 'planned') workItems[1] = { ...workItems[1], status: 'active' };

  const brief = String(session.payload?.project_brief || '').trim();
  const dir = ensureTaskSessionExecutionDir(session.session_id);
  const outputPath = `${dir}/${session.session_id}.project.txt`;
  safeWriteFile(outputPath, buildProjectBootstrapSummary({
    projectName: project.name,
    projectId: project.project_id,
    brief,
    workItems: workItems.map((item) => ({
      work_id: String(item.work_id || ''),
      title: String(item.title || ''),
      status: String(item.status || 'planned'),
      kind: String(item.kind || 'task_session'),
    })),
  }));

  saveProjectRecord({
    ...project,
    bootstrap_work_items: workItems,
    kickoff_brief: brief,
    kickoff_completed_at: new Date().toISOString(),
    proposed_mission_ids: workItems.filter((item) => item.kind === 'mission_seed').map((item) => item.work_id),
    metadata: {
      ...(project.metadata || {}),
    },
  });

  for (const item of workItems) {
    if (item.kind !== 'mission_seed') continue;
    saveMissionSeedRecord({
      seed_id: `MSD-${String(item.work_id || '').replace(/^WRK-/, '')}`,
      project_id: project.project_id,
      source_task_session_id: session.session_id,
      source_work_id: item.work_id,
      title: item.title,
      summary: item.summary,
      status: item.status === 'completed' ? 'promoted' : 'ready',
      specialist_id: item.specialist_id,
      outcome_id: item.outcome_id,
      mission_type_hint: inferMissionTypeHintFromBootstrapWork(item),
      locale: project.primary_locale,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        kickoff_brief: brief,
      },
    });
  }

  return {
    outputPath,
    previewText: `${project.name} の初期整理を完了しました。次は ${workItems.find((item) => item.status === 'active')?.title || '最初の durable work'} を進めます。`,
  };
}

function buildTaskCompletionReply(session: TaskSessionShape, previewText: string, outputPath: string): string {
  if (session.task_type === 'service_operation') {
    return `${previewText} 詳細はタスク詳細で確認できます。`;
  }
  if (session.task_type === 'presentation_deck') {
    return 'PowerPoint 資料を生成しました。詳細はタスク詳細で確認できます。';
  }
  if (session.task_type === 'report_document') {
    return 'レポート文書を生成しました。詳細はタスク詳細で確認できます。';
  }
  return '完了しました。詳細はタスク詳細で確認できます。';
}

function slugifyProjectId(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'PROJECT';
}

function inferProjectNameFromUtterance(text: string): string {
  const trimmed = text.trim();
  const explicit = trimmed.match(/(?:新しい|新規の?)?\s*([^\s]+(?:\s*[^\s]+){0,5})\s*(?:プロジェクト|Webサービス|サービス)\s*(?:を)?\s*(?:作って|立ち上げて)/i);
  if (explicit?.[1]) return explicit[1].trim();
  if (/webサービス|web service/i.test(trimmed)) return 'Web Service';
  if (/試験計画/i.test(trimmed)) return 'Test Planning';
  return 'New Project';
}

function inferBindingDraftsFromUtterance(text: string): Array<{
  binding_id: string;
  service_type: string;
  scope: string;
  target: string;
  allowed_actions: string[];
}> {
  const normalized = text.toLowerCase();
  const drafts: Array<{
    binding_id: string;
    service_type: string;
    scope: string;
    target: string;
    allowed_actions: string[];
  }> = [];
  if (/github|git hub/.test(normalized) || /webサービス|web service/.test(normalized)) {
    drafts.push({
      binding_id: 'github:default:new-project',
      service_type: 'github',
      scope: 'repository',
      target: 'default/new-project',
      allowed_actions: ['read', 'push_branch', 'pull_request'],
    });
  }
  if (/slack/.test(normalized)) {
    drafts.push({
      binding_id: 'slack:default:workspace',
      service_type: 'slack',
      scope: 'workspace',
      target: 'default',
      allowed_actions: ['read', 'post_message'],
    });
  }
  return drafts;
}

function tryHandleProjectBootstrap(userText: string): string | null {
  if (!/(webサービス|web service|新しい.*プロジェクト|新規.*プロジェクト|プロジェクト.*立ち上げ|サービス.*作って)/i.test(userText)) {
    return null;
  }
  const projectName = inferProjectNameFromUtterance(userText);
  const existing = resolveProjectRecordForText({ utterance: userText, projectName });
  if (existing) {
    const language = detectReplyLanguage(userText);
    const learnedHint = buildLearnedHintText({
      language,
      projectId: existing.project_id,
    });
    return language === 'ja'
      ? `既存の ${existing.name} プロジェクトを使って進められます。${learnedHint}次に、最初の work を指示してください。`
      : `We can continue with the existing ${existing.name} project. ${learnedHint}Tell me the first work you want next.`;
  }
  const projectId = `PRJ-${slugifyProjectId(projectName)}-${Date.now().toString(36).toUpperCase()}`;
  const bindingDrafts = inferBindingDraftsFromUtterance(userText);
  for (const draft of bindingDrafts) {
    if (listServiceBindingRecords().some((item) => item.binding_id === draft.binding_id)) continue;
    saveServiceBindingRecord({
      ...draft,
      secret_refs: [],
      approval_policy: Object.fromEntries(draft.allowed_actions.map((action) => [action, action === 'push_branch' || action === 'pull_request' || action === 'post_message' ? 'allowed' : 'approval_required'])) as Record<string, 'allowed' | 'approval_required' | 'denied'>,
      auth_mode: 'secret-guard',
      service_id: draft.service_type,
      metadata: {
        draft: true,
        created_by: 'voice-hub',
      },
    });
  }
  const bootstrapWorkItems = buildProjectBootstrapWorkItems({
    projectId,
    projectName,
    utterance: userText,
  });
  const projectLocale = String(process.env.KYBERION_DEFAULT_LOCALE || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US');
  const kickoffWork = bootstrapWorkItems[0] || null;
  let kickoffSessionId: string | undefined;
  if (kickoffWork) {
    kickoffSessionId = `TSK-${kickoffWork.work_id.replace(/^WRK-/, '')}`;
    const kickoffSession = createTaskSession({
      sessionId: kickoffSessionId,
      surface: 'presence',
      taskType: 'analysis',
      status: 'collecting_requirements',
      goal: {
        summary: kickoffWork.title,
        success_condition: kickoffWork.summary,
      },
      projectContext: {
        project_id: projectId,
        project_name: projectName,
        tier: 'confidential',
        service_bindings: bindingDrafts.map((draft) => draft.binding_id),
        locale: projectLocale,
      },
      requirements: {
        missing: ['project_brief'],
        collected: {},
      },
      payload: {
        bootstrap_kind: 'project_bootstrap',
        bootstrap_work_ids: bootstrapWorkItems.map((item) => item.work_id),
      },
    });
    saveTaskSession(kickoffSession);
    recordTaskSessionHistory(kickoffSession.session_id, {
      ts: new Date().toISOString(),
      type: 'plan',
      text: `Bootstrap kickoff created for ${projectName}. Next work: ${bootstrapWorkItems.map((item) => item.title).join(' -> ')}`,
    });
  }
  saveProjectRecord({
    project_id: projectId,
    name: projectName,
    summary: `${projectName} project created from surface intent.`,
    status: 'active',
    tier: 'confidential',
    primary_locale: projectLocale,
    service_bindings: bindingDrafts.map((draft) => draft.binding_id),
    active_missions: [],
    bootstrap_work_items: bootstrapWorkItems,
    kickoff_task_session_id: kickoffSessionId,
    metadata: {
      created_from_surface: 'presence',
      created_from_utterance: userText,
    },
  });
  const firstSteps = bootstrapWorkItems.slice(0, 3).map((item) => item.title).join('、');
  return `${projectName} プロジェクトを作成しました。Project Lead が担当し、まず ${firstSteps} を進めます。最初の kickoff work は ${kickoffSessionId || kickoffWork?.work_id || '作成済み'} です。次に、作りたい内容や最初の成果物を教えてください。`;
}

function resolveProjectContextForTask(userText: string, intent: ReturnType<typeof classifyTaskSessionIntent>): TaskSessionShape['project_context'] | undefined {
  if (!intent) return undefined;
  const payload = intent.payload || {};
  const explicitProjectName = typeof payload.project_name === 'string'
    ? payload.project_name
    : typeof payload.project_id === 'string'
      ? payload.project_id
      : undefined;
  const project = resolveProjectRecordForText({
    utterance: userText,
    projectName: explicitProjectName,
  });
  if (!project) return undefined;
  return {
    project_id: project.project_id,
    project_name: project.name,
    tier: project.tier,
    service_bindings: project.service_bindings || [],
    locale: project.primary_locale,
  };
}

function formatServiceHealthSummary(surfaceId: string, isRunning: boolean, healthStatus: string, hasRuntimeRecord: boolean): string {
  if (!isRunning) {
    return `${surfaceId} は停止しています。`;
  }
  if (healthStatus === 'healthy') {
    if (!hasRuntimeRecord) {
      return `${surfaceId} はヘルスチェック上は正常に応答しています。`;
    }
    return `${surfaceId} は稼働中で、ヘルスチェックも正常です。`;
  }
  if (healthStatus === 'unhealthy') {
    return `${surfaceId} は動作していますが、ヘルスチェックは異常です。`;
  }
  return `${surfaceId} は稼働中です。`;
}

function summarizeLogTail(surfaceId: string, lines: string[]): string {
  if (lines.length === 0) {
    return `${surfaceId} のログはまだありません。`;
  }
  const latestMeaningful = [...lines]
    .reverse()
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^\}+$/.test(line) && !/^syscall:|^address:|^port:/i.test(line));
  if (!latestMeaningful) {
    return `${surfaceId} の最新ログを取得しました。`;
  }
  const simplified = latestMeaningful
    .replace(/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z\s+/, '')
    .replace(/^\[[A-Z]+\]\s+/, '')
    .replace(/\[[A-Z]+\]\s+/g, '')
    .replace(/^\[voice-hub\]\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = simplified || latestMeaningful;
  if (/assistant reply spoken successfully/i.test(normalized)) {
    return `${surfaceId} の最新ログを取得しました。直近では音声応答の再生が正常に完了しています。`;
  }
  if (/surface conversation failed:?\s*surface_conversation_timeout/i.test(normalized)) {
    return `${surfaceId} の最新ログを取得しました。直近では会話処理のタイムアウトが記録されています。`;
  }
  if (/listening on http/i.test(normalized)) {
    return `${surfaceId} の最新ログを取得しました。現在は待受状態です。`;
  }
  if (/loaded .*agent definitions/i.test(normalized)) {
    return `${surfaceId} の最新ログを取得しました。エージェント定義の読み込みは正常です。`;
  }
  return `${surfaceId} の最新ログを取得しました。詳細はタスク詳細で確認できます。`;
}

async function executeServiceOperationTask(session: TaskSessionShape): Promise<{ outputPath: string; previewText: string }> {
  const payload = session.payload || {};
  const requestedName = String(payload.service_name || '').trim();
  const operation = String(payload.operation || 'status').trim().toLowerCase();
  if (!requestedName) {
    throw new Error('service_name is required');
  }

  const surfaceId = resolveManagedSurfaceId(requestedName);
  if (!surfaceId) {
    throw new Error(`Unknown managed surface: ${requestedName}`);
  }

  if (surfaceId === 'voice-hub' && operation === 'restart') {
    throw new Error('Restarting voice-hub from itself is not supported safely in-band. Use status/logs or restart it externally.');
  }

  const dir = ensureTaskSessionExecutionDir(session.session_id);
  const outputPath = `${dir}/${session.session_id}.service.txt`;
  const manifest = loadSurfaceManifest();
  const definition = manifest.surfaces.find((surface) => surface.id === surfaceId);
  const normalized = definition ? normalizeSurfaceDefinition(definition) : null;
  const state = loadSurfaceState();
  const record = state.surfaces[surfaceId];
  const fallbackLogPath = pathResolver.shared(`logs/surfaces/${surfaceId}.log`);
  const resolvedLogPath = record?.logPath || fallbackLogPath;
  const logTailLines = Number(payload.log_tail_lines || 40);

  if (operation === 'logs') {
    const logTail = safeExistsSync(resolvedLogPath) ? readSurfaceLogTail(resolvedLogPath, logTailLines) : [];
    const previewText = summarizeLogTail(surfaceId, logTail);
    safeWriteFile(outputPath, buildServiceOperationSummary({
      surfaceId,
      operation,
      status: record ? 'known' : (logTail.length > 0 ? 'log_only' : 'unknown'),
      pid: record?.pid,
      detail: safeExistsSync(resolvedLogPath) ? resolvedLogPath : 'no_log_path',
      logTail,
    }));
    return { outputPath, previewText };
  }

  if (operation === 'status') {
    const health = normalized ? await probeSurfaceHealth(normalized) : { status: 'unknown', detail: 'definition_not_found' };
    const hasRuntimeRecord = Boolean(record?.pid);
    const isRunning = hasRuntimeRecord || health.status === 'healthy';
    const previewText = formatServiceHealthSummary(surfaceId, isRunning, health.status, hasRuntimeRecord);
    safeWriteFile(outputPath, buildServiceOperationSummary({
      surfaceId,
      operation,
      status: isRunning ? 'running' : 'stopped',
      health: `${health.status}:${health.detail}`,
      pid: record?.pid,
      detail: safeExistsSync(resolvedLogPath) ? resolvedLogPath : undefined,
      logTail: safeExistsSync(resolvedLogPath) ? readSurfaceLogTail(resolvedLogPath, 12) : [],
    }));
    return { outputPath, previewText };
  }

  const manifestPath = pathResolver.knowledge('public/governance/active-surfaces.json');
  if (operation === 'restart') {
    safeExec('node', ['dist/scripts/surface_runtime.js', '--action', 'stop', '--surface', surfaceId, '--manifest', manifestPath], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 20_000,
    });
    safeExec('node', ['dist/scripts/surface_runtime.js', '--action', 'start', '--surface', surfaceId, '--manifest', manifestPath], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 30_000,
    });
  } else if (operation === 'start' || operation === 'stop') {
    safeExec('node', ['dist/scripts/surface_runtime.js', '--action', operation, '--surface', surfaceId, '--manifest', manifestPath], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 30_000,
    });
  } else {
    throw new Error(`Unsupported service operation: ${operation}`);
  }

  const nextState = loadSurfaceState();
  const nextRecord = nextState.surfaces[surfaceId];
  const nextHealth = normalized ? await probeSurfaceHealth(normalized) : { status: 'unknown', detail: 'definition_not_found' };
  const previewText = operation === 'restart'
    ? `${surfaceId} を再起動しました。`
    : operation === 'start'
      ? `${surfaceId} を起動しました。`
      : `${surfaceId} を停止しました。`;
  safeWriteFile(outputPath, buildServiceOperationSummary({
    surfaceId,
    operation,
    status: nextRecord ? 'running' : 'stopped',
    health: `${nextHealth.status}:${nextHealth.detail}`,
    pid: nextRecord?.pid,
    detail: nextRecord?.logPath || (safeExistsSync(resolvedLogPath) ? resolvedLogPath : undefined),
    logTail: nextRecord?.logPath
      ? readSurfaceLogTail(nextRecord.logPath, 12)
      : (safeExistsSync(resolvedLogPath) ? readSurfaceLogTail(resolvedLogPath, 12) : []),
  }));
  return { outputPath, previewText };
}

async function processTaskSessionExecution(session: TaskSessionShape): Promise<void> {
  if (activeTaskExecutions.has(session.session_id)) return;
  if (!['presentation_deck', 'report_document', 'service_operation', 'analysis'].includes(session.task_type)) return;
  activeTaskExecutions.add(session.session_id);
  try {
    updateTaskSession(session.session_id, {
      status: 'executing',
      control: {
        ...session.control,
        awaiting_user_input: false,
      },
    });

    let outputPath = '';
    let artifactKind = 'error';
    let previewText = '';

    if (session.task_type === 'analysis' && session.payload?.bootstrap_kind === 'project_bootstrap') {
      const result = await executeProjectBootstrapKickoffTask(session);
      outputPath = result.outputPath;
      artifactKind = 'project_bootstrap';
      previewText = result.previewText;
    } else if (session.task_type === 'service_operation') {
      const result = await executeServiceOperationTask(session);
      outputPath = result.outputPath;
      artifactKind = 'service';
      previewText = result.previewText;
    } else {
      const dir = ensureTaskSessionExecutionDir(session.session_id);
      const briefPath = `${dir}/brief.json`;
      outputPath = session.task_type === 'presentation_deck'
        ? `${dir}/${session.session_id}.pptx`
        : `${dir}/${session.session_id}.${String(session.payload?.format || 'docx') === 'pdf' ? 'pdf' : 'docx'}`;
      const pipelinePath = `${dir}/pipeline.json`;
      const brief = session.task_type === 'presentation_deck'
        ? buildPresentationDeckBrief(session)
        : buildReportDocumentBrief(session);
      const pipeline = buildMediaPipelineForBrief(briefPath, outputPath, session.task_type as 'presentation_deck' | 'report_document');

      safeWriteFile(briefPath, JSON.stringify(brief, null, 2));
      safeWriteFile(pipelinePath, JSON.stringify(pipeline, null, 2));
      safeExec('node', [
        'dist/libs/actuators/media-actuator/src/index.js',
        '--input',
        pipelinePath,
      ], {
        cwd: pathResolver.rootDir(),
        timeoutMs: 120_000,
      });
      artifactKind = session.task_type === 'presentation_deck'
        ? 'pptx'
        : (outputPath.endsWith('.pdf') ? 'pdf' : 'docx');
      previewText = session.task_type === 'presentation_deck'
        ? 'PowerPoint 資料を生成しました。'
        : 'レポート文書を生成しました。';
    }

    const spokenReply = buildTaskCompletionReply(session, previewText, outputPath);

    updateTaskSession(session.session_id, {
      status: 'completed',
      artifact: {
        kind: artifactKind,
        output_path: outputPath,
        preview_text: previewText,
      },
    });
    const artifactRecord = createArtifactRecord({
      project_id: session.project_context?.project_id,
      task_session_id: session.session_id,
      kind: artifactKind,
      storage_class: artifactKind === 'service' ? 'tmp' : 'artifact_store',
      path: outputPath,
      preview_text: previewText,
      metadata: {
        project_name: session.project_context?.project_name,
        service_bindings: session.project_context?.service_bindings || [],
      },
    });
    saveArtifactRecord(artifactRecord);
    attachArtifactRecordToTaskSession(session.session_id, artifactRecord);
    maybeCreateDistillCandidate(session, artifactRecord.artifact_id, previewText);
    enqueueSurfaceNotification({
      surface: 'presence',
      channel: 'voice',
      threadTs: session.session_id,
      sourceAgentId: 'presence-surface-agent',
      title: `Completed ${session.session_id}`,
      text: spokenReply,
      status: 'success',
      requestId: session.session_id,
    });
    await reflectPresenceAgentReply({
      agentId: 'presence-surface-agent',
      speaker: 'Kyberion',
      text: spokenReply,
    }, PRESENCE_STUDIO_URL).catch(() => {});
  } catch (error: any) {
    const message = error?.message || String(error);
    const userFacingError = session.task_type === 'service_operation'
      ? 'サービス操作に失敗しました。詳細はタスク詳細で確認できます。'
      : '処理に失敗しました。詳細はタスク詳細で確認できます。';
    updateTaskSession(session.session_id, {
      status: 'failed',
      artifact: {
        kind: 'error',
        preview_text: message,
      },
    });
    enqueueSurfaceNotification({
      surface: 'presence',
      channel: 'voice',
      threadTs: session.session_id,
      sourceAgentId: 'presence-surface-agent',
      title: `Failed ${session.session_id}`,
      text: userFacingError,
      status: 'error',
      requestId: session.session_id,
    });
    await reflectPresenceAgentReply({
      agentId: 'presence-surface-agent',
      speaker: 'Kyberion',
      text: userFacingError,
    }, PRESENCE_STUDIO_URL).catch(() => {});
  } finally {
    activeTaskExecutions.delete(session.session_id);
  }
}

function tryHandleTaskSession(userText: string): string | null {
  const language = detectReplyLanguage(userText);
  const active = getActiveTaskSession('presence') as TaskSessionShape | null;
  if (active && active.control.awaiting_user_input) {
    if (active.task_type === 'service_operation' && active.requirements?.missing?.includes('approval_confirmation') && isNegativeApproval(userText)) {
      updateTaskSession(active.session_id, {
        status: 'released',
        control: {
          ...active.control,
          awaiting_user_input: false,
        },
      });
      return language === 'ja'
        ? 'サービス操作は見送りました。'
        : 'I cancelled the service operation.';
    }
    const inferred = inferTaskRequirementUpdate(active, userText);
    if (inferred) {
      const nextMissing = inferred.requirements?.missing || [];
      const updated = updateTaskSession(active.session_id, {
        requirements: inferred.requirements,
        payload: inferred.payload,
        status: nextMissing.includes('approval_confirmation')
          ? 'awaiting_confirmation'
          : (nextMissing.length > 0 ? 'collecting_requirements' : 'planning'),
        control: {
          ...active.control,
          requires_approval: Boolean(inferred.payload?.approval_required),
          awaiting_user_input: nextMissing.length > 0,
        },
      }) as TaskSessionShape | null;
      if (updated) {
        recordTaskSessionHistory(updated.session_id, {
          ts: new Date().toISOString(),
          type: 'instruction',
          text: userText,
        });
        if ((updated.requirements?.missing || []).length === 0) {
          void processTaskSessionExecution(updated);
        }
        return buildTaskSessionProgressReply(updated, language);
      }
    }
  }

  const intent = classifyTaskSessionIntent(userText);
  if (!intent) return null;
  const projectContext = resolveProjectContextForTask(userText, intent);
  const session = createTaskSession({
    surface: 'presence',
    taskType: intent.taskType,
    status: intent.requirements?.missing?.includes('approval_confirmation')
      ? 'awaiting_confirmation'
      : (intent.requirements?.missing?.length ? 'collecting_requirements' : 'planning'),
    requiresApproval: Boolean(intent.payload?.approval_required),
    goal: intent.goal,
    projectContext,
    requirements: intent.requirements,
    payload: intent.payload,
  });
  session.control.awaiting_user_input = Boolean(intent.requirements?.missing?.length);
  saveTaskSession(session);
  recordTaskSessionHistory(session.session_id, {
    ts: new Date().toISOString(),
    type: 'instruction',
    text: userText,
  });
  if ((session.requirements?.missing || []).length === 0) {
    void processTaskSessionExecution(session as TaskSessionShape);
  }
  return buildTaskSessionAcceptedReply(session as TaskSessionShape, language);
}

function parseMissionListSummary(output: string): { total: number; active: number; archived: number; completed: number; planned: number } {
  const lines = output.split('\n');
  const totalMatch = output.match(/(\d+)\s+mission\(s\)\s+found/i);
  let active = 0;
  let archived = 0;
  let completed = 0;
  let planned = 0;
  for (const line of lines) {
    if (line.includes('🟢 active')) active += 1;
    if (line.includes('📦 archived')) archived += 1;
    if (line.includes('✅ completed')) completed += 1;
    if (line.includes('⚪ planned')) planned += 1;
  }
  return {
    total: totalMatch ? Number(totalMatch[1]) : active + archived + completed + planned,
    active,
    archived,
    completed,
    planned,
  };
}

function tryBuildChronosFastReply(userText: string, forcedReceiver?: 'chronos-mirror' | 'nerve-agent'): string | null {
  if (forcedReceiver !== 'chronos-mirror') return null;
  const trimmed = userText.trim();
  const isJapanese = detectReplyLanguage(trimmed) === 'ja';

  if (/ミッション一覧|mission list|current mission|今のミッション/i.test(trimmed)) {
    const output = safeExec('node', ['dist/scripts/mission_controller.js', 'list'], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 10000,
    });
    const summary = parseMissionListSummary(output);
    if (isJapanese) {
      return `現在 ${summary.total} 件のミッションがあります。内訳は、アクティブ ${summary.active} 件、アーカイブ ${summary.archived} 件、完了 ${summary.completed} 件、計画中 ${summary.planned} 件です。`;
    }
    return `There are currently ${summary.total} missions: ${summary.active} active, ${summary.archived} archived, ${summary.completed} completed, and ${summary.planned} planned.`;
  }

  if (/system status|システム状態|runtime|ランタイム|health|ヘルス/i.test(trimmed)) {
    const output = safeExec('node', ['dist/scripts/mission_controller.js', 'list'], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 10000,
    });
    const summary = parseMissionListSummary(output);
    const runtimes = listAgentRuntimeSnapshots();
    const ready = runtimes.filter((entry: any) => entry.agent.status === 'ready').length;
    if (isJapanese) {
      return `現在のシステム状態です。ミッションは ${summary.total} 件で、アクティブは ${summary.active} 件です。agent runtime は ${runtimes.length} 件、そのうち ready は ${ready} 件です。`;
    }
    return `Current system status: ${summary.total} missions, ${summary.active} active. There are ${runtimes.length} agent runtimes, with ${ready} ready.`;
  }

  return null;
}

function tryBuildAsyncStatusReply(userText: string): string | null {
  const trimmed = userText.trim();
  const isJapanese = detectReplyLanguage(trimmed) === 'ja';
  const requestIdMatch = trimmed.match(/REQ-[A-Z0-9-]+/i);
  if (/(依頼状況|リクエスト状況|request status|pending request|通知|notification)/i.test(trimmed)) {
    if (requestIdMatch) {
      const record = getSurfaceAsyncRequest('presence', requestIdMatch[0].toUpperCase());
      if (!record) {
        return isJapanese ? `リクエスト ${requestIdMatch[0].toUpperCase()} は見つかりません。` : `Request ${requestIdMatch[0].toUpperCase()} was not found.`;
      }
      if (record.status === 'completed') {
        return isJapanese
          ? `リクエスト ${record.request_id} は完了済みです。結果は ${record.result_text || '記録済み'} です。`
          : `Request ${record.request_id} is completed. Result: ${record.result_text || 'recorded'}.`;
      }
      if (record.status === 'failed') {
        return isJapanese
          ? `リクエスト ${record.request_id} は失敗しました。${record.error || 'エラーが記録されています。'}`
          : `Request ${record.request_id} failed. ${record.error || 'An error is recorded.'}`;
      }
      return isJapanese
        ? `リクエスト ${record.request_id} はまだ進行中です。`
        : `Request ${record.request_id} is still pending.`;
    }

    const requests = listSurfaceAsyncRequests('presence').slice(0, 5);
    const notifications = listSurfaceNotifications('presence').slice(0, 3);
    if (isJapanese) {
      if (requests.length === 0) return '現在、進行中または最近のリクエストはありません。';
      const latest = requests.map((entry) => `${entry.request_id} ${entry.status}`).join('、');
      const latestNotification = notifications[0]
        ? ` 最新通知は「${notifications[0].text || notifications[0].title}」です。`
        : '';
      return `最近のリクエストは ${requests.length} 件です。${latest}.${latestNotification}`;
    }
    if (requests.length === 0) return 'There are no recent async requests.';
    const latest = requests.map((entry) => `${entry.request_id} ${entry.status}`).join(', ');
    const latestNotification = notifications[0]
      ? ` Latest notification: ${notifications[0].text || notifications[0].title}.`
      : '';
    return `There are ${requests.length} recent requests: ${latest}.${latestNotification}`;
  }
  return null;
}

function buildAsyncAcceptedReply(requestId: string, receiver: 'chronos-mirror' | 'nerve-agent', language: 'ja' | 'en'): string {
  if (language === 'ja') {
    return `依頼を受け付けました。${receiver} に回しています。リクエストIDは ${requestId} です。完了したらこの surface に通知します。`;
  }
  return `Accepted. Routing this to ${receiver}. The request id is ${requestId}. I will notify this surface when it completes.`;
}

function getAsyncDelegationTimeoutMs(receiver: 'chronos-mirror' | 'nerve-agent'): number {
  if (receiver === 'chronos-mirror') {
    return Number(process.env.VOICE_HUB_ASYNC_TIMEOUT_CHRONOS_MS || 60_000);
  }
  return Number(process.env.VOICE_HUB_ASYNC_TIMEOUT_NERVE_MS || 180_000);
}

function extractAsyncCompletionText(result: any): string {
  const directText = typeof result?.text === 'string' ? result.text.trim() : '';
  if (directText && !/\(No text, stopReason: cancelled\)/i.test(directText)) {
    return directText;
  }

  const delegated = Array.isArray(result?.delegationResults) ? result.delegationResults : [];
  for (const entry of delegated) {
    const response = typeof entry?.response === 'string' ? entry.response.trim() : '';
    if (!response || /\(No text, stopReason: cancelled\)/i.test(response)) continue;
    const parsed = extractSurfaceBlocks(response);
    const candidate = (parsed.text || '').trim();
    if (candidate) return candidate;
    return response;
  }

  return '';
}

function processAsyncDelegation(params: {
  requestId: string;
  query: string;
  receiver: 'chronos-mirror' | 'nerve-agent';
}): void {
  void (async () => {
    try {
      const timeoutMs = getAsyncDelegationTimeoutMs(params.receiver);
      const result = await Promise.race([
        runSurfaceConversation({
          agentId: 'presence-surface-agent',
          query: [
            'You are replying on the live voice surface.',
            'Return only the final spoken reply.',
            'Answer the user directly in their language.',
            'Keep it concise, natural, and useful for speech playback.',
            '',
            `User: ${params.query}`,
          ].join('\n'),
          senderAgentId: 'kyberion:voice-hub',
          forcedReceiver: params.receiver,
          delegationSummaryInstruction:
            'Below are delegated responses. Produce the final spoken answer in the user language. Keep it concise and directly answer the user. Do not emit A2A blocks.',
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`async_surface_request_timeout_${timeoutMs}`)), timeoutMs);
        }),
      ]);
      const finalText = extractAsyncCompletionText(result) || 'Completed.';
      updateSurfaceAsyncRequest('presence', params.requestId, {
        status: 'completed',
        result_text: finalText,
        completed_at: new Date().toISOString(),
      });
      enqueueSurfaceNotification({
        surface: 'presence',
        channel: 'voice',
        threadTs: params.requestId,
        sourceAgentId: params.receiver,
        title: `Completed ${params.requestId}`,
        text: finalText,
        status: 'success',
        requestId: params.requestId,
      });
      await reflectPresenceAgentReply({
        agentId: params.receiver,
        speaker: params.receiver,
        text: `Request ${params.requestId}: ${finalText}`,
      }, PRESENCE_STUDIO_URL);
    } catch (error: any) {
      const message = error?.message || String(error);
      updateSurfaceAsyncRequest('presence', params.requestId, {
        status: 'failed',
        error: message,
        completed_at: new Date().toISOString(),
      });
      enqueueSurfaceNotification({
        surface: 'presence',
        channel: 'voice',
        threadTs: params.requestId,
        sourceAgentId: params.receiver,
        title: `Failed ${params.requestId}`,
        text: message,
        status: 'error',
        requestId: params.requestId,
      });
      await reflectPresenceAgentReply({
        agentId: 'presence-surface-agent',
        speaker: 'Kyberion',
        text: `Request ${params.requestId} failed: ${message}`,
      }, PRESENCE_STUDIO_URL).catch(() => {});
    }
  })();
}

async function generateReply(userText: string, context: { sessionKey: string }): Promise<string> {
  try {
    const projectBootstrapReply = tryHandleProjectBootstrap(userText);
    if (projectBootstrapReply) return projectBootstrapReply;

    const browserConversationReply = tryHandleBrowserConversation(userText);
    if (browserConversationReply) return browserConversationReply;

    const heuristicCandidates = buildHeuristicSurfaceRoutingCandidates(userText);
    const topHeuristic = heuristicCandidates[0]?.decision || null;
    logger.info(`[voice-hub] surface routing heuristic candidates: ${JSON.stringify({
      userText,
      candidates: heuristicCandidates.map((entry) => ({
        reason: entry.reason,
        decision: entry.decision,
      })),
    })}`);

    if (topHeuristic?.intent === 'browser_open_site') {
      const opened = await executeBrowserOpenSite({
        userText,
        url: topHeuristic.browser?.url,
        siteQuery: topHeuristic.browser?.site_query,
      });
      if (opened) return opened;
    }
    if (topHeuristic?.intent === 'browser_step') {
      const browserStepReply = tryHandleBrowserConversation(userText);
      if (browserStepReply) return browserStepReply;
    }

    const taskSessionReply = tryHandleTaskSession(userText);
    if (taskSessionReply) return taskSessionReply;

    const routed = await routeSurfaceActionWithLlm(userText, context, heuristicCandidates) || topHeuristic || buildFallbackSurfaceRoutingDecision(userText);
    logger.info(`[voice-hub] surface routing final decision: ${JSON.stringify({
      userText,
      topHeuristic,
      routed,
    })}`);
    if (routed?.intent === 'browser_open_site') {
      const opened = await executeBrowserOpenSite({
        userText,
        url: routed.browser?.url,
        siteQuery: routed.browser?.site_query,
      });
      if (opened) return opened;
    }
    if (routed?.intent === 'browser_step') {
      const browserReply = tryHandleBrowserConversation(userText);
      if (browserReply) return browserReply;
    }
    if (routed?.intent === 'task_session') {
      const taskReply = tryHandleTaskSession(userText);
      if (taskReply) return taskReply;
    }

    const queryIntent = routed?.intent === 'surface_query'
      ? routed.query?.query_type || classifySurfaceQueryIntent(userText)
      : classifySurfaceQueryIntent(userText);
    if (queryIntent === 'location') {
      const locationReply = await tryBuildLocationReply(userText);
      if (locationReply) return locationReply;
    }
    if (queryIntent === 'weather') {
      const weatherReply = await tryBuildWeatherReply(userText);
      if (weatherReply) return weatherReply;
    }
    if (queryIntent === 'knowledge_search') {
      const knowledgeReply = await tryBuildKnowledgeReply(userText);
      if (knowledgeReply) return knowledgeReply;
    }
    if (queryIntent === 'web_search') {
      const webReply = await tryBuildWebSearchReply(userText);
      if (webReply) return webReply;
    }

    const forcedReceiver = routed?.intent === 'async_delegate'
      ? routed.delegate?.receiver || deriveSurfaceDelegationReceiver(userText)
      : deriveSurfaceDelegationReceiver(userText);
    const statusReply = tryBuildAsyncStatusReply(userText);
    if (statusReply) return statusReply;
    const fastReply = tryBuildChronosFastReply(userText, forcedReceiver);
    if (fastReply) return fastReply;
    if (forcedReceiver) {
      const accepted = createSurfaceAsyncRequest({
        surface: 'presence',
        channel: 'voice',
        threadTs: `voice-${Date.now().toString(36)}`,
        senderAgentId: 'kyberion:voice-hub',
        surfaceAgentId: 'presence-surface-agent',
        receiverAgentId: forcedReceiver,
        query: userText,
        acceptedText: buildAsyncAcceptedReply('PENDING', forcedReceiver, detectReplyLanguage(userText)),
      });
      updateSurfaceAsyncRequest('presence', accepted.request_id, {
        accepted_text: buildAsyncAcceptedReply(accepted.request_id, forcedReceiver, detectReplyLanguage(userText)),
      });
      processAsyncDelegation({
        requestId: accepted.request_id,
        query: userText,
        receiver: forcedReceiver,
      });
      return buildAsyncAcceptedReply(accepted.request_id, forcedReceiver, detectReplyLanguage(userText));
    }
    const timeoutMs = forcedReceiver === 'chronos-mirror' ? 20_000 : 20_000;
    const result = await Promise.race([
      runSurfaceConversation({
        agentId: 'presence-surface-agent',
        query: buildPresenceConversationPrompt(userText, context.sessionKey),
        senderAgentId: 'kyberion:voice-hub',
        forcedReceiver,
        delegationSummaryInstruction:
          'Below are delegated responses. Produce the final spoken answer in the user language. Keep it concise and directly answer the user. Do not emit A2A blocks.',
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('surface_conversation_timeout')), timeoutMs);
      }),
    ]);
    const text = (result.text || '').trim();
    if (text) return text;
  } catch (error: any) {
    logger.warn(`[voice-hub] Surface conversation failed: ${error?.message || error}`);
  }
  return buildVoiceFallbackReply(userText);
}

ensureStimuliDir();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    recent: recent.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/recent', (_req, res) => {
  res.json({ items: recent });
});

app.get('/api/speech/state', (_req, res) => {
  res.json({
    ok: true,
    speech: getSpeechPlaybackState(),
  });
});

app.post('/api/stop-speaking', async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual_stop';
  const result = await stopSpeechPlayback(reason);
  res.json(result);
});

app.post('/api/ingest-text', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'conversation';
  const sourceId = typeof req.body?.source_id === 'string' ? req.body.source_id : 'local-mic';
  const speaker = typeof req.body?.speaker === 'string' ? req.body.speaker : 'User';
  const reflect = req.body?.reflect_to_surface !== false;
  const autoReply = req.body?.auto_reply !== false;
  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : `vh-${requestFingerprint({ text, intent, sourceId, speaker })}-${randomUUID().slice(0, 8)}`;

  const result = await processIngest({ requestId, text, intent, sourceId, speaker, reflect, autoReply });
  return res.status(result.statusCode).json(result.body);
});

app.post('/api/listen-once', async (req, res) => {
  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : randomUUID();
  const locale = typeof req.body?.locale === 'string' && req.body.locale.trim()
    ? req.body.locale.trim()
    : 'ja-JP';
  const timeoutSeconds = Number.isFinite(req.body?.timeout_seconds) ? Number(req.body.timeout_seconds) : 8;
  const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'conversation';
  const speaker = typeof req.body?.speaker === 'string' ? req.body.speaker : 'User';
  const deviceId = typeof req.body?.device_id === 'string' && req.body.device_id.trim()
    ? req.body.device_id.trim()
    : undefined;
  const reflect = req.body?.reflect_to_surface !== false;
  const autoReply = req.body?.auto_reply !== false;
  const requestedBackend = req.body?.backend;
  const startedAt = Date.now();
  const availability = getAvailableSttBackends();
  const backendOrder = resolveVoiceSttBackendOrder(
    parseVoiceSttBackend(requestedBackend),
    availability,
    process.env,
  );

  logger.info(`[voice-hub] native STT start request=${requestId} locale=${locale} device=${deviceId || 'default'} timeout=${timeoutSeconds}s`);

  try {
    if (backendOrder[0] === 'native_speech') {
      const stt = await runNativeStt(locale, timeoutSeconds, deviceId);
      if (!stt.ok || !stt.text?.trim()) {
        return res.status(422).json({
          ok: false,
          request_id: requestId,
          locale,
          device_id: deviceId,
          elapsed_ms: Date.now() - startedAt,
          error: stt.error || 'empty_transcript',
          backend: 'native_speech',
        });
      }

      const result = await processIngest({
        requestId,
        text: stt.text.trim(),
        intent,
        sourceId: 'native-mic',
        speaker,
        reflect,
        autoReply,
      });
      return res.status(result.statusCode).json({
        ...result.body,
        stt: {
          ok: true,
          text: stt.text.trim(),
          locale,
          backend: 'native_speech',
          is_final: stt.isFinal !== false,
          device_id: deviceId,
          elapsed_ms: Date.now() - startedAt,
        },
      });
    }

    const requestBase = pathResolver.resolve(`active/shared/tmp/stt-${requestId}`);
    const rawWavPath = `${requestBase}.wav`;
    const normalizedWavPath = `${requestBase}.16k.wav`;

    const record = await recordNativeWav(locale, timeoutSeconds, deviceId, rawWavPath);
    if (!record.ok) {
      logger.info(`[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=record_error error=${record.error || 'record_failed'} elapsed_ms=${Date.now() - startedAt}`);
      return res.status(422).json({
        ok: false,
        request_id: requestId,
        locale,
        device_id: deviceId,
        elapsed_ms: Date.now() - startedAt,
        error: record.error || 'record_failed',
      });
    }

    await convertWavForWhisper(rawWavPath, normalizedWavPath);
    const stt = await transcribeRecordedAudio(
      normalizedWavPath,
      locale,
      backendOrder.filter((backend) => backend !== 'native_speech'),
    );
    if (!stt.ok || !stt.text?.trim()) {
      logger.info(`[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=empty_or_error error=${stt.error || 'empty_transcript'} elapsed_ms=${Date.now() - startedAt}`);
      return res.status(422).json({
        ok: false,
        request_id: requestId,
        locale,
        device_id: deviceId,
        elapsed_ms: Date.now() - startedAt,
        error: stt.error || 'empty_transcript',
        backend: stt.backend,
      });
    }

    const result = await processIngest({
      requestId,
      text: stt.text.trim(),
      intent,
      sourceId: 'native-mic',
      speaker,
      reflect,
      autoReply,
    });
    logger.info(`[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=ok text=${JSON.stringify(stt.text.trim())} elapsed_ms=${Date.now() - startedAt}`);
    return res.status(result.statusCode).json({
      ...result.body,
      stt: {
        ok: true,
        text: stt.text.trim(),
        locale,
        backend: stt.backend || 'unknown',
        is_final: true,
        device_id: deviceId,
        elapsed_ms: Date.now() - startedAt,
        wav_path: rawWavPath,
      },
    });
  } catch (error: any) {
    logger.warn(`[voice-hub] native STT failed: ${error?.message || error}`);
    return res.status(500).json({
      ok: false,
      request_id: requestId,
      locale,
      device_id: deviceId,
      elapsed_ms: Date.now() - startedAt,
      error: error?.message || String(error),
    });
  }
});

app.get('/api/stt/backends', (_req, res) => {
  const available = getAvailableSttBackends();
  const serverConfig = resolveVoiceSttServerConfig(process.env);
  const selected = resolveVoiceSttBackendOrder('auto', available, process.env);
  res.json({
    ok: true,
    available,
    selected,
    server: serverConfig ? {
      base_url: serverConfig.baseUrl,
      model: serverConfig.model,
      provider: serverConfig.provider,
    } : null,
  });
});

app.get('/api/input-devices', async (_req, res) => {
  try {
    const devices = await listNativeInputDevices();
    return res.json(devices);
  } catch (error: any) {
    logger.warn(`[voice-hub] input device listing failed: ${error?.message || error}`);
    return res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  logger.info(`[voice-hub] listening on http://${HOST}:${PORT}`);
  warmPresenceSurfaceAgent();
});
