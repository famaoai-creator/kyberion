import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  buildPresenceAssistantReplyTimeline,
  buildPresenceVoiceIngressTimeline,
  estimateSpeechDurationMs,
  type PresenceTimelineAdf,
} from './presence-surface.js';
import { getVoiceProfileRecord, type VoiceProfileRecord } from './voice-profile-registry.js';
import { getVoiceRuntimePolicy } from './voice-runtime-policy.js';
import { getSpeechToTextBridge } from './speech-to-text-bridge.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { createVoiceActuatorServeClient } from './actuator-serve-client.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  resolveVoiceEngineForPlatform,
  type VoiceEngineArtifactFormat,
} from './voice-engine-registry.js';

function resolveVoiceArtifactFormat(
  supportedFormats: readonly VoiceEngineArtifactFormat[],
  policyDefault: 'wav' | 'mp3' | 'ogg'
): VoiceEngineArtifactFormat {
  const preferred: VoiceEngineArtifactFormat[] = [
    policyDefault,
    ...(process.platform === 'darwin' ? (['aiff', 'wav'] as const) : (['wav', 'aiff'] as const)),
    'mp3',
    'ogg',
  ];
  const format = preferred.find((candidate) => supportedFormats.includes(candidate));
  if (!format) {
    throw new Error(
      `Voice engine supports no configured artifact format (${supportedFormats.join(', ') || 'none'})`
    );
  }
  return format;
}

export interface RealtimeVoiceConversationTurn {
  speaker: 'user' | 'assistant';
  text: string;
  ts: string;
  audio_ref?: string;
}

export interface RealtimeVoiceConversationSession {
  session_id: string;
  created_at: string;
  updated_at: string;
  assistant_name: string;
  profile_id: string;
  language: string;
  system_prompt?: string;
  transcript: RealtimeVoiceConversationTurn[];
}

export interface RealtimeVoiceConversationTurnInput {
  sessionId: string;
  audioPath: string;
  profileId?: string;
  language?: string;
  systemPrompt?: string;
  assistantName?: string;
  surfaceId?: string;
  sourceId?: string;
  deliveryMode?: 'none' | 'artifact' | 'artifact_and_playback';
  personalVoiceMode?: 'allow_fallback' | 'require_personal_voice';
}

export interface RealtimeVoiceConversationTurnResult {
  session_id: string;
  profile_id: string;
  language: string;
  user_text: string;
  assistant_text: string;
  transcript_path: string;
  audio_artifact_path?: string;
  voice_generation_result?: Record<string, unknown>;
  input_timeline: PresenceTimelineAdf;
  reply_timeline: PresenceTimelineAdf;
}

const SESSION_DIR = pathResolver.shared('runtime/realtime-voice-conversations');

/** Keep spoken replies short enough to start TTS quickly and sound natural. */
export const REALTIME_VOICE_REPLY_MAX_CHARS = 160;
export const REALTIME_VOICE_REPLY_MAX_SENTENCES = 2;
export const REALTIME_VOICE_REPLY_STREAM_FLUSH_CHARS = 120;

export type RealtimeVoiceReplySegmentHandler = (segment: string) => void | Promise<void>;

function sessionPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error('Realtime voice conversation requires sessionId');
  }
  return normalized;
}

function assertRealtimeVoiceProfileReady(
  profileId: string | undefined,
  personalVoiceMode: 'allow_fallback' | 'require_personal_voice'
): VoiceProfileRecord {
  const profile = getVoiceProfileRecord(profileId);
  if (profile.status !== 'active') {
    throw new Error(
      `Voice profile ${profile.profile_id} is ${profile.status}; promotion to active is required before realtime conversation.`
    );
  }
  if (personalVoiceMode !== 'require_personal_voice') {
    return profile;
  }
  const resolvedEngine = resolveVoiceEngineForPlatform(profile.default_engine_id);
  if (
    resolvedEngine.engine_id !== profile.default_engine_id ||
    resolvedEngine.kind !== 'voice_clone_service'
  ) {
    throw new Error(
      `Voice profile ${profile.profile_id} cannot satisfy strict personal voice mode; requested ${profile.default_engine_id}, resolved ${resolvedEngine.engine_id}.`
    );
  }
  return profile;
}

