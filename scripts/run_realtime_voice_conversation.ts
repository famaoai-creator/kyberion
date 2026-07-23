/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSafeExecEnv,
  checkMeetingParticipationConsent,
  createStandardYargs,
  createVoiceActuatorServeClient,
  ensureRealtimeVoiceConversationSession,
  generateRealtimeAssistantReply,
  getSpeechToTextBridge,
  getStreamingSttBridge,
  installReasoningBackends,
  installShellStreamingSttBridgeFromEnv,
  installSileroVadBackend,
  installTenVadBackend,
  pathResolver,
  probeAudioPlayback,
  probeMicCapture,
  recordRealtimeVoiceConversationExchange,
  recordVadTurn,
  resolveManagedToolPythonBin,
  resolveVadBackend,
  runRealtimeVoiceConversationTurn,
  safeExistsSync,
  safeMkdir,
  startRealtimeVoiceLoop,
  synthesizeRealtimeVoice,
  type PlaybackHandle,
  type RealtimeVoiceLoopEvent,
  type StreamingSpeechToTextBridge,
  type VadTurnState,
} from '@agent/core';

type DeliveryMode = 'none' | 'artifact' | 'artifact_and_playback';
type PersonalVoiceMode = 'allow_fallback' | 'require_personal_voice';
type RecorderMode = 'vad' | 'fixed';

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
  /** VAD backend id ('energy' | 'silero' | registered custom). */
  vadBackend?: string;
  /** Use streaming STT (KYBERION_STT_COMMAND) during the utterance when available. */
  streamingStt: boolean;
  /** Keep one warm voice-actuator process instead of spawning per segment. */
  warmActuator: boolean;
  /** Mission id carrying recording consent (coordinator-style fail-closed gate). */
  mission?: string;
  /** End the conversation loop after this much listening silence. */
  idleTimeoutSeconds: number;
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

function resolvePythonBin(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.KYBERION_PYTHON_BIN,
    env.KYBERION_PYTHON,
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
  return pathResolver.rootResolve('libs/actuators/voice-actuator/scripts/record_bridge.py');
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

function parseTrailingJson(raw: string): any {
  const lines = raw.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  throw new Error(`Could not find JSON payload in recorder output:\n${raw}`);
}

async function runRecorderTurn(input: {
  turnIndex: number;
  sessionId: string;
  recordBridgePath: string;
  pythonBin: string;
  recordSeconds: number;
  recordOutputDir: string;
}): Promise<string> {
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
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    process.stderr.write(text);
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

  const parsed = parseTrailingJson(stdout);
  if (parsed.status !== 'success') {
    throw new Error(
      `Recorder bridge error: ${parsed.message || parsed.error || JSON.stringify(parsed)}`
    );
  }
  return String(parsed.path || audioPath);
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

async function runVadRecorderTurn(input: {
  turnIndex: number;
  options: RealtimeVoiceConversationCliOptions;
}): Promise<string> {
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
    onState: (state) => console.log(describeVadState(state)),
  });
  const threshold =
    result.noiseFloorRms === null
      ? `threshold=${result.rmsThreshold}`
      : `threshold=${result.rmsThreshold} (noise floor ${Math.round(result.noiseFloorRms)})`;
  console.log(
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
  deps: RealtimeVoiceConversationLoopDeps = {}
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
      ? (turnIndex: number) => runVadRecorderTurn({ turnIndex, options })
      : (turnIndex: number) =>
          runRecorderTurn({
            turnIndex,
            sessionId: options.sessionId,
            recordBridgePath: options.recordBridgePath,
            pythonBin: options.pythonBin,
            recordSeconds: options.recordSeconds,
            recordOutputDir: options.recordOutputDir,
          }));

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

  const sttBridge = getSpeechToTextBridge();
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
    console.log(
      `\n=== Turn ${turnIndex + 1}${Number.isFinite(maxTurns) ? ` / ${maxTurns}` : ''} ===`
    );
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
    });

    console.log(`User: ${result.user_text}`);
    console.log(`Assistant: ${result.assistant_text}`);
    console.log(`Transcript: ${result.transcript_path}`);
    if (result.audio_artifact_path) {
      console.log(`Audio artifact: ${result.audio_artifact_path}`);
    }
  }
}

