/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { defineScript, isDirectScript } from './lib/harness.js';
import {
  assertSafeRepositoryPath,
  buildSafeExecEnv,
  safeExistsSync,
  safeMkdir,
} from '@agent/core/secure-io';
import { checkMeetingParticipationConsent } from '@agent/core/meeting-participation-coordinator';
import { createStandardYargs } from '@agent/core/cli-utils';
import { createVoiceActuatorServeClient } from '@agent/core/actuator-serve-client';
import {
  createRealtimeFirstPhraseCache,
  ensureRealtimeVoiceConversationSession,
  generateRealtimeAssistantReply,
  streamRealtimeAssistantReply,
  recordRealtimeVoiceConversationExchange,
  runRealtimeVoiceConversationTurn,
  synthesizeRealtimeVoice,
} from '@agent/core/realtime-voice-conversation';
import { loadRealtimeVoiceConversationPreferences } from '@agent/core/realtime-voice-preferences';
import type {
  RealtimeVoiceReasoningEffort,
  RealtimeVoiceReasoningTier,
} from '@agent/core/realtime-voice-preferences';
import type { PlaybackHandle } from '@agent/core/audio-playback';
import type { AudioChunk } from '@agent/core/meeting-session-types';
import {
  getSpeechToTextBridge,
  installAvailableSpeechToTextBridges,
  resolveSpeechToTextBridge,
  type SpeechToTextBridge,
} from '@agent/core/speech-to-text-bridge';
import { selectStreamingSttBridge } from '@agent/core/streaming-stt-bridge';
import { getStreamingTtsBridge } from '@agent/core/streaming-tts-bridge';
import { installAppleSpeechToTextBridgeIfAvailable } from '@agent/core/apple-intelligence-bridge';
import { installAppleSpeechFileToTextBridgeIfAvailable } from '@agent/core/apple-speech-file-stt-bridge';
import {
  installManagedMlxWhisperStreamingSttBridgeIfAvailable,
  installShellStreamingSttBridgeFromEnv,
} from '@agent/core/shell-streaming-stt-bridge';
import {
  getInstalledReasoningMode,
  installReasoningBackends,
} from '@agent/core/reasoning-bootstrap';
import { installShellStreamingTtsBridgeFromEnv } from '@agent/core/shell-streaming-tts-bridge';
import { installSileroVadBackend } from '@agent/core/silero-vad-bridge';
import { installTenVadBackend } from '@agent/core/ten-vad-bridge';
import { pathResolver } from '@agent/core/path-resolver';
import { probeAudioPlayback } from '@agent/core/audio-playback';
import { playPcmAudioStream, probePcmAudioStreaming } from '@agent/core/streaming-voice-playback';
import { probeMicCapture } from '@agent/core/mic-capture';
import { recordVadTurn, type VadTurnState } from '@agent/core/vad-turn-recorder';
import { resolveManagedToolPythonBin } from '@agent/core/tool-runtime-registry';
import { resolveVadBackend } from '@agent/core/vad-registry';
import {
  costTierForReasoningMode,
  describeRealtimeVoiceLoopEvent,
  detectVoicePowerSource,
  isSpeculativeReplyRequested,
  resolveRealtimeVoiceBargeInMode,
  startRealtimeVoiceLoop,
  type RealtimeVoiceBargeInMode,
  type VoiceCostTier,
  type VoicePowerSource,
} from '@agent/core/realtime-voice-loop';
import type { StreamingSpeechToTextBridge } from '@agent/core/streaming-stt-bridge';
import type { StreamingTextToSpeechBridge } from '@agent/core/streaming-tts-bridge';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { parseSafeJsonInput } from './lib/json-input.js';
import {
  MediaEventBuffer,
  validateMediaSessionDescriptor,
  type MediaEvent,
  type MediaSessionDescriptor,
} from '@agent/core/realtime-media-session';

type DeliveryMode = 'none' | 'artifact' | 'artifact_and_playback';
type PersonalVoiceMode = 'allow_fallback' | 'require_personal_voice';
type RecorderMode = 'vad' | 'fixed';
type LatencyProfile = 'low_latency' | 'balanced';