function loadRealtimeVoiceConversationSession(
  sessionId: string
): RealtimeVoiceConversationSession | null {
  const targetPath = sessionPath(sessionId);
  if (!safeExistsSync(targetPath)) return null;
  return JSON.parse(
    safeReadFile(targetPath, { encoding: 'utf8' }) as string
  ) as RealtimeVoiceConversationSession;
}

function writeRealtimeVoiceConversationSession(session: RealtimeVoiceConversationSession): string {
  safeMkdir(SESSION_DIR, { recursive: true });
  const targetPath = sessionPath(session.session_id);
  safeWriteFile(targetPath, JSON.stringify(session, null, 2));
  return targetPath;
}

export function ensureRealtimeVoiceConversationSession(input: {
  sessionId: string;
  profileId?: string;
  language?: string;
  systemPrompt?: string;
  assistantName?: string;
  personalVoiceMode?: 'allow_fallback' | 'require_personal_voice';
}): RealtimeVoiceConversationSession {
  const sessionId = normalizeSessionId(input.sessionId);
  const existing = loadRealtimeVoiceConversationSession(sessionId);
  if (existing) return existing;

  const profile = assertRealtimeVoiceProfileReady(
    input.profileId,
    input.personalVoiceMode || 'require_personal_voice'
  );
  const now = new Date().toISOString();
  const session: RealtimeVoiceConversationSession = {
    session_id: sessionId,
    created_at: now,
    updated_at: now,
    assistant_name: input.assistantName || 'Kyberion',
    profile_id: profile.profile_id,
    language: input.language || profile.languages[0] || 'ja',
    system_prompt: input.systemPrompt,
    transcript: [],
  };
  writeRealtimeVoiceConversationSession(session);
  return session;
}

function buildConversationContext(
  session: RealtimeVoiceConversationSession,
  userText: string
): string {
  const recentTurns = session.transcript.slice(-8).map((turn) => {
    const speaker = turn.speaker === 'user' ? 'User' : session.assistant_name;
    return `${speaker}: ${turn.text}`;
  });
  return [
    session.system_prompt || 'You are Kyberion in a realtime spoken conversation.',
    'Reply for speech output, not for reading.',
    `Use at most ${REALTIME_VOICE_REPLY_MAX_SENTENCES} short sentences and ${REALTIME_VOICE_REPLY_MAX_CHARS} characters.`,
    'For a greeting or simple acknowledgement, use one natural sentence.',
    'Do not mention internal processing, tools, files, validation, contracts, artifacts, or Kyberion implementation details unless the user explicitly asks about them.',
    'Ask at most one brief follow-up question.',
    recentTurns.length ? 'Conversation so far:' : '',
    recentTurns.join('\n'),
    `Latest user utterance: ${userText}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRealtimeVoiceReplyPrompt(
  session: RealtimeVoiceConversationSession,
  userText: string
): string {
  return `Respond to the user's spoken message in ${session.language}. Return only the natural spoken reply; do not explain your process.\n\n${buildConversationContext(session, userText)}`;
}

function sentenceEndAt(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if ('。！？!?'.includes(text[index])) return index;
  }
  return -1;
}

/**
 * Apply a deterministic speech budget after the model response. The prompt is
 * the primary control; this guard prevents an overlong provider response from
 * turning into a slow TTS monologue.
 */
export function normalizeRealtimeVoiceReply(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/^(?:assistant|kyberion)\s*[:：]\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return '';

  let bounded = cleaned;
  let cursor = 0;
  for (let sentence = 0; sentence < REALTIME_VOICE_REPLY_MAX_SENTENCES; sentence += 1) {
    const end = sentenceEndAt(cleaned, cursor);
    if (end < 0) {
      cursor = cleaned.length;
      break;
    }
    cursor = end + 1;
  }
  if (cursor > 0 && cursor < cleaned.length) bounded = cleaned.slice(0, cursor).trim();

  if (bounded.length <= REALTIME_VOICE_REPLY_MAX_CHARS) return bounded;
  const clipped = bounded.slice(0, REALTIME_VOICE_REPLY_MAX_CHARS);
  const lastEnd = Math.max(
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('！'),
    clipped.lastIndexOf('？'),
    clipped.lastIndexOf('!'),
    clipped.lastIndexOf('?')
  );
  if (lastEnd >= Math.floor(REALTIME_VOICE_REPLY_MAX_CHARS * 0.5)) {
    return clipped.slice(0, lastEnd + 1).trim();
  }
  return `${clipped.trimEnd()}…`;
}