function describeLoopEvent(event: RealtimeVoiceLoopEvent): string | null {
  switch (event.kind) {
    case 'state':
      switch (event.state) {
        case 'calibrating':
          return '🎚  ノイズフロア較正中… (静かにしてください)';
        case 'listening':
          return '🎤 聞き取り中… (話し終えると自動で区切ります)';
        case 'thinking':
          return '💭 応答を生成中…';
        case 'speaking':
          return '🔊 応答を再生中…';
        default:
          return null;
      }
    case 'barge_in':
      return '✋ 割り込みを検知 — 再生を停止して聞き取りに戻ります';
    case 'utterance_captured':
      return `   (${(event.duration_ms / 1000).toFixed(1)}s captured, ${event.endpointed ? 'endpoint' : 'cap'})`;
    case 'degraded':
      return `⚠️  ${event.what}: ${event.reason}`;
    default:
      return null;
  }
}

const IMMEDIATE_PLAYBACK: PlaybackHandle = {
  done: Promise.resolve({ ok: true, interrupted: false }),
  stop: async () => ({ ok: true, interrupted: false }),
};

export async function runRealtimeVoiceConversationLoop(
  options: RealtimeVoiceConversationCliOptions
): Promise<void> {
  const sttBridge = getSpeechToTextBridge();
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

  // VAD backend (Phase 3): silero when configured, energy otherwise.
  installSileroVadBackend();
  installTenVadBackend();
  const resolvedVad = resolveVadBackend(options.vadBackend);
  if (resolvedVad.degradedFrom) {
    console.warn(
      `⚠️  VAD backend '${resolvedVad.degradedFrom}' unavailable (${resolvedVad.degradedReason}); using 'energy'.`
    );
  }
  const vadBackend = resolvedVad.backend;

  // Streaming STT (Phase 1): transcription overlaps the utterance when configured.
  let streamingStt: StreamingSpeechToTextBridge | undefined;
  if (options.streamingStt) {
    const installed = installShellStreamingSttBridgeFromEnv();
    if (installed.installed) {
      streamingStt = getStreamingSttBridge('shell');
      console.log('🔁 streaming STT: KYBERION_STT_COMMAND (partials during speech)');
    }
  }

  // Warm actuator (Phase 1): one resident synthesis process per session.
  const warmClient =
    options.warmActuator && options.deliveryMode !== 'none'
      ? createVoiceActuatorServeClient()
      : null;

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
            signal
          );
          if (!synthesis.artifactPath) {
            throw new Error(
              `voice actuator returned no artifact for segment ${segmentIndex} of turn ${turn + 1}`
            );
          }
          return synthesis.artifactPath;
        };

  console.log(
    `\n=== Realtime voice loop — session ${session.session_id} ` +
      `(vad=${vadBackend.backend_id}, barge-in=${options.bargeIn ? 'on' : 'off'}, ` +
      `stt=${streamingStt ? 'streaming' : 'batch'}) ===`
  );
  if (options.bargeIn) {
    console.log(
      '   barge-in はスピーカーのエコーで誤動作することがあります。ヘッドセット推奨です。'
    );
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
      bargeIn: { enabled: options.bargeIn },
      ...(options.turns !== undefined ? { maxTurns: options.turns } : {}),
      idleTimeoutMs: options.idleTimeoutSeconds * 1000,
      consent: { missionId: options.mission },
      ...(streamingStt ? { streamingStt } : {}),
      transcribe: async (audioPath) => (await sttBridge.transcribe({ audioPath, language })).text,
      reply: (userText) => generateRealtimeAssistantReply(session.session_id, userText),
      synthesizeSegment,
      ...(!playbackEnabled ? { play: () => IMMEDIATE_PLAYBACK } : {}),
      onEvent: (event) => {
        const message = describeLoopEvent(event);
        if (message) console.log(message);
      },
      onTurn: (turn) => {
        recordRealtimeVoiceConversationExchange({
          sessionId: session.session_id,
          userText: turn.user_text,
          assistantText: turn.assistant_text,
          userAudioRef: turn.audio_path,
        });
        console.log(`\nUser: ${turn.user_text}`);
        console.log(`${session.assistant_name}: ${turn.assistant_text}`);
        console.log(
          `   [turn ${turn.turn + 1}] stt=${turn.metrics.stt_ms}ms (${turn.stt_mode}) ` +
            `llm=${turn.metrics.llm_ms}ms first-audio=${turn.metrics.tts_first_audio_ms ?? '-'}ms ` +
            `speak=${turn.metrics.speak_ms}ms${turn.interrupted ? ' (interrupted)' : ''}`
        );
      },
    });

    const report = await handle.done;
    console.log(
      `\n=== Loop finished: ${report.turns_completed} turns, ` +
        `${report.interruptions} barge-ins, ended by ${report.ended_by} ===`
    );
    if (report.error) {
      throw new Error(report.error);
    }
  } finally {
    await warmClient?.dispose();
  }
}

