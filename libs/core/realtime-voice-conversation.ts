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
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeExec, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
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
  personalVoiceMode: 'allow_fallback' | 'require_personal_voice',
): VoiceProfileRecord {
  const profile = getVoiceProfileRecord(profileId);
  if (profile.status !== 'active') {
    throw new Error(
      `Voice profile ${profile.profile_id} is ${profile.status}; promotion to active is required before realtime conversation.`,
    );
  }
  if (personalVoiceMode !== 'require_personal_voice') {
    return profile;
  }
  const resolvedEngine = resolveVoiceEngineForPlatform(profile.default_engine_id);
  if (resolvedEngine.engine_id !== profile.default_engine_id || resolvedEngine.kind !== 'voice_clone_service') {
    throw new Error(
      `Voice profile ${profile.profile_id} cannot satisfy strict personal voice mode; requested ${profile.default_engine_id}, resolved ${resolvedEngine.engine_id}.`,
    );
  }
  return profile;
}

function loadRealtimeVoiceConversationSession(sessionId: string): RealtimeVoiceConversationSession | null {
  const targetPath = sessionPath(sessionId);
  if (!safeExistsSync(targetPath)) return null;
  return JSON.parse(safeReadFile(targetPath, { encoding: 'utf8' }) as string) as RealtimeVoiceConversationSession;
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
    input.personalVoiceMode || 'require_personal_voice',
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

function buildConversationContext(session: RealtimeVoiceConversationSession, userText: string): string {
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

function synthesizeAssistantVoice(input: {
  sessionId: string;
  profileId: string;
  language: string;
  text: string;
  deliveryMode: 'artifact' | 'artifact_and_playback';
  personalVoiceMode: 'allow_fallback' | 'require_personal_voice';
}): Record<string, unknown> {
  const requestId = `${input.sessionId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const requestPath = pathResolver.sharedTmp(`realtime-voice-conversation/${requestId}.json`);
  const format = process.platform === 'darwin' ? 'aiff' : 'wav';
  const artifactPath = pathResolver.sharedTmp(`realtime-voice-conversation/${requestId}.${format}`);

  const profile = getVoiceProfileRecord(input.profileId);
  const policy = getVoiceRuntimePolicy();

  safeWriteFile(
    requestPath,
    JSON.stringify(
      {
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
      null,
      2,
    ),
  );
  const raw = safeExec(
    'node',
    ['dist/libs/actuators/voice-actuator/src/index.js', '--input', requestPath],
    { timeoutMs: 120_000 },
  );

  const lines = raw.split('\n');
  const jsonStartIdx = lines.findIndex(l => l.trim().startsWith('{'));
  if (jsonStartIdx === -1) {
    throw new Error(`[voice-actuator] could not find JSON in output: ${raw}`);
  }
  const cleanStdout = lines.slice(jsonStartIdx).join('\n');
  return JSON.parse(cleanStdout) as Record<string, unknown>;
}

export async function runRealtimeVoiceConversationTurn(
  input: RealtimeVoiceConversationTurnInput,
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
  const assistantText = (await backend.delegateTask(
    `Respond to the user's spoken message in ${session.language}. Return only the assistant reply.`,
    buildConversationContext(session, userText),
  )).trim();
  if (!assistantText) {
    throw new Error(`Reasoning backend returned an empty assistant reply for session ${session.session_id}`);
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
    voiceGenerationResult = synthesizeAssistantVoice({
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
    },
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