export interface RealtimeVoiceConversationCliOptions {
  sessionId: string;
  audio?: string;
  profileId?: string;
  language?: string;
  assistantName: string;
  systemPrompt?: string;
  surfaceId: string;
  sourceId: string;
  deliveryMode: DeliveryMode;
  personalVoiceMode: PersonalVoiceMode;
  /** Low-latency selects the governed fast reasoning tier and shorter turn/TTS boundaries. */
  latencyProfile?: LatencyProfile;
  /** Optional exact provider model override; the active provider must support it. */
  reasoningModel?: string;
  /** Optional explicit tier override; otherwise derived from latencyProfile. */
  reasoningModelTier?: RealtimeVoiceReasoningTier;
  /** Optional explicit effort override; otherwise derived from latencyProfile. */
  reasoningEffort?: RealtimeVoiceReasoningEffort;
  interactive: boolean;
  /** 'vad': endpoint-driven capture via mic-capture + EnergyVad. 'fixed': legacy fixed-duration python bridge. */
  recorder: RecorderMode;
  /** Fixed-duration seconds — only used when recorder === 'fixed'. */
  recordSeconds: number;
  /** Safety cap per utterance in VAD mode. */
  maxUtteranceSeconds: number;
  /** Explicit VAD RMS threshold; when absent the recorder calibrates from the noise floor. */
  vadThresholdRms?: number;
  vadEndpointMs: number;
  /** avfoundation index (darwin) / ALSA device (linux) for VAD capture. */
  micDevice?: string;
  /** Barge-in: interrupt assistant speech when the user starts talking. */
  bargeIn: boolean;
  /**
   * Explicit barge-in mode. Unset: two_stage when the latency profile is
   * low_latency and streaming STT is available, otherwise off.
   */
  bargeInMode?: RealtimeVoiceBargeInMode;
  /** Start reasoning speculatively on tentative silence (unset: KYBERION_VOICE_SPECULATIVE_REPLY). */
  speculativeReply?: boolean;
  /** Cache the synthesized first phrase of replies under shared/runtime. */
  firstPhraseCache?: boolean;
  /** Hold trailing-off utterances and join them with the next one (default on). */
  eotHold?: boolean;
  /** Skip reasoning for filler-only turns and own-TTS echo (default on). */
  respondGate?: boolean;
  /** VAD backend id ('energy' | 'silero' | registered custom). */
  vadBackend?: string;
  /** VAD selection purpose (voice.vad-backend policy) when no backend is named. */
  vadPurpose?: string;
  /** STT selection purpose for the batch and streaming STT seams (accuracy, latency, privacy). */
  sttPurpose?: string;
  /** Use streaming STT (KYBERION_STT_COMMAND) during the utterance when available. */
  streamingStt: boolean;
  /** Keep one warm voice-actuator process instead of spawning per segment. */
  warmActuator: boolean;
  /** Mission id carrying recording consent (coordinator-style fail-closed gate). */
  mission?: string;
  /** End the conversation loop after this much listening silence. */
  idleTimeoutSeconds: number;
  /** Max characters per pipelined TTS segment. */
  speechSegmentChars?: number;
  /** Optional canonical media-session sink for meeting/avatar/presence projections. */
  mediaEventBufferFactory?: (sessionId: string) => MediaEventBuffer;
  /** Optional live observer for canonical media-session events. */
  onMediaEvent?: (event: MediaEvent) => void;
  turns?: number;
  recordBridgePath: string;
  pythonBin: string;
  recordOutputDir: string;
}

export interface RealtimeVoiceConversationLoopDeps {
  recordTurnAudio?: (turnIndex: number) => Promise<string>;
  runTurn?: typeof runRealtimeVoiceConversationTurn;
  promptForContinue?: (message: string) => Promise<void>;
}

function reasoningModelTierForOptions(
  options: Pick<RealtimeVoiceConversationCliOptions, 'latencyProfile' | 'reasoningModelTier'>
): RealtimeVoiceReasoningTier | undefined {
  return options.reasoningModelTier ?? (options.latencyProfile !== 'balanced' ? 'fast' : undefined);
}

function reasoningEffortForOptions(
  options: Pick<RealtimeVoiceConversationCliOptions, 'latencyProfile' | 'reasoningEffort'>
): RealtimeVoiceReasoningEffort | undefined {
  return options.reasoningEffort ?? (options.latencyProfile !== 'balanced' ? 'low' : undefined);
}

function reasoningOptionsFor(
  options: Pick<
    RealtimeVoiceConversationCliOptions,
    'latencyProfile' | 'reasoningModel' | 'reasoningModelTier' | 'reasoningEffort'
  >
): {
  model?: string;
  modelTier?: RealtimeVoiceReasoningTier;
  effort?: RealtimeVoiceReasoningEffort;
} {
  const modelTier = reasoningModelTierForOptions(options);
  const effort = reasoningEffortForOptions(options);
  return {
    ...(options.reasoningModel ? { model: options.reasoningModel } : {}),
    ...(modelTier ? { modelTier } : {}),
    ...(effort ? { effort } : {}),
  };
}

function resolvePythonBin(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    getRegisteredEnvText('KYBERION_PYTHON_BIN', { env }),
    getRegisteredEnvText('KYBERION_PYTHON', { env }),
    resolveManagedToolPythonBin('mlx_whisper'),
    resolveManagedToolPythonBin('mlx_audio'),
    '.venv/bin/python3',
    'python3',
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    if (value === '.venv/bin/python3') {
      const venv = pathResolver.rootResolve(value);
      if (safeExistsSync(venv)) return venv;
      continue;
    }
    return value;
  }
  return 'python3';
}

function resolveRecordBridgePath(): string {
  return assertSafeRepositoryPath(
    pathResolver.rootResolve('libs/actuators/voice-actuator/scripts/record_bridge.py')
  );
}

function resolveVoiceRepositoryPath(
  value: unknown,
  label: string,
  allowMissingLeaf = false
): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

function buildRecordPayload(outputPath: string, durationSec: number): string {
  return JSON.stringify({
    action: 'record',
    params: {
      duration: durationSec,
      output_path: outputPath,
    },
  });
}

export interface RecorderBridgeResponse {
  status?: 'success' | 'error' | 'manual_action_required';
  path?: string;
  message?: string;
  error?: string;
}

export function parseRecorderBridgeResponse(raw: string): RecorderBridgeResponse {
  const lines = raw.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = parseSafeJsonInput(trimmed, 'recorder bridge response');
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('recorder bridge response must be a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.status !== undefined &&
      record.status !== 'success' &&
      record.status !== 'error' &&
      record.status !== 'manual_action_required'
    ) {
      throw new Error('recorder bridge response has an invalid status');
    }
    for (const key of ['path', 'message', 'error']) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        throw new Error(`recorder bridge response field ${key} must be a string`);
      }
    }
    if (record.status === undefined && typeof record.error !== 'string') {
      throw new Error('recorder bridge response is missing status');
    }
    return record as RecorderBridgeResponse;
  }
  throw new Error(`Could not find JSON payload in recorder output:\n${raw}`);
}

