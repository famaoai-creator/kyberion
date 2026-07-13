/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildSafeExecEnv,
  createStandardYargs,
  getSpeechToTextBridge,
  installReasoningBackends,
  pathResolver,
  resolveManagedToolPythonBin,
  runRealtimeVoiceConversationTurn,
  safeExistsSync,
  safeMkdir,
} from '@agent/core';

type DeliveryMode = 'none' | 'artifact' | 'artifact_and_playback';
type PersonalVoiceMode = 'allow_fallback' | 'require_personal_voice';

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
  recordSeconds: number;
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
  const runTurn = deps.runTurn ?? runRealtimeVoiceConversationTurn;
  const recordTurnAudio =
    deps.recordTurnAudio ??
    ((turnIndex: number) =>
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
    if (turnIndex > 0) {
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

  const recordSeconds = Number(argv['record-seconds'] ?? 8);
  if (!Number.isFinite(recordSeconds) || recordSeconds <= 0) {
    throw new Error('--record-seconds must be a positive number');
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
    recordSeconds: Math.floor(recordSeconds),
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
    .option('record-seconds', { type: 'number', default: 8 })
    .option('turns', { type: 'number' })
    .option('record-bridge-path', { type: 'string' })
    .option('python-bin', { type: 'string' })
    .option('record-output-dir', { type: 'string' })
    .parse();

  const options = parseRealtimeVoiceConversationCli(argv as Record<string, unknown>);
  if (options.interactive) {
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
