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
import { resolveVoiceEngineForPlatform } from './voice-engine-registry.js';

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
    'Keep the answer concise, natural, and easy to say aloud.',
    'Prefer one short paragraph. Ask at most one follow-up question.',
    recentTurns.length ? 'Conversation so far:' : '',
    recentTurns.join('\n'),
    `Latest user utterance: ${userText}`,
  ]
    .filter(Boolean)
    .join('\n');
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
  const format = process.platform === 'darwin' ? 'aiff' : 'wav';
  const artifactPath = pathResolver.sharedTmp(`realtime-voice-conversation/${requestId}.${format}`);

  const profile = getVoiceProfileRecord(input.profileId);
  const policy = getVoiceRuntimePolicy();

  return {
    artifactPath,
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
        artifact_path: artifactPath,
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
  const assistantText = (
    await backend.delegateTask(
      `Respond to the user's spoken message in ${session.language}. Return only the assistant reply.`,
      buildConversationContext(session, userText)
    )
  ).trim();
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
  const assistantText = (
    await backend.delegateTask(
      `Respond to the user's spoken message in ${session.language}. Return only the assistant reply.`,
      buildConversationContext(session, userText)
    )
  ).trim();
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