export interface RealtimeVoiceSynthesisInput {
  sessionId: string;
  profileId: string;
  language: string;
  text: string;
  deliveryMode: 'artifact' | 'artifact_and_playback';
  personalVoiceMode: 'allow_fallback' | 'require_personal_voice';
  /** Extra request-id suffix (e.g. `turn3-seg0`) for traceable artifacts. */
  requestTag?: string;
}

/**
 * Executes a voice-actuator payload and returns its parsed JSON result.
 * The default spawns the actuator one-shot; a warm serve-mode client
 * (see actuator-serve-client.ts) can be injected to skip per-request
 * process startup — the realtime loop uses that for sentence segments.
 */
export type VoiceActuatorExecutor = (
  payload: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Record<string, unknown>>;

async function defaultVoiceActuatorExecutor(
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new Error('voice synthesis aborted');
  const client = createVoiceActuatorServeClient({ requestTimeoutMs: 120_000 });
  try {
    return await client.request(payload, signal);
  } finally {
    await client.dispose();
  }
}

export function buildRealtimeVoiceGenerationPayload(input: RealtimeVoiceSynthesisInput): {
  payload: Record<string, unknown>;
  artifactPath: string;
} {
  const requestId = [
    input.sessionId,
    ...(input.requestTag ? [input.requestTag] : []),
    Date.now().toString(36),
    randomUUID().slice(0, 8),
  ].join('-');
  const profile = getVoiceProfileRecord(input.profileId);
  const policy = getVoiceRuntimePolicy();
  const engine = resolveVoiceEngineForPlatform(profile.default_engine_id);
  const format = resolveVoiceArtifactFormat(
    engine.supports.artifact_formats,
    policy.delivery.default_format
  );
  const resolvedArtifactPath = pathResolver.sharedTmp(
    `realtime-voice-conversation/${requestId}.${format}`
  );

  return {
    artifactPath: resolvedArtifactPath,
    payload: {
      action: 'generate_voice',
      request_id: requestId,
      text: input.text,
      profile_ref: { profile_id: input.profileId },
      engine: {
        engine_id: profile.default_engine_id,
      },
      rendering: {
        language: input.language,
        chunking: {
          max_chunk_chars: policy.chunking.default_max_chunk_chars,
          crossfade_ms: policy.chunking.default_crossfade_ms,
          preserve_paralinguistic_tags: true,
        },
      },
      delivery: {
        mode: input.deliveryMode,
        format,
        artifact_path: resolvedArtifactPath,
        emit_progress_packets: false,
      },
      routing: {
        personal_voice_mode: input.personalVoiceMode,
      },
    },
  };
}

export async function synthesizeRealtimeVoice(
  input: RealtimeVoiceSynthesisInput,
  executor?: VoiceActuatorExecutor,
  signal?: AbortSignal
): Promise<{ result: Record<string, unknown>; artifactPath?: string }> {
  const { payload, artifactPath } = buildRealtimeVoiceGenerationPayload(input);
  const result = executor
    ? await executor(payload, signal)
    : await defaultVoiceActuatorExecutor(payload, signal);
  if (signal?.aborted) throw new Error('voice synthesis aborted');
  const artifacts = Array.isArray(result.artifact_refs) ? (result.artifact_refs as string[]) : [];
  const resolvedArtifact =
    artifacts[0] || (safeExistsSync(artifactPath) ? artifactPath : undefined);
  return { result, ...(resolvedArtifact ? { artifactPath: resolvedArtifact } : {}) };
}

async function synthesizeAssistantVoice(input: {
  sessionId: string;
  profileId: string;
  language: string;
  text: string;
  deliveryMode: 'artifact' | 'artifact_and_playback';
  personalVoiceMode: 'allow_fallback' | 'require_personal_voice';
}): Promise<Record<string, unknown>> {
  const { payload } = buildRealtimeVoiceGenerationPayload(input);
  return defaultVoiceActuatorExecutor(payload);
}

/**
 * Generate the assistant reply for a user utterance in an existing
 * session — the LLM step of a turn, extracted so the realtime voice
 * loop can run STT / reply / TTS as separate pipeline stages.
 */
export async function generateRealtimeAssistantReply(
  sessionId: string,
  userText: string
): Promise<string> {
  const session = loadRealtimeVoiceConversationSession(normalizeSessionId(sessionId));
  if (!session) {
    throw new Error(`Realtime voice conversation session not found: ${sessionId}`);
  }
  const backend = getReasoningBackend();
  const assistantText = normalizeRealtimeVoiceReply(
    await backend.prompt(buildRealtimeVoiceReplyPrompt(session, userText))
  );
  if (!assistantText) {
    throw new Error(
      `Reasoning backend returned an empty assistant reply for session ${session.session_id}`
    );
  }
  return assistantText;
}

/**
 * Stream a spoken reply into sentence-sized chunks as soon as the provider
 * produces enough text. Providers without native streaming transparently
 * yield their completed prompt response once, preserving the old behavior.
 */
export async function streamRealtimeAssistantReply(
  sessionId: string,
  userText: string,
  onSegment: RealtimeVoiceReplySegmentHandler,
  signal?: AbortSignal
): Promise<string> {
  const session = loadRealtimeVoiceConversationSession(normalizeSessionId(sessionId));
  if (!session) {
    throw new Error(`Realtime voice conversation session not found: ${sessionId}`);
  }
  const backend = getReasoningBackend();
  const prompt = buildRealtimeVoiceReplyPrompt(session, userText);
  const source = backend.streamPrompt
    ? backend.streamPrompt(prompt, signal ? { signal } : undefined)
    : (async function* fallback(): AsyncGenerator<string> {
        yield await backend.prompt(prompt, signal ? { signal } : undefined);
      })();

  let rawText = '';
  let pending = '';
  let sentencesEmitted = 0;
  const emit = async (text: string): Promise<void> => {
    const normalized = normalizeRealtimeVoiceReply(text);
    if (!normalized) return;
    sentencesEmitted += (normalized.match(/[。！？!?]/gu) || []).length;
    await onSegment(normalized);
  };

  for await (const delta of source) {
    if (signal?.aborted) throw new Error('realtime voice reply stream aborted');
    if (!delta) continue;
    rawText += delta;
    pending += delta;
    while (sentencesEmitted < REALTIME_VOICE_REPLY_MAX_SENTENCES) {
      const end = sentenceEndAt(pending, 0);
      if (end < 0) break;
      const segment = pending.slice(0, end + 1).trim();
      pending = pending.slice(end + 1).trimStart();
      await emit(segment);
    }
    if (
      sentencesEmitted < REALTIME_VOICE_REPLY_MAX_SENTENCES &&
      pending.length >= REALTIME_VOICE_REPLY_STREAM_FLUSH_CHARS
    ) {
      const segment = pending.slice(0, REALTIME_VOICE_REPLY_STREAM_FLUSH_CHARS).trim();
      pending = pending.slice(REALTIME_VOICE_REPLY_STREAM_FLUSH_CHARS).trimStart();
      await emit(segment);
    }
    if (sentencesEmitted >= REALTIME_VOICE_REPLY_MAX_SENTENCES) break;
  }

  if (pending.trim() && sentencesEmitted < REALTIME_VOICE_REPLY_MAX_SENTENCES) {
    await emit(pending);
  }
  const assistantText = normalizeRealtimeVoiceReply(rawText);
  if (!assistantText) {
    throw new Error(
      `Reasoning backend returned an empty assistant reply for session ${session.session_id}`
    );
  }
  return assistantText;
}

/** Append one completed user/assistant exchange to the session transcript. */
export function recordRealtimeVoiceConversationExchange(input: {
  sessionId: string;
  userText: string;
  assistantText: string;
  userAudioRef?: string;
  assistantAudioRef?: string;
}): string {
  const session = loadRealtimeVoiceConversationSession(normalizeSessionId(input.sessionId));
  if (!session) {
    throw new Error(`Realtime voice conversation session not found: ${input.sessionId}`);
  }
  const now = new Date().toISOString();
  session.transcript.push(
    {
      speaker: 'user',
      text: input.userText,
      ts: now,
      ...(input.userAudioRef ? { audio_ref: input.userAudioRef } : {}),
    },
    {
      speaker: 'assistant',
      text: input.assistantText,
      ts: new Date().toISOString(),
      ...(input.assistantAudioRef ? { audio_ref: input.assistantAudioRef } : {}),
    }
  );
  session.updated_at = new Date().toISOString();
  return writeRealtimeVoiceConversationSession(session);
}

export async function runRealtimeVoiceConversationTurn(
  input: RealtimeVoiceConversationTurnInput
): Promise<RealtimeVoiceConversationTurnResult> {
  const session = ensureRealtimeVoiceConversationSession({
    sessionId: input.sessionId,
    profileId: input.profileId,
    language: input.language,
    systemPrompt: input.systemPrompt,
    assistantName: input.assistantName,
    personalVoiceMode: input.personalVoiceMode,
  });
  const stt = getSpeechToTextBridge();
  const transcript = await stt.transcribe({
    audioPath: input.audioPath,
    language: input.language || session.language,
  });
  const userText = transcript.text.trim();
  if (!userText) {
    throw new Error(`Speech-to-text returned empty text for ${input.audioPath}`);
  }

  const backend = getReasoningBackend();
  const assistantText = normalizeRealtimeVoiceReply(
    await backend.prompt(buildRealtimeVoiceReplyPrompt(session, userText))
  );
  if (!assistantText) {
    throw new Error(
      `Reasoning backend returned an empty assistant reply for session ${session.session_id}`
    );
  }

  const now = new Date().toISOString();
  const inputTimeline = buildPresenceVoiceIngressTimeline({
    surfaceId: input.surfaceId,
    text: userText,
    speaker: 'User',
    agentId: 'presence-surface-agent',
  });
  const replyTimeline = buildPresenceAssistantReplyTimeline({
    surfaceId: input.surfaceId,
    text: assistantText,
    speaker: session.assistant_name,
    agentId: 'presence-surface-agent',
    speaking_ms: estimateSpeechDurationMs(assistantText),
  });

  let audioArtifactPath: string | undefined;
  let voiceGenerationResult: Record<string, unknown> | undefined;
  const deliveryMode = input.deliveryMode || 'artifact_and_playback';
  if (deliveryMode !== 'none') {
    voiceGenerationResult = await synthesizeAssistantVoice({
      sessionId: session.session_id,
      profileId: session.profile_id,
      language: input.language || session.language,
      text: assistantText,
      deliveryMode,
      personalVoiceMode: input.personalVoiceMode || 'require_personal_voice',
    });
    const artifacts = Array.isArray(voiceGenerationResult.artifact_refs)
      ? (voiceGenerationResult.artifact_refs as string[])
      : [];
    audioArtifactPath = artifacts[0];
  }

  session.transcript.push(
    {
      speaker: 'user',
      text: userText,
      ts: now,
      audio_ref: input.audioPath,
    },
    {
      speaker: 'assistant',
      text: assistantText,
      ts: new Date().toISOString(),
      ...(audioArtifactPath ? { audio_ref: audioArtifactPath } : {}),
    }
  );
  session.updated_at = new Date().toISOString();
  const transcriptPath = writeRealtimeVoiceConversationSession(session);

  return {
    session_id: session.session_id,
    profile_id: session.profile_id,
    language: input.language || session.language,
    user_text: userText,
    assistant_text: assistantText,
    transcript_path: transcriptPath,
    ...(audioArtifactPath ? { audio_artifact_path: audioArtifactPath } : {}),
    ...(voiceGenerationResult ? { voice_generation_result: voiceGenerationResult } : {}),
    input_timeline: inputTimeline,
    reply_timeline: replyTimeline,
  };
}