async function runRecorderTurn(
  input: {
    turnIndex: number;
    sessionId: string;
    recordBridgePath: string;
    pythonBin: string;
    recordSeconds: number;
    recordOutputDir: string;
  },
  print: (value: unknown) => void = () => undefined
): Promise<string> {
  safeMkdir(input.recordOutputDir, { recursive: true });
  const turnLabel = String(input.turnIndex + 1).padStart(2, '0');
  const audioPath = path.join(input.recordOutputDir, `turn-${turnLabel}.wav`);
  const payload = buildRecordPayload(audioPath, input.recordSeconds);
  const child = spawn(input.pythonBin, [input.recordBridgePath, payload], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSafeExecEnv({
      MISSION_ID: `realtime-voice:${input.sessionId}`,
    }),
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    if (text.trim()) print(text.trimEnd());
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(
      `Recorder bridge exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`
    );
  }

  const parsed = parseRecorderBridgeResponse(stdout);
  if (parsed.status !== 'success') {
    throw new Error(
      `Recorder bridge error: ${parsed.message || parsed.error || JSON.stringify(parsed)}`
    );
  }
  if (parsed.path === undefined) return audioPath;
  const returnedPath = resolveVoiceRepositoryPath(parsed.path, 'recorder output path');
  if (path.resolve(returnedPath) !== path.resolve(audioPath)) {
    throw new Error('Recorder bridge returned an unexpected output path');
  }
  return returnedPath;
}

function buildRecordOutputDir(sessionId: string): string {
  return pathResolver.sharedTmp(`realtime-voice-conversation-recordings/${sessionId}`);
}

function describeVadState(state: VadTurnState): string {
  switch (state) {
    case 'calibrating':
      return '🎚  ノイズフロア較正中… (静かにしてください)';
    case 'listening':
      return '🎤 聞き取り待機中… (話し始めてください)';
    case 'recording':
      return '🔴 録音中… (話し終えると自動で区切ります)';
    case 'finalizing':
      return '⏹  発話終了を検出、文字起こしへ回します';
  }
}

async function runVadRecorderTurn(
  input: {
    turnIndex: number;
    options: RealtimeVoiceConversationCliOptions;
  },
  print: (value: unknown) => void = () => undefined
): Promise<string> {
  const { options } = input;
  safeMkdir(options.recordOutputDir, { recursive: true });
  const turnLabel = String(input.turnIndex + 1).padStart(2, '0');
  const audioPath = path.join(options.recordOutputDir, `turn-${turnLabel}.wav`);
  const result = await recordVadTurn({
    outputPath: audioPath,
    mic: {
      sampleRateHz: 16000,
      ...(options.micDevice ? { device: options.micDevice } : {}),
    },
    ...(options.vadThresholdRms !== undefined ? { rmsThreshold: options.vadThresholdRms } : {}),
    endpointMs: options.vadEndpointMs,
    maxUtteranceSeconds: options.maxUtteranceSeconds,
    onState: (state) => print(describeVadState(state)),
  });
  const threshold =
    result.noiseFloorRms === null
      ? `threshold=${result.rmsThreshold}`
      : `threshold=${result.rmsThreshold} (noise floor ${Math.round(result.noiseFloorRms)})`;
  print(
    `   ${(result.durationMs / 1000).toFixed(1)}s captured, ` +
      `${result.endpointed ? 'endpoint detected' : 'max utterance cap hit'}, ${threshold}`
  );
  return result.audioPath;
}