async function runOneShotConversation(options: RealtimeVoiceConversationCliOptions): Promise<void> {
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
  });
  console.log(JSON.stringify(result, null, 2));
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

  const vadEndpointMs = Number(argv['vad-endpoint-ms'] ?? 700);
  if (!Number.isFinite(vadEndpointMs) || vadEndpointMs <= 0) {
    throw new Error('--vad-endpoint-ms must be a positive number');
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
    profileId: argv['profile-id'] ? String(argv['profile-id']) : undefined,
    language: argv.language ? String(argv.language) : undefined,
    assistantName: String(argv['assistant-name'] || 'Kyberion'),
    systemPrompt: argv['system-prompt'] ? String(argv['system-prompt']) : undefined,
    surfaceId: String(argv['surface-id'] || 'presence-studio'),
    sourceId: String(argv['source-id'] || 'local-mic'),
    deliveryMode: (argv['delivery-mode'] as DeliveryMode) || 'artifact_and_playback',
    personalVoiceMode:
      (argv['personal-voice-mode'] as PersonalVoiceMode) || 'require_personal_voice',
    interactive,
    recorder,
    recordSeconds: Math.floor(recordSeconds),
    maxUtteranceSeconds,
    ...(vadThresholdRms !== undefined ? { vadThresholdRms } : {}),
    vadEndpointMs,
    ...(argv['mic-device'] ? { micDevice: String(argv['mic-device']) } : {}),
    bargeIn: Boolean(argv['barge-in']),
    ...(argv['vad-backend'] ? { vadBackend: String(argv['vad-backend']) } : {}),
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
    turns: normalizeTurns(argv.turns),
    recordBridgePath: argv['record-bridge-path']
      ? pathResolver.rootResolve(String(argv['record-bridge-path']))
      : resolveRecordBridgePath(),
    pythonBin: argv['python-bin'] ? String(argv['python-bin']) : resolvePythonBin(),
    recordOutputDir: argv['record-output-dir']
      ? pathResolver.rootResolve(String(argv['record-output-dir']))
      : buildRecordOutputDir(sessionId),
  };
}

export async function main(): Promise<void> {
  await installReasoningBackends();

  const argv = await createStandardYargs()
    .option('session-id', { type: 'string', demandOption: true })
    .option('audio', { type: 'string' })
    .option('profile-id', { type: 'string' })
    .option('language', { type: 'string' })
    .option('assistant-name', { type: 'string', default: 'Kyberion' })
    .option('system-prompt', { type: 'string' })
    .option('surface-id', { type: 'string', default: 'presence-studio' })
    .option('source-id', { type: 'string', default: 'local-mic' })
    .option('delivery-mode', {
      type: 'string',
      choices: ['none', 'artifact', 'artifact_and_playback'] as const,
      default: 'artifact_and_playback',
    })
    .option('personal-voice-mode', {
      type: 'string',
      choices: ['allow_fallback', 'require_personal_voice'] as const,
      default: 'require_personal_voice',
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
      default: 700,
      describe: 'Silence duration that ends an utterance in VAD mode',
    })
    .option('mic-device', {
      type: 'string',
      describe:
        'Mic device for VAD mode (avfoundation index like ":1" on macOS, ALSA device on Linux); omit to auto-select a physical macOS input',
    })
    .option('barge-in', {
      type: 'boolean',
      default: false,
      describe: 'Interrupt assistant speech when you start talking (headset recommended)',
    })
    .option('vad-backend', {
      type: 'string',
      describe:
        "VAD backend id ('energy' default, 'silero' when KYBERION_SILERO_VAD_MODEL is set; falls back to KYBERION_VAD)",
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
      await runRealtimeVoiceConversationLoop(options);
      return;
    }
    await runRealtimeVoiceConversationInteractive(options);
    return;
  }
  await runOneShotConversation(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