function normalizeTurns(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--turns must be a positive number (got ${String(value)})`);
  }
  return Math.floor(parsed);
}

export async function runRealtimeVoiceConversationInteractive(
  options: RealtimeVoiceConversationCliOptions,
  deps: RealtimeVoiceConversationLoopDeps = {},
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const consent = checkMeetingParticipationConsent({
    ...(options.mission ? { mission_id: options.mission } : {}),
    purpose: 'recording',
  });
  if (!consent.allowed) {
    throw new Error(
      `[realtime-voice-cli] recording consent missing: ${consent.reason || 'not granted'}. ` +
        'Grant it with: pnpm meeting:consent grant --mission <MISSION_ID>'
    );
  }
  const runTurn = deps.runTurn ?? runRealtimeVoiceConversationTurn;
  if (!deps.recordTurnAudio && options.recorder === 'vad') {
    const probe = probeMicCapture({
      ...(options.micDevice ? { device: options.micDevice } : {}),
    });
    if (!probe.available) {
      throw new Error(
        `VAD recorder unavailable: ${probe.reason || 'microphone capture backend missing'}. ` +
          'Install ffmpeg (darwin) / arecord (linux), or fall back with --recorder fixed.'
      );
    }
  }
  const recordTurnAudio =
    deps.recordTurnAudio ??
    (options.recorder === 'vad'
      ? (turnIndex: number) => runVadRecorderTurn({ turnIndex, options }, print)
      : (turnIndex: number) =>
          runRecorderTurn(
            {
              turnIndex,
              sessionId: options.sessionId,
              recordBridgePath: options.recordBridgePath,
              pythonBin: options.pythonBin,
              recordSeconds: options.recordSeconds,
              recordOutputDir: options.recordOutputDir,
            },
            print
          ));

  const promptForContinue =
    deps.promptForContinue ??
    (async (message: string) => {
      const rl = readline.createInterface({ input, output });
      try {
        await rl.question(message);
      } finally {
        rl.close();
      }
    });

  const sttBridge = resolveRealtimeSttBridge(options);
  if (sttBridge.name === 'stub') {
    throw new Error(
      'Realtime interactive voice requires a real STT backend. Set KYBERION_STT_COMMAND or register a SpeechToTextBridge before using --interactive.'
    );
  }

  const maxTurns = options.turns ?? Number.POSITIVE_INFINITY;
  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    // VAD mode turns start on detected speech; the Enter gate only makes
    // sense for the legacy fixed-duration recorder.
    if (turnIndex > 0 && options.recorder === 'fixed') {
      await promptForContinue('\nPress Enter to record the next turn, or Ctrl+C to stop. ');
    }
    print(`\n=== Turn ${turnIndex + 1}${Number.isFinite(maxTurns) ? ` / ${maxTurns}` : ''} ===`);
    const audioPath = await recordTurnAudio(turnIndex);
    const result = await runTurn({
      sessionId: options.sessionId,
      audioPath,
      ...(options.profileId ? { profileId: options.profileId } : {}),
      ...(options.language ? { language: options.language } : {}),
      assistantName: options.assistantName,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      surfaceId: options.surfaceId,
      sourceId: options.sourceId,
      deliveryMode: options.deliveryMode,
      personalVoiceMode: options.personalVoiceMode,
      reasoningModel: options.reasoningModel,
      reasoningModelTier: reasoningModelTierForOptions(options),
      reasoningEffort: reasoningEffortForOptions(options),
    });

    print(`User: ${result.user_text}`);
    print(`Assistant: ${result.assistant_text}`);
    print(`Transcript: ${result.transcript_path}`);
    if (result.audio_artifact_path) {
      print(`Audio artifact: ${result.audio_artifact_path}`);
    }
  }
}

/**
 * Batch STT bridge for the turn loop: the priority default, or the seam's
 * choice when --stt-purpose is given, an operator rule matches the language,
 * or the default cannot transcribe the session language.
 */
function resolveRealtimeSttBridge(
  options: Pick<RealtimeVoiceConversationCliOptions, 'language' | 'sttPurpose'>
): SpeechToTextBridge {
  return resolveSpeechToTextBridge({
    ...(options.sttPurpose ? { purpose: options.sttPurpose } : {}),
    // The stub stays eligible so the caller's "requires a real STT backend" check reports it.
    requires: { allowSynthetic: true, ...(options.language ? { language: options.language } : {}) },
  });
}

const IMMEDIATE_PLAYBACK: PlaybackHandle = {
  done: Promise.resolve({ ok: true, interrupted: false }),
  stop: async () => ({ ok: true, interrupted: false }),
};

/** Default barge-in mode: two_stage needs low latency and streaming-STT partials, else half-duplex. */
export function defaultBargeInMode(
  options: Pick<RealtimeVoiceConversationCliOptions, 'latencyProfile'>,
  streamingSttAvailable: boolean
): RealtimeVoiceBargeInMode {
  return options.latencyProfile !== 'balanced' && streamingSttAvailable ? 'two_stage' : 'off';
}

/**
 * Inputs of the speculative-reply battery/metered guard: the host power source
 * and the cost tier of the installed reasoning backend (unknown ⇒ metered).
 */
export function resolveSpeculativeReplyGuards(
  input: {
    reasoningMode?: string | null;
    detectPowerSource?: () => VoicePowerSource;
  } = {}
): { powerSource: VoicePowerSource; costTier: VoiceCostTier } {
  const mode =
    input.reasoningMode !== undefined ? input.reasoningMode : getInstalledReasoningMode();
  return {
    powerSource: (input.detectPowerSource ?? (() => detectVoicePowerSource()))(),
    costTier: costTierForReasoningMode(mode),
  };
}

export async function runRealtimeVoiceConversationLoop(
  options: RealtimeVoiceConversationCliOptions,
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  const sttBridge = resolveRealtimeSttBridge(options);
  if (sttBridge.name === 'stub') {
    throw new Error(
      'Realtime interactive voice requires a real STT backend. Set KYBERION_STT_COMMAND or register a SpeechToTextBridge before using --interactive.'
    );
  }

  const micProbe = probeMicCapture({
    ...(options.micDevice ? { device: options.micDevice } : {}),
  });
  if (!micProbe.available) {
    throw new Error(
      `VAD recorder unavailable: ${micProbe.reason || 'microphone capture backend missing'}. ` +
        'Install ffmpeg (darwin) / arecord (linux), or fall back with --recorder fixed.'
    );
  }
  const playbackEnabled = options.deliveryMode === 'artifact_and_playback';
  if (playbackEnabled) {
    const playbackProbe = probeAudioPlayback();
    if (!playbackProbe.available) {
      throw new Error(
        `Audio playback unavailable: ${playbackProbe.reason}. Use --delivery-mode none for text-only replies.`
      );
    }
  }

  const session = ensureRealtimeVoiceConversationSession({
    sessionId: options.sessionId,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    assistantName: options.assistantName,
    personalVoiceMode: options.personalVoiceMode,
  });
  const language = options.language || session.language;
  const mediaSession: MediaSessionDescriptor = {
    session_id: session.session_id,
    mode: 'assistant',
    participants: [
      { participant_id: 'local-user', kind: 'human', display_label: 'User' },
      {
        participant_id: 'kyberion-assistant',
        kind: 'agent',
        display_label: session.assistant_name,
        voice_profile_id: session.profile_id,
      },
    ],
  };
  validateMediaSessionDescriptor(mediaSession);
  const mediaEventBuffer =
    options.mediaEventBufferFactory?.(session.session_id) ||
    new MediaEventBuffer(session.session_id);
  const unsubscribeMediaEvents = options.onMediaEvent
    ? mediaEventBuffer.subscribe(options.onMediaEvent)
    : undefined;

  // VAD backend (Phase 3): silero when configured, energy otherwise.
  installSileroVadBackend();
  installTenVadBackend();
  const resolvedVad = resolveVadBackend(options.vadBackend, {
    ...(options.vadPurpose ? { purpose: options.vadPurpose } : {}),
  });
  if (resolvedVad.degradedFrom) {
    print(
      `⚠️  VAD backend '${resolvedVad.degradedFrom}' unavailable (${resolvedVad.degradedReason}); using 'energy'.`
    );
  }
  const vadBackend = resolvedVad.backend;
  if (resolvedVad.decision) {
    print(`🎚️  VAD backend: ${vadBackend.backend_id} (${resolvedVad.decision.rationale})`);
  }

  // Streaming STT (Phase 1): transcription overlaps the utterance when configured.
  let streamingStt: StreamingSpeechToTextBridge | undefined;
  if (options.streamingStt) {
    const installed = installShellStreamingSttBridgeFromEnv();
    if (!installed.installed) installManagedMlxWhisperStreamingSttBridgeIfAvailable();
    // Real transcription only: the stub is never streamed into the loop.
    try {
      const selection = selectStreamingSttBridge({
        ...(options.sttPurpose ? { purpose: options.sttPurpose } : {}),
        requires: { allowSynthetic: false, ...(language ? { language } : {}) },
      });
      if (selection.bridge_id !== 'stub') {
        streamingStt = selection.bridge;
        print(
          selection.bridge_id === 'shell'
            ? '🔁 streaming STT: KYBERION_STT_COMMAND (partials during speech)'
            : selection.bridge_id === 'managed_mlx_whisper'
              ? '🔁 streaming STT: managed mlx_whisper (resident per utterance)'
              : `🔁 streaming STT: ${selection.bridge_id} (${selection.source})`
        );
      }
    } catch (error: unknown) {
      print(
        `⚠️  streaming STT unavailable (${error instanceof Error ? error.message : String(error)}); using batch STT.`
      );
    }
  }

  // Warm actuator (Phase 1): one resident synthesis process per session.
  const warmClient =
    options.warmActuator && options.deliveryMode !== 'none'
      ? createVoiceActuatorServeClient()
      : null;

  let streamingTts: StreamingTextToSpeechBridge | undefined;
  const streamPlaybackCommand = getRegisteredEnvText('KYBERION_TTS_PLAY_COMMAND')
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (playbackEnabled) {
    const installed = installShellStreamingTtsBridgeFromEnv();
    if (installed.installed) {
      const probe = probePcmAudioStreaming();
      if (!probe.available) {
        throw new Error(
          `KYBERION_TTS_COMMAND is configured but direct PCM playback is unavailable: ${probe.reason}`
        );
      }
      streamingTts = getStreamingTtsBridge('shell');
      print('🔊 streaming TTS: KYBERION_TTS_COMMAND → direct PCM playback');
    }
  }

  const firstPhraseCache =
    options.firstPhraseCache && options.deliveryMode !== 'none'
      ? createRealtimeFirstPhraseCache()
      : undefined;
  const synthesizeSegment =
    options.deliveryMode === 'none'
      ? async () => ''
      : async (
          segment: string,
          segmentIndex: number,
          turn: number,
          signal?: AbortSignal
        ): Promise<string> => {
          const synthesis = await synthesizeRealtimeVoice(
            {
              sessionId: session.session_id,
              profileId: session.profile_id,
              language,
              text: segment,
              deliveryMode: 'artifact',
              personalVoiceMode: options.personalVoiceMode,
              requestTag: `t${turn + 1}s${segmentIndex}`,
            },
            warmClient
              ? (payload, requestSignal) => warmClient.request(payload, requestSignal)
              : undefined,
            signal,
            segmentIndex === 0 ? firstPhraseCache : undefined
          );
          if (!synthesis.artifactPath) {
            throw new Error(
              `voice actuator returned no artifact for segment ${segmentIndex} of turn ${turn + 1}`
            );
          }
          return synthesis.artifactPath;
        };

  const bargeInMode = resolveRealtimeVoiceBargeInMode({
    mode:
      options.bargeInMode ??
      (options.bargeIn ? 'legacy' : defaultBargeInMode(options, Boolean(streamingStt))),
  });
  print(
    `\n=== Realtime voice loop — session ${session.session_id} ` +
      `(vad=${vadBackend.backend_id}, barge-in=${bargeInMode}, ` +
      `stt=${streamingStt ? 'streaming' : 'batch'}) ===`
  );
  if (bargeInMode !== 'off') {
    print('   barge-in はスピーカーのエコーで誤動作することがあります。ヘッドセット推奨です。');
  }

  try {
    const handle = await startRealtimeVoiceLoop({
      recordingDir: options.recordOutputDir,
      mic: {
        sampleRateHz: 16000,
        ...(options.micDevice ? { device: options.micDevice } : {}),
      },
      vad: {
        ...(options.vadThresholdRms !== undefined ? { rmsThreshold: options.vadThresholdRms } : {}),
        endpointMs: options.vadEndpointMs,
        maxUtteranceMs: options.maxUtteranceSeconds * 1000,
        vadFactory: (threshold) =>
          vadBackend.create({ rmsThreshold: threshold, endpointMs: options.vadEndpointMs }),
        ...(vadBackend.needsCalibration ? {} : { skipCalibration: true }),
      },
      bargeIn: { mode: bargeInMode },
      eotHold: { enabled: options.eotHold ?? true },
      respondGate: { enabled: options.respondGate ?? true },
      speculativeReply: {
        ...(options.speculativeReply !== undefined ? { enabled: options.speculativeReply } : {}),
        // Probe power/cost only when speculation is actually requested (pmset is synchronous).
        // The probed values (not a fail-open default) are what let the loop's own guard enable it.
        ...(isSpeculativeReplyRequested(options.speculativeReply, process.env)
          ? resolveSpeculativeReplyGuards()
          : {}),
      },
      ...(options.turns !== undefined ? { maxTurns: options.turns } : {}),
      idleTimeoutMs: options.idleTimeoutSeconds * 1000,
      maxSegmentChars: options.speechSegmentChars ?? 120,
      consent: { missionId: options.mission },
      ...(streamingStt ? { streamingStt } : {}),
      transcribe: async (audioPath) => (await sttBridge.transcribe({ audioPath, language })).text,
      reply: (userText) =>
        generateRealtimeAssistantReply(session.session_id, userText, reasoningOptionsFor(options)),
      streamReply: (userText, _turn, onSegment, signal) =>
        streamRealtimeAssistantReply(
          session.session_id,
          userText,
          onSegment,
          signal,
          reasoningOptionsFor(options)
        ),
      synthesizeSegment,
      mediaEventBufferFactory: () => mediaEventBuffer,
      ...(streamingTts
        ? {
            streamingTts,
            voiceProfileId: session.profile_id,
            playAudioStream: (audio: AsyncIterable<AudioChunk>, _index: number) =>
              playPcmAudioStream(audio, {
                ...(streamPlaybackCommand ? { command: streamPlaybackCommand } : {}),
              }),
          }
        : {}),
      ...(!playbackEnabled ? { play: () => IMMEDIATE_PLAYBACK } : {}),
      onEvent: (event) => {
        const message = describeRealtimeVoiceLoopEvent(event);
        if (message) print(message);
      },
      onTurn: (turn) => {
        recordRealtimeVoiceConversationExchange({
          sessionId: session.session_id,
          userText: turn.user_text,
          assistantText: turn.assistant_text,
          userAudioRef: turn.audio_path,
          assistantAudioRef: turn.assistant_audio_paths[0],
        });
        print(`\nUser: ${turn.user_text}`);
        print(`${session.assistant_name}: ${turn.assistant_text}`);
        print(
          `   [turn ${turn.turn + 1}] stt=${turn.metrics.stt_ms}ms (${turn.stt_mode}) ` +
            `llm=${turn.metrics.llm_ms}ms first-audio=${turn.metrics.tts_first_audio_ms ?? '-'}ms ` +
            `speak=${turn.metrics.speak_ms}ms${turn.interrupted ? ' (interrupted)' : ''}`
        );
      },
    });

    const report = await handle.done;
    print(
      `\n=== Loop finished: ${report.turns_completed} turns, ` +
        `${report.interruptions} barge-ins, ended by ${report.ended_by} ===`
    );
    if (report.error) {
      throw new Error(report.error);
    }
  } finally {
    unsubscribeMediaEvents?.();
    await warmClient?.dispose();
  }
}

async function runOneShotConversation(
  options: RealtimeVoiceConversationCliOptions,
  print: (value: unknown) => void
): Promise<void> {
  if (!options.audio) {
    throw new Error('--audio is required unless --interactive is set');
  }
  const result = await runRealtimeVoiceConversationTurn({
    sessionId: options.sessionId,
    audioPath: options.audio,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.language ? { language: options.language } : {}),
    assistantName: options.assistantName,
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    surfaceId: options.surfaceId,
    sourceId: options.sourceId,
    deliveryMode: options.deliveryMode,
    personalVoiceMode: options.personalVoiceMode,
    reasoningModel: options.reasoningModel,
    reasoningModelTier: reasoningModelTierForOptions(options),
    reasoningEffort: reasoningEffortForOptions(options),
  });
  print(JSON.stringify(result, null, 2));
}

export function parseRealtimeVoiceConversationCli(
  argv: Record<string, unknown>
): RealtimeVoiceConversationCliOptions {
  const sessionId = String(argv['session-id'] || '').trim();
  if (!sessionId) throw new Error('--session-id is required');

  const interactive = Boolean(argv.interactive);
  const audio = argv.audio ? String(argv.audio).trim() : undefined;
  if (!interactive && !audio) {
    throw new Error('--audio is required unless --interactive is set');
  }
  if (interactive && !String(argv.mission || '').trim()) {
    throw new Error('--mission is required for interactive recording consent');
  }

  const configured = loadRealtimeVoiceConversationPreferences();
  const latencyProfile = String(
    argv['latency-profile'] ?? configured?.latency_profile ?? 'low_latency'
  ) as LatencyProfile;
  if (latencyProfile !== 'low_latency' && latencyProfile !== 'balanced') {
    throw new Error(
      `--latency-profile must be 'low_latency' or 'balanced' (got ${latencyProfile})`
    );
  }

  const recordSeconds = Number(argv['record-seconds'] ?? 8);
  if (!Number.isFinite(recordSeconds) || recordSeconds <= 0) {
    throw new Error('--record-seconds must be a positive number');
  }

  const recorder = String(argv.recorder ?? 'vad') as RecorderMode;
  if (recorder !== 'vad' && recorder !== 'fixed') {
    throw new Error(`--recorder must be 'vad' or 'fixed' (got ${String(argv.recorder)})`);
  }

  const maxUtteranceSeconds = Number(argv['max-utterance-seconds'] ?? 30);
  if (!Number.isFinite(maxUtteranceSeconds) || maxUtteranceSeconds <= 0) {
    throw new Error('--max-utterance-seconds must be a positive number');
  }

  const vadEndpointMs = Number(
    argv['vad-endpoint-ms'] ?? (latencyProfile === 'low_latency' ? 500 : 700)
  );
  if (!Number.isFinite(vadEndpointMs) || vadEndpointMs <= 0) {
    throw new Error('--vad-endpoint-ms must be a positive number');
  }

  const bargeInModeArg = argv['barge-in-mode'];
  let bargeInMode: RealtimeVoiceBargeInMode | undefined;
  if (bargeInModeArg !== undefined && bargeInModeArg !== null && bargeInModeArg !== '') {
    const requested = String(bargeInModeArg);
    if (requested !== 'off' && requested !== 'legacy' && requested !== 'two_stage') {
      throw new Error(`--barge-in-mode must be 'off', 'legacy' or 'two_stage' (got ${requested})`);
    }
    bargeInMode = requested;
  } else if (argv['barge-in'] === true) {
    bargeInMode = 'legacy';
  } else if (argv['barge-in'] === false) {
    bargeInMode = 'off';
  }

  let vadThresholdRms: number | undefined;
  if (
    argv['vad-threshold'] !== undefined &&
    argv['vad-threshold'] !== null &&
    argv['vad-threshold'] !== ''
  ) {
    vadThresholdRms = Number(argv['vad-threshold']);
    if (!Number.isFinite(vadThresholdRms) || vadThresholdRms <= 0) {
      throw new Error('--vad-threshold must be a positive number');
    }
  }

  return {
    sessionId,
    audio,
    profileId:
      argv['profile-id'] || argv['voice-profile-id']
        ? String(argv['profile-id'] ?? argv['voice-profile-id'])
        : configured?.voice_profile_id,
    language: argv.language ? String(argv.language) : configured?.language,
    assistantName: String(argv['assistant-name'] ?? configured?.assistant_name ?? 'Kyberion'),
    systemPrompt:
      typeof argv['system-prompt'] === 'string'
        ? String(argv['system-prompt'])
        : configured?.system_prompt,
    surfaceId: String(argv['surface-id'] || 'presence-studio'),
    sourceId: String(argv['source-id'] || 'local-mic'),
    deliveryMode:
      (argv['delivery-mode'] as DeliveryMode) ??
      configured?.delivery_mode ??
      'artifact_and_playback',
    personalVoiceMode:
      (argv['personal-voice-mode'] as PersonalVoiceMode) ??
      configured?.personal_voice_mode ??
      'require_personal_voice',
    latencyProfile,
    ...((argv['reasoning-model'] ?? configured?.reasoning_model)
      ? { reasoningModel: String(argv['reasoning-model'] ?? configured?.reasoning_model) }
      : {}),
    ...((argv['reasoning-model-tier'] ?? configured?.reasoning_model_tier)
      ? {
          reasoningModelTier: String(
            argv['reasoning-model-tier'] ?? configured?.reasoning_model_tier
          ) as RealtimeVoiceReasoningTier,
        }
      : {}),
    ...((argv['reasoning-effort'] ?? configured?.reasoning_effort)
      ? {
          reasoningEffort: String(
            argv['reasoning-effort'] ?? configured?.reasoning_effort
          ) as RealtimeVoiceReasoningEffort,
        }
      : {}),
    interactive,
    recorder,
    recordSeconds,
    maxUtteranceSeconds,
    ...(vadThresholdRms !== undefined ? { vadThresholdRms } : {}),
    vadEndpointMs,
    ...(argv['mic-device'] ? { micDevice: String(argv['mic-device']) } : {}),
    bargeIn: Boolean(argv['barge-in']),
    ...(bargeInMode ? { bargeInMode } : {}),
    ...(argv['speculative-reply'] !== undefined
      ? { speculativeReply: Boolean(argv['speculative-reply']) }
      : {}),
    firstPhraseCache: Boolean(argv['first-phrase-cache']),
    eotHold: argv['eot-hold'] === undefined ? true : Boolean(argv['eot-hold']),
    respondGate: argv['respond-gate'] === undefined ? true : Boolean(argv['respond-gate']),
    ...(argv['vad-backend'] ? { vadBackend: String(argv['vad-backend']) } : {}),
    ...(argv['vad-purpose'] ? { vadPurpose: String(argv['vad-purpose']) } : {}),
    ...(argv['stt-purpose'] ? { sttPurpose: String(argv['stt-purpose']) } : {}),
    streamingStt: argv['streaming-stt'] === undefined ? true : Boolean(argv['streaming-stt']),
    warmActuator: argv['warm-actuator'] === undefined ? true : Boolean(argv['warm-actuator']),
    ...(argv.mission ? { mission: String(argv.mission) } : {}),
    idleTimeoutSeconds: (() => {
      const value = Number(argv['idle-timeout-seconds'] ?? 120);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--idle-timeout-seconds must be a positive number');
      }
      return value;
    })(),
    speechSegmentChars: (() => {
      const value = Number(
        argv['speech-segment-chars'] ?? (latencyProfile === 'low_latency' ? 80 : 120)
      );
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--speech-segment-chars must be a positive number');
      }
      return Math.floor(value);
    })(),
    turns: normalizeTurns(argv.turns),
    recordBridgePath: argv['record-bridge-path']
      ? resolveVoiceRepositoryPath(argv['record-bridge-path'], 'record bridge path')
      : resolveRecordBridgePath(),
    pythonBin: argv['python-bin'] ? String(argv['python-bin']) : resolvePythonBin(),
    recordOutputDir: argv['record-output-dir']
      ? resolveVoiceRepositoryPath(argv['record-output-dir'], 'record output directory', true)
      : buildRecordOutputDir(sessionId),
  };
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  await installReasoningBackends();
  installAvailableSpeechToTextBridges();
  if (getSpeechToTextBridge().name === 'stub') {
    await installAppleSpeechToTextBridgeIfAvailable().catch(() => false);
  }
  if (getSpeechToTextBridge().name === 'stub') {
    installAppleSpeechFileToTextBridgeIfAvailable();
  }

  const argv = await createStandardYargs(['node', 'run_realtime_voice_conversation', ...args])
    .option('session-id', { type: 'string', demandOption: true })
    .option('audio', { type: 'string' })
    .option('profile-id', { type: 'string', alias: 'voice-profile-id' })
    .option('language', { type: 'string' })
    .option('assistant-name', { type: 'string' })
    .option('system-prompt', { type: 'string' })
    .option('surface-id', { type: 'string', default: 'presence-studio' })
    .option('source-id', { type: 'string', default: 'local-mic' })
    .option('delivery-mode', {
      type: 'string',
      choices: ['none', 'artifact', 'artifact_and_playback'] as const,
    })
    .option('personal-voice-mode', {
      type: 'string',
      choices: ['allow_fallback', 'require_personal_voice'] as const,
    })
    .option('latency-profile', {
      type: 'string',
      choices: ['low_latency', 'balanced'] as const,
      describe:
        'low_latency uses the governed fast reasoning tier; balanced keeps the configured default model',
    })
    .option('reasoning-model', {
      type: 'string',
      describe:
        'Exact model id override for the selected reasoning provider (for example gpt-5.6-luna)',
    })
    .option('reasoning-model-tier', {
      type: 'string',
      choices: ['fast', 'standard', 'deep'] as const,
      describe: 'Explicit model tier override; otherwise derived from --latency-profile',
    })
    .option('reasoning-effort', {
      type: 'string',
      choices: ['low', 'medium', 'high'] as const,
      describe: 'Explicit provider reasoning effort override',
    })
    .option('interactive', { type: 'boolean', default: false })
    .option('recorder', {
      type: 'string',
      choices: ['vad', 'fixed'] as const,
      default: 'vad',
      describe:
        "'vad' captures each turn until a silence endpoint (mic-capture + EnergyVad); 'fixed' keeps the legacy fixed-duration python bridge",
    })
    .option('record-seconds', {
      type: 'number',
      default: 8,
      describe: 'Recording duration per turn (only used with --recorder fixed)',
    })
    .option('max-utterance-seconds', {
      type: 'number',
      default: 30,
      describe: 'Safety cap per utterance in VAD mode',
    })
    .option('vad-threshold', {
      type: 'number',
      describe: 'Explicit RMS speech threshold; omit to auto-calibrate from the noise floor',
    })
    .option('vad-endpoint-ms', {
      type: 'number',
      describe:
        'Silence duration that ends an utterance; low_latency defaults to 500ms, balanced to 700ms',
    })
    .option('mic-device', {
      type: 'string',
      describe:
        'Mic device for VAD mode (avfoundation index like ":1" on macOS, ALSA device on Linux); omit to auto-select a physical macOS input',
    })
    .option('barge-in', {
      type: 'boolean',
      describe:
        'Legacy barge-in: stop assistant speech on sustained talking (same as --barge-in-mode legacy; headset recommended)',
    })
    .option('barge-in-mode', {
      type: 'string',
      choices: ['off', 'legacy', 'two_stage'] as const,
      describe:
        'Barge-in mode. two_stage pauses playback on speech and stops only when streaming STT hears words (resumes on echo/noise). Default: two_stage with low_latency + streaming STT, else off. KYBERION_VOICE_BARGE_IN_MODE overrides',
    })
    .option('speculative-reply', {
      type: 'boolean',
      describe:
        'Start reasoning on a short pause before the turn is confirmed; the reply is buffered and only spoken if the final transcript matches (needs streaming STT). Default: KYBERION_VOICE_SPECULATIVE_REPLY',
    })
    .option('first-phrase-cache', {
      type: 'boolean',
      default: false,
      describe:
        'Cache the synthesized first phrase of each reply under active/shared/runtime (keyed by engine, voice, profile revision, settings and text)',
    })
    .option('eot-hold', {
      type: 'boolean',
      default: true,
      describe:
        'Hold utterances that trail off (て/けど/えーと…, and/but…) and join them with the next one, up to 1.5s',
    })
    .option('respond-gate', {
      type: 'boolean',
      default: true,
      describe:
        'Do not reply to filler-only turns or (with barge-in on) the assistant echo picked up by the mic',
    })
    .option('vad-backend', {
      type: 'string',
      describe:
        "VAD backend id ('energy' default, 'silero' when KYBERION_SILERO_VAD_MODEL is set; falls back to KYBERION_VAD)",
    })
    .option('vad-purpose', {
      type: 'string',
      describe:
        'VAD selection purpose when no backend is named (voice.vad-backend policy: accuracy, light)',
    })
    .option('stt-purpose', {
      type: 'string',
      describe:
        'STT selection purpose for batch and streaming STT (accuracy, latency, privacy); unset keeps the default bridge',
    })
    .option('streaming-stt', {
      type: 'boolean',
      default: true,
      describe: 'Transcribe during the utterance via KYBERION_STT_COMMAND when configured',
    })
    .option('warm-actuator', {
      type: 'boolean',
      default: true,
      describe: 'Keep one resident voice-actuator process for sentence synthesis',
    })
    .option('speech-segment-chars', {
      type: 'number',
      describe:
        'Max characters per sentence-level TTS segment; low_latency defaults to 80, balanced to 120',
    })
    .option('mission', {
      type: 'string',
      describe: 'Mission id carrying recording consent (fail-closed gate, coordinator-style)',
    })
    .option('idle-timeout-seconds', {
      type: 'number',
      default: 120,
      describe: 'End the loop after this much continuous listening silence',
    })
    .option('turns', { type: 'number' })
    .option('record-bridge-path', { type: 'string' })
    .option('python-bin', { type: 'string' })
    .option('record-output-dir', { type: 'string' })
    .parse();

  const options = parseRealtimeVoiceConversationCli(argv as Record<string, unknown>);
  if (options.interactive) {
    // VAD mode runs the full-duplex loop; 'fixed' keeps the legacy
    // press-Enter / fixed-duration turn recorder.
    if (options.recorder === 'vad') {
      await runRealtimeVoiceConversationLoop(options, print);
      return;
    }
    await runRealtimeVoiceConversationInteractive(options, {}, print);
    return;
  }
  await runOneShotConversation(options, print);
}

const runRealtimeVoiceConversationScript = defineScript({
  name: 'voice:realtime-conversation',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'run_realtime_voice_conversation.ts') ||
  isDirectScript(import.meta.url, 'run_realtime_voice_conversation.js')
) {
  void runRealtimeVoiceConversationScript();
}
