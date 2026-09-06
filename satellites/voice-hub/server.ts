import express from 'express';
import { installProcessGuards } from '@agent/core/process-guards';
import {
  appendJsonLine,
  getRegisteredEnvText,
  nowIso,
  parseSafeJsonInput,
  setRegisteredEnv,
} from '@agent/core/foundation';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

// IP-08 Task 6: record unhandled rejections/exceptions in this long-lived process.
installProcessGuards('voice-hub');
import {
  buildPresenceAssistantReplyTimeline,
  buildPresenceVoiceIngressTimeline,
  createPresenceVoiceStimulus,
  estimateSpeechDurationMs,
} from '@agent/core/presence-surface';
import { getSurfaceAgentCatalogEntry } from '@agent/core/surface-agent-catalog';
import { getVoiceTtsLanguageConfig } from '@agent/core/voice-tts-config';
import { getVoiceProfileRecord } from '@agent/core/voice-profile-registry';
import {
  getVoiceEngineRegistry,
  resolveVoiceEngineForPlatform,
  type VoiceEngineRecord,
} from '@agent/core/voice-engine-registry';
import { getVoiceSelectionSnapshot } from '@agent/core/voice-selection-preferences';
import {
  resolveVoiceSttAdapter,
  resolveVoiceTtsAdapter,
} from '@agent/core/voice-provider-adapters';
import { createVirtualDeviceInventoryBridge } from '@agent/core/virtual-device-inventory-bridge';
import {
  parseVoiceSttBackend,
  resolveVoiceSttBackendOrder,
  resolveVoiceSttServerConfig,
  type VoiceSttAvailability,
} from '@agent/core/voice-stt';
import { ShellSpeechToTextBridge } from '@agent/core/speech-to-text-bridge';
import { formatChannelTurnText } from '@agent/core/channel-adapter';
import { t } from '@agent/core/t';
import {
  resolveIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent-resolution-contract';
import { runSurfaceConversation, runSurfaceMessageConversation } from '@agent/core/channel-surface';
import {
  assertSafeRepositoryPath,
  buildSafeExecEnv,
  safeReadFile,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeRmSync,
} from '@agent/core/secure-io';
import { resolveManagedToolPythonBin, probeToolRuntime } from '@agent/core/tool-runtime-registry';
import { listenNativeSpeech } from '@agent/core/native-speech-listen-bridge';
import { buildNativeTtsCommand } from '@agent/core/native-tts';
import { normalizeEventScope } from '@agent/core/event-scope';
import { recordVoiceSample } from '@agent/core/voice-sample-recorder';
import { logger } from '@agent/core/core';
import * as pathResolver from '@agent/core/path-resolver';
import type { EventScopeInput } from '@agent/core/event-scope';
import {
  parseVoiceBridgeResponse,
  parseVoiceTranscriptionResponse,
  readVoiceHubEventScope,
  readVoiceHubRequestObject,
} from './request-input.js';

interface VoiceHubRecord {
  id: string;
  request_id?: string;
  text: string;
  source_id: string;
  intent: string;
  ts: string;
}

function resolveVoiceHubPythonBin(): string {
  const configuredPythonBin = getRegisteredEnvText('KYBERION_PYTHON_BIN');
  if (configuredPythonBin) return configuredPythonBin;
  const configuredPython = getRegisteredEnvText('KYBERION_PYTHON');
  if (configuredPython) return configuredPython;
  const managedWhisperPython = resolveManagedToolPythonBin('mlx_whisper');
  if (managedWhisperPython) return managedWhisperPython;
  const managedAudioPython = resolveManagedToolPythonBin('mlx_audio');
  if (managedAudioPython) return managedAudioPython;
  const legacyVenvPython = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(legacyVenvPython)) return legacyVenvPython;
  return 'python3';
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
  engine_id?: string;
}

interface RecentSpeechGuardState {
  text?: string;
  finishedAt?: number;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

const app = express();
const server = createServer(app);

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const PORT = Number(getRegisteredEnvText('VOICE_HUB_PORT') || 3032);
const HOST = getRegisteredEnvText('VOICE_HUB_HOST') || '127.0.0.1';
const PRESENCE_STUDIO_URL = getRegisteredEnvText('PRESENCE_STUDIO_URL') || 'http://127.0.0.1:3031';
const PRESENCE_SURFACE_WARMUP_QUERY = 'Reply with exactly: Ready.';

if (!getRegisteredEnvText('MISSION_ROLE')) {
  setRegisteredEnv('MISSION_ROLE', 'surface_runtime');
}

const recent: VoiceHubRecord[] = [];
const recentResponses = new Map<string, VoiceHubResponseRecord>();
const inflightResponses = new Map<string, Promise<VoiceHubResponseRecord>>();
const conversationMemory = new Map<string, ConversationTurn[]>();
let activeSpeechProcess: ChildProcess | null = null;
let activeSpeechState: SpeechPlaybackState = { status: 'idle' };
let recentSpeechGuardState: RecentSpeechGuardState = {};

function resolveRegularRepositoryFile(filePath: string, label: string): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`${label} must be an existing regular file: ${filePath}`);
  }
  return safePath;
}

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
  if (
    activeSpeechState.status === 'speaking' &&
    activeSpeechText &&
    (normalizedInput === activeSpeechText ||
      activeSpeechText.includes(normalizedInput) ||
      normalizedInput.includes(activeSpeechText))
  ) {
    return true;
  }

  const recentSpeechText = normalizeSpeechEchoText(recentSpeechGuardState.text || '');
  const finishedAt = recentSpeechGuardState.finishedAt || 0;
  if (
    recentSpeechText &&
    finishedAt > 0 &&
    Date.now() - finishedAt < 8000 &&
    (normalizedInput === recentSpeechText ||
      recentSpeechText.includes(normalizedInput) ||
      normalizedInput.includes(recentSpeechText))
  ) {
    return true;
  }

  return false;
}

function requestFingerprint(input: {
  text: string;
  intent: string;
  sourceId: string;
  speaker: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function conversationSessionKey(sourceId: string, speaker: string): string {
  return `${sourceId}::${speaker}`;
}

function rememberConversationTurn(
  sessionKey: string,
  role: 'user' | 'assistant',
  text: string
): void {
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

function pruneRecentResponses(now = Date.now()): void {
  for (const [requestId, record] of recentResponses.entries()) {
    if (now - record.createdAt > 60_000) {
      recentResponses.delete(requestId);
    }
  }
}

const voiceInputInventoryBridge = createVirtualDeviceInventoryBridge();

async function listVoiceInputDevices(): Promise<{
  ok: boolean;
  devices: Array<{ id: number; uid: string; name: string; isDefault: boolean }>;
  defaultDeviceUID?: string;
  error?: string;
}> {
  const probe = await voiceInputInventoryBridge.probe();
  const inputs = probe.inventory.audio_inputs;
  if (inputs.length === 0) {
    return {
      ok: false,
      devices: [],
      error: probe.reason || 'no audio inputs found',
    };
  }
  return {
    ok: true,
    defaultDeviceUID: inputs[0]?.name,
    devices: inputs.map((device, index) => ({
      id: index,
      uid: device.name,
      name: device.name,
      isDefault: index === 0,
    })),
  };
}

async function convertWavForWhisper(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/afconvert',
      ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inputPath, outputPath],
      {
        cwd: pathResolver.rootDir(),
        env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
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

async function transcribeWithWhisperCpp(
  inputPath: string,
  locale: string,
  adapter: ReturnType<typeof resolveVoiceSttAdapter>
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!adapter.cli_path || !adapter.model_path) {
    return { ok: false, error: 'whisper_cpp_paths_not_configured' };
  }
  const cliPath = resolveRegularRepositoryFile(
    pathResolver.resolve(adapter.cli_path),
    'Whisper CLI'
  );
  const modelPath = resolveRegularRepositoryFile(
    pathResolver.resolve(adapter.model_path),
    'Whisper model'
  );
  const safeInputPath = resolveRegularRepositoryFile(inputPath, 'STT input');
  const workingDirectory = path.dirname(cliPath);
  return new Promise((resolve, reject) => {
    const lang = locale.toLowerCase().startsWith('ja') ? 'ja' : 'auto';
    const child = spawn(
      cliPath,
      [
        '-m',
        modelPath,
        '-f',
        safeInputPath,
        '-l',
        lang,
        '--no-timestamps',
        '--suppress-nst',
        '-nth',
        '0.8',
        '-bs',
        '8',
      ],
      {
        cwd: workingDirectory,
        env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
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
      const text = parseWhisperText(`${stdout}\n${stderr}`);
      if (code === 0) {
        return resolve({ ok: true, text });
      }
      reject(new Error(text || stderr.trim() || stdout.trim() || `whisper_cli_failed_${code}`));
    });
  });
}

async function transcribeWithManagedPythonBridge(
  inputPath: string,
  locale: string,
  adapter: ReturnType<typeof resolveVoiceSttAdapter>
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const pythonBin = adapter.runtime_id ? resolveManagedToolPythonBin(adapter.runtime_id) : null;
  if (!pythonBin)
    return { ok: false, error: `${adapter.runtime_id || 'managed'}_runtime_not_installed` };
  if (!adapter.bridge_script) return { ok: false, error: 'managed_stt_bridge_not_configured' };
  const bridgeScript = resolveRegularRepositoryFile(
    pathResolver.rootResolve(adapter.bridge_script),
    'STT bridge script'
  );
  const safeInputPath = resolveRegularRepositoryFile(inputPath, 'STT input');
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [bridgeScript], {
      cwd: pathResolver.rootDir(),
      env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 2_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 200_000);
    });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code) => {
      const lines = stdout.trim().split(/\n+/).filter(Boolean);
      let payload: ReturnType<typeof parseVoiceBridgeResponse>;
      try {
        payload = lines.length
          ? parseVoiceBridgeResponse(
              parseSafeJsonInput(lines[lines.length - 1], 'voice bridge response')
            )
          : undefined;
      } catch {
        payload = undefined;
      }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (code === 0 && payload?.status === 'success' && text) {
        resolve({ ok: true, text });
        return;
      }
      resolve({
        ok: false,
        error:
          (typeof payload?.error === 'string' ? payload.error : undefined) ||
          stderr.trim().slice(0, 500) ||
          `${adapter.backend}_failed_${code ?? 'unknown'}`,
      });
    });
    child.stdin.end(
      JSON.stringify({
        action: 'transcribe',
        params: {
          audio_path: safeInputPath,
          language: locale.toLowerCase().startsWith('ja') ? 'ja' : undefined,
        },
      })
    );
  });
}

async function transcribeWithOpenAiCompatibleServer(
  inputPath: string,
  locale: string
): Promise<{ ok: boolean; text?: string; error?: string; backend: string }> {
  const serverConfig = resolveVoiceSttServerConfig(process.env);
  if (!serverConfig) {
    return {
      ok: false,
      error: 'stt_server_not_configured',
      backend: 'openai_compatible_server',
    };
  }

  const safeInputPath = resolveRegularRepositoryFile(inputPath, 'STT input');
  const audio = safeReadFile(safeInputPath, { encoding: null }) as Buffer;
  const audioBytes = new Uint8Array(audio);
  const form = new FormData();
  form.append('file', new Blob([audioBytes], { type: 'audio/wav' }), path.basename(safeInputPath));
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
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `stt_server_http_${response.status}`,
      backend: serverConfig.provider,
    };
  }

  const payload = parseVoiceTranscriptionResponse(await response.json());
  if (!payload) {
    return {
      ok: false,
      error: 'stt_server_invalid_response',
      backend: serverConfig.provider,
    };
  }
  const text = payload.text.trim();
  return {
    ok: text.length > 0,
    text,
    error: text.length > 0 ? undefined : 'empty_transcript',
    backend: serverConfig.provider,
  };
}

function getAvailableSttBackends() {
  const availability: VoiceSttAvailability = {
    server: false,
    fluidAudio: false,
    fasterWhisper: false,
    mlxWhisper: false,
    whisperCpp: false,
    nativeSpeech: false,
  };
  for (const backend of [
    'server',
    'fluid_audio',
    'faster_whisper',
    'mlx_whisper',
    'whisper_cpp',
    'native_speech',
  ] as const) {
    const adapter = resolveVoiceSttAdapter(backend);
    if (adapter.adapter_id === 'openai_compatible_server') {
      availability.server = resolveVoiceSttServerConfig(process.env) !== null;
    } else if (adapter.adapter_id === 'fluid_audio_native') {
      availability.fluidAudio = Boolean(
        process.platform === 'darwin' &&
        getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_COMMAND')?.trim()
      );
    } else if (adapter.adapter_id === 'faster_whisper_python' && adapter.runtime_id) {
      availability.fasterWhisper = Boolean(
        process.platform === 'win32' &&
        (getRegisteredEnvText('KYBERION_WINDOWS_STT_BACKEND') === 'faster_whisper' ||
          getRegisteredEnvText('KYBERION_STT_MODEL_DIR')?.trim()) &&
        probeToolRuntime(adapter.runtime_id, 'installed').installed
      );
    } else if (adapter.adapter_id === 'managed_python_bridge' && adapter.runtime_id) {
      availability.mlxWhisper = probeToolRuntime(adapter.runtime_id, 'installed').installed;
    } else if (adapter.adapter_id === 'whisper_cpp_cli') {
      availability.whisperCpp = Boolean(
        adapter.cli_path &&
        adapter.model_path &&
        safeExistsSync(pathResolver.resolve(adapter.cli_path)) &&
        safeExistsSync(pathResolver.resolve(adapter.model_path))
      );
    } else if (adapter.adapter_id === 'native_speech') {
      availability.nativeSpeech = safeExistsSync(
        pathResolver.resolve('satellites/voice-hub/native-stt.swift')
      );
    }
  }
  return {
    ...availability,
  };
}

async function transcribeWithFluidAudio(
  inputPath: string,
  locale: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const command = getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_COMMAND')?.trim();
  if (!command) return { ok: false, error: 'fluid_audio_command_not_configured' };

  const bridge = new ShellSpeechToTextBridge({
    name: 'fluid-audio-parakeet',
    command,
    structuredOutput: true,
    timeoutMs: Number(getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_TIMEOUT_MS')) || undefined,
  });
  const transcriptPath = `${inputPath}.transcript.txt`;
  try {
    const result = await bridge.transcribe({ audioPath: inputPath, language: locale });
    const text = result.text.trim();
    return text ? { ok: true, text } : { ok: false, error: 'empty_transcript' };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (safeExistsSync(transcriptPath)) safeRmSync(transcriptPath, { force: true });
  }
}

async function transcribeRecordedAudio(
  inputPath: string,
  locale: string,
  backendOrder: string[]
): Promise<{ ok: boolean; text?: string; error?: string; backend?: string }> {
  let lastError = 'no_stt_backend_available';
  for (const backend of backendOrder) {
    try {
      const adapter = resolveVoiceSttAdapter(parseVoiceSttBackend(backend));
      if (adapter.adapter_id === 'openai_compatible_server') {
        const result = await transcribeWithOpenAiCompatibleServer(inputPath, locale);
        if (result.ok) return result;
        lastError = result.error || lastError;
        continue;
      }

      if (adapter.adapter_id === 'fluid_audio_native') {
        const result = await transcribeWithFluidAudio(inputPath, locale);
        if (result.ok) return { ...result, backend: 'fluid_audio' };
        lastError = result.error || lastError;
        continue;
      }

      if (
        adapter.adapter_id === 'managed_python_bridge' ||
        adapter.adapter_id === 'faster_whisper_python'
      ) {
        const result = await transcribeWithManagedPythonBridge(inputPath, locale, adapter);
        if (result.ok) return { ...result, backend: parseVoiceSttBackend(backend) };
        lastError = result.error || lastError;
        continue;
      }

      if (adapter.adapter_id === 'whisper_cpp_cli') {
        const result = await transcribeWithWhisperCpp(inputPath, locale, adapter);
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

async function stopSpeechPlayback(
  reason: string
): Promise<{ ok: boolean; stopped: boolean; reason: string }> {
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

async function runVoiceTtsPythonBridge(
  engine: VoiceEngineRecord,
  text: string,
  language: string,
  profile: any,
  voice: string,
  rate: number
): Promise<string> {
  if (!engine.bridge_script) {
    throw new Error(`TTS engine ${engine.engine_id} has no bridge_script`);
  }
  const pythonBin = engine.runtime_id
    ? resolveManagedToolPythonBin(engine.runtime_id) || resolveVoiceHubPythonBin()
    : resolveVoiceHubPythonBin();
  if (engine.runtime_id && !resolveManagedToolPythonBin(engine.runtime_id)) {
    throw new Error(`TTS runtime ${engine.runtime_id} is not installed`);
  }
  const bridgeScript = resolveRegularRepositoryFile(
    pathResolver.rootResolve(engine.bridge_script),
    'TTS bridge script'
  );
  const tmpPath = pathResolver.sharedTmp(`voice-playback-${Date.now()}.wav`);
  const samples = profile?.sample_refs || [];
  const refAudio =
    samples.length > 0
      ? resolveRegularRepositoryFile(pathResolver.rootResolve(samples[0]), 'Voice reference audio')
      : undefined;
  const refTextFile = refAudio
    ? assertSafeRepositoryPath(`${refAudio}.transcript.txt`, { allowMissingLeaf: true })
    : undefined;
  let refText: string | undefined;
  if (refTextFile && safeExistsSync(refTextFile) && safeLstat(refTextFile).isFile()) {
    refText = (safeReadFile(refTextFile, { encoding: 'utf8' }) as string).trim();
  }

  const payload = JSON.stringify({
    action: 'generate',
    params: {
      text,
      output_path: tmpPath,
      model: engine.model_id,
      lang_code: language.toLowerCase().startsWith('ja') ? 'ja' : 'en',
      voice,
      rate: String(rate),
      ...(refAudio ? { ref_audio: refAudio } : {}),
      ...(refText ? { ref_text: refText } : {}),
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pythonBin, [bridgeScript], {
        cwd: pathResolver.rootDir(),
        env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk).slice(0, 2_000_000);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk).slice(0, 200_000);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${engine.engine_id} bridge failed: ${stderr.trim() || stdout.trim()}`));
          return;
        }
        const lines = stdout.trim().split(/\n+/).filter(Boolean);
        let result: ReturnType<typeof parseVoiceBridgeResponse>;
        try {
          result = lines.length
            ? parseVoiceBridgeResponse(
                parseSafeJsonInput(lines[lines.length - 1], 'voice bridge response')
              )
            : undefined;
        } catch {
          reject(new Error(`${engine.engine_id} bridge returned non-JSON output`));
          return;
        }
        if (result?.status !== 'success') {
          reject(
            new Error(
              typeof result?.error === 'string' ? result.error : `${engine.engine_id} bridge failed`
            )
          );
          return;
        }
        resolve();
      });
      child.stdin.end(payload);
    });
    return resolveRegularRepositoryFile(tmpPath, `${engine.engine_id} bridge artifact`);
  } catch (error) {
    if (safeExistsSync(tmpPath)) safeRmSync(tmpPath, { force: true });
    throw error;
  }
}

async function playVoiceArtifact(
  artifactPath: string,
  text: string,
  engineId: string
): Promise<void> {
  const safeArtifactPath = resolveRegularRepositoryFile(artifactPath, 'TTS artifact');
  await new Promise<void>((resolve, reject) => {
    const player = spawn('/usr/bin/afplay', [safeArtifactPath], {
      cwd: pathResolver.rootDir(),
      env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    activeSpeechProcess = player;
    activeSpeechState = {
      status: 'speaking',
      text,
      engine_id: engineId,
      startedAt: Date.now(),
      pid: player.pid,
    };
    player.on('close', () => {
      if (activeSpeechProcess === player) {
        activeSpeechProcess = null;
        recentSpeechGuardState = { text, finishedAt: Date.now() };
        activeSpeechState = { status: 'idle' };
      }
      resolve();
    });
    player.on('error', (error) => {
      if (activeSpeechProcess === player) {
        activeSpeechProcess = null;
        activeSpeechState = { status: 'idle' };
      }
      reject(error);
    });
  });
}

async function speakWithVoiceEngine(
  engine: VoiceEngineRecord,
  text: string,
  language: string,
  profile: any
): Promise<void> {
  const adapter = resolveVoiceTtsAdapter(engine);
  const languageProfile = getVoiceTtsLanguageConfig(language);
  if (adapter.adapter_id === 'python_bridge') {
    const artifactPath = await runVoiceTtsPythonBridge(
      engine,
      text,
      language,
      profile,
      languageProfile.voice,
      languageProfile.rate
    );
    try {
      await playVoiceArtifact(artifactPath, text, engine.engine_id);
    } finally {
      if (safeExistsSync(artifactPath)) safeRmSync(artifactPath, { force: true });
    }
    return;
  }
  if (adapter.adapter_id === 'native_tts') {
    const command = buildNativeTtsCommand(text, {
      voice: languageProfile.voice,
      rate: languageProfile.rate,
    });
    if (!command) throw new Error(`Native TTS is unsupported on ${process.platform}`);
    const child = spawn(command.cmd, command.args, {
      cwd: pathResolver.rootDir(),
      env: buildSafeExecEnv({ KYBERION_PROJECT_ROOT: pathResolver.rootDir() }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    activeSpeechProcess = child;
    activeSpeechState = {
      status: 'speaking',
      text,
      engine_id: engine.engine_id,
      startedAt: Date.now(),
      pid: child.pid,
    };
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (activeSpeechProcess === child) {
          activeSpeechProcess = null;
          recentSpeechGuardState = { text, finishedAt: Date.now() };
          activeSpeechState = { status: 'idle' };
        }
        if (code === 0 || signal === 'SIGTERM') return resolve();
        reject(new Error(stderr.trim() || `native_tts_failed_${code || signal || 'unknown'}`));
      });
    });
    return;
  }
  throw new Error(`TTS adapter '${adapter.adapter_id}' is not implemented for ${engine.engine_id}`);
}

async function speakReplyManaged(text: string): Promise<void> {
  await stopSpeechPlayback('replace_reply');

  const language = detectReplyLanguage(text);
  const normalized = normalizeTextForTts(text, language);
  const selection = getVoiceSelectionSnapshot();
  const selected = selection.tts.candidates.find(
    (candidate) =>
      candidate.engine_id === selection.preferences.tts_engine_id && candidate.selectable
  );
  const requestedEngineId = selected?.engine_id || getVoiceEngineRegistry().default_engine_id;
  const engine = resolveVoiceEngineForPlatform(requestedEngineId);
  let voiceProfile: any = null;
  try {
    voiceProfile = getVoiceProfileRecord();
  } catch (error) {
    logger.warn(`[voice-hub] Failed to load voice profile record: ${error}`);
  }

  try {
    await speakWithVoiceEngine(engine, normalized, language, voiceProfile);
  } catch (error) {
    const fallbackId = engine.fallback_engine_id || getVoiceEngineRegistry().default_engine_id;
    const fallback = resolveVoiceEngineForPlatform(fallbackId);
    if (fallback.engine_id === engine.engine_id) throw error;
    logger.warn(
      `[voice-hub] ${engine.engine_id} adapter failed; falling back to ${fallback.engine_id}: ${error instanceof Error ? error.message : String(error)}`
    );
    await speakWithVoiceEngine(fallback, normalized, language, voiceProfile);
  }
}

async function processIngest(input: {
  requestId: string;
  text: string;
  intent: string;
  sourceId: string;
  speaker: string;
  reflect: boolean;
  autoReply: boolean;
  scope?: EventScopeInput;
}) {
  const { requestId, text, intent, sourceId, speaker, reflect, autoReply, scope } = input;
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
    appendJsonLine(STIMULI_PATH, stimulus);

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
    let intentResolution: IntentResolutionContract | undefined;
    let replied = false;
    let replyError: string | undefined;
    let spoken = false;
    let speechError: string | undefined;
    if (autoReply) {
      try {
        const locale = detectReplyLanguage(text);
        let generatedReply: { text: string; intentResolution?: IntentResolutionContract };
        try {
          const result = await runSurfaceMessageConversation(
            buildPresenceSurfaceConversationMessageInput(
              buildPresenceConversationPrompt(text, sessionKey),
              {
                surfaceText: text,
                delegationSummaryInstruction:
                  'Below are delegated responses. Produce the final spoken answer in the user language. Keep it concise and directly answer the user. Do not emit A2A blocks.',
                scope,
                locale,
              }
            )
          );
          const formattedText = formatChannelTurnText(result, {
            includeContract: false,
            locale,
          }).trim();
          generatedReply = {
            text: formattedText || buildVoiceFallbackReply(text),
            intentResolution: result.intentResolution,
          };
        } catch (error: any) {
          logger.warn(`[voice-hub] Shared surface conversation failed: ${error?.message || error}`);
          generatedReply = {
            text: buildVoiceFallbackReply(text),
            intentResolution: resolveIntentResolutionContract(text, {
              locale,
              tier: scope?.tier,
              tenantId: scope?.tenant_slug,
            }),
          };
        }
        replyText = generatedReply.text;
        intentResolution = generatedReply.intentResolution;
        rememberConversationTurn(sessionKey, 'assistant', replyText);
        const speakingMs = estimateSpeechDurationMs(replyText);
        try {
          await reflectTimeline(
            buildPresenceAssistantReplyTimeline({
              agentId: 'presence-surface-agent',
              text: replyText,
              speaking_ms: speakingMs,
            })
          );
        } catch (timelineError: any) {
          logger.warn(
            `[voice-hub] Failed to dispatch assistant reply timeline: ${timelineError?.message || timelineError}`
          );
        }
        speakReplyManaged(replyText)
          .then(() => {
            logger.info('[voice-hub] assistant reply spoken successfully');
          })
          .catch((error: any) => {
            logger.warn(`[voice-hub] speech playback failed: ${error?.message || error}`);
          });
        replied = true;
        spoken = true;
      } catch (error: any) {
        replyError = error?.message || String(error);
        logger.warn(`[voice-hub] Failed to emit assistant reply timeline: ${replyError}`);
        speechError = replyError;
        // UX-01 Task 4: a voice-only user must hear the failure, not silence.
        // Single attempt with .catch — a failing error announcement must not
        // recurse into another announcement.
        const language = detectReplyLanguage(text);
        const spokenFallback = t('surface:voice_hub_error_fallback', undefined, language);
        rememberConversationTurn(sessionKey, 'assistant', spokenFallback);
        replyText = spokenFallback;
        intentResolution = resolveIntentResolutionContract(text, {
          tier: scope?.tier,
          tenantId: scope?.tenant_slug,
        });
        speakReplyManaged(spokenFallback)
          .then(() => {
            logger.info('[voice-hub] spoke error fallback');
          })
          .catch((fallbackError: unknown) => {
            const detail =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            logger.warn(`[voice-hub] error fallback speech failed: ${detail}`);
          });
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
      intentResolution,
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
  })
    .then((result) => {
      logger.info(
        `[voice-hub] presence surface warmup completed: ${JSON.stringify((result.text || '').trim())}`
      );
    })
    .catch((error: any) => {
      logger.warn(`[voice-hub] presence surface warmup failed: ${error?.message || error}`);
    });
}

function buildPresenceSurfaceConversationMessageInput(
  text: string,
  options?: {
    forcedReceiver?: string;
    delegationSummaryInstruction?: string;
    surfaceText?: string;
    locale?: SupportedLocale;
    scope?: EventScopeInput;
  }
): Parameters<typeof runSurfaceMessageConversation>[0] {
  return {
    surface: 'presence',
    text,
    surfaceText: options?.surfaceText,
    channel: 'voice',
    threadTs: 'voice-live',
    actorId: 'voice-user',
    senderAgentId: 'kyberion:voice-hub',
    agentId: 'presence-surface-agent',
    forcedReceiver: options?.forcedReceiver,
    delegationSummaryInstruction: options?.delegationSummaryInstruction,
    locale: options?.locale,
    scope: options?.scope,
  };
}

function detectReplyLanguage(text: string): 'ja' | 'en' {
  return /[ぁ-んァ-ン一-龯]/.test(text) ? 'ja' : 'en';
}

function normalizeTextForTts(text: string, language: SupportedLocale): string {
  const profile = getVoiceTtsLanguageConfig(language);
  const compact = text
    .replace(/\s+/g, ' ')
    .replace(
      /REQ-[A-Z0-9-]+/g,
      profile.requestIdToken || (language === 'ja' ? 'リクエストID' : 'request id')
    )
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

function buildCapabilityReply(language: SupportedLocale): string {
  const profile = getSurfaceAgentCatalogEntry('presence-surface-agent');
  const capabilities = (
    profile?.capabilities || ['presence', 'surface', 'conversation', 'realtime']
  ).join(', ');
  return t('surface:voice_hub_capability_summary', { capabilities }, language);
}

function buildVoiceFallbackReply(userText: string): string {
  const language = detectReplyLanguage(userText);
  const trimmed = userText.trim();
  const normalized = trimmed.toLowerCase();

  if (language === 'ja') {
    if (/^(こんにちは|こんばんは|おはよう|やあ|もしもし)/.test(trimmed)) {
      return t('surface:voice_hub_greeting', undefined, language);
    }
    if (/(何ができる|なにができる|できること|何できる|何をしてくれる)/.test(trimmed)) {
      return buildCapabilityReply('ja');
    }
    if (/(ありがとう|助かった|了解)/.test(trimmed)) {
      return t('surface:voice_hub_thanks', undefined, language);
    }
    if (/[?？]$/.test(trimmed)) {
      return t('surface:voice_hub_question', undefined, language);
    }
    return t('surface:voice_hub_received', undefined, language);
  }

  if (/^(hello|hi|hey)\b/.test(normalized)) {
    return t('surface:voice_hub_greeting', undefined, language);
  }
  if (/\b(what can you do|capabilities|help)\b/.test(normalized)) {
    return buildCapabilityReply('en');
  }
  if (/\b(thanks|thank you)\b/.test(normalized)) {
    return t('surface:voice_hub_thanks', undefined, language);
  }
  if (/[?]$/.test(trimmed)) {
    return t('surface:voice_hub_question', undefined, language);
  }
  return t('surface:voice_hub_received', undefined, language);
}

function withTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

ensureStimuliDir();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    recent: recent.length,
    timestamp: nowIso(),
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
  try {
    const body = readVoiceHubRequestObject(req.body === undefined ? {} : req.body);
    const reason = typeof body.reason === 'string' ? body.reason : 'manual_stop';
    const result = await stopSpeechPlayback(reason);
    res.json(result);
  } catch (error: unknown) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/ingest-text', async (req, res) => {
  let body: Record<string, unknown>;
  try {
    body = readVoiceHubRequestObject(req.body === undefined ? {} : req.body);
  } catch (error: unknown) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const intent = typeof body.intent === 'string' ? body.intent : 'conversation';
  const sourceId = typeof body.source_id === 'string' ? body.source_id : 'local-mic';
  const speaker = typeof body.speaker === 'string' ? body.speaker : 'User';
  const reflect = body.reflect_to_surface !== false;
  const autoReply = body.auto_reply !== false;
  let scope: EventScopeInput | undefined;
  try {
    const parsedScope = readVoiceHubEventScope(body.scope);
    scope = parsedScope ? normalizeEventScope(parsedScope) : undefined;
  } catch (error: unknown) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
  const requestId =
    typeof body.request_id === 'string' && body.request_id.trim()
      ? body.request_id.trim()
      : `vh-${requestFingerprint({ text, intent, sourceId, speaker })}-${randomUUID().slice(0, 8)}`;

  const result = await processIngest({
    requestId,
    text,
    intent,
    sourceId,
    speaker,
    reflect,
    autoReply,
    scope,
  });
  return res.status(result.statusCode).json(result.body);
});

app.post('/api/listen-once', async (req, res) => {
  let body: Record<string, unknown>;
  try {
    body = readVoiceHubRequestObject(req.body === undefined ? {} : req.body);
  } catch (error: unknown) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
  const requestId =
    typeof body.request_id === 'string' && body.request_id.trim()
      ? body.request_id.trim()
      : randomUUID();
  const locale =
    typeof body.locale === 'string' && body.locale.trim() ? body.locale.trim() : 'ja-JP';
  const timeoutSeconds = Number.isFinite(body.timeout_seconds) ? Number(body.timeout_seconds) : 8;
  const intent = typeof body.intent === 'string' ? body.intent : 'conversation';
  const speaker = typeof body.speaker === 'string' ? body.speaker : 'User';
  const deviceId =
    typeof body.device_id === 'string' && body.device_id.trim() ? body.device_id.trim() : undefined;
  const reflect = body.reflect_to_surface !== false;
  const autoReply = body.auto_reply !== false;
  const selection = getVoiceSelectionSnapshot();
  const requestedBackend =
    typeof body.backend === 'string' && body.backend.trim()
      ? parseVoiceSttBackend(body.backend)
      : selection.preferences.stt_backend;
  const startedAt = Date.now();
  const availability = getAvailableSttBackends();
  const backendOrder = resolveVoiceSttBackendOrder(requestedBackend, availability, process.env);

  logger.info(
    `[voice-hub] native STT start request=${requestId} locale=${locale} device=${deviceId || 'default'} timeout=${timeoutSeconds}s`
  );

  try {
    if (backendOrder[0] === 'native_speech') {
      const stt = await listenNativeSpeech({
        locale,
        timeoutSeconds,
        deviceId,
      });
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

    const record = await recordVoiceSample({
      action: 'record_voice_sample',
      request_id: requestId,
      sample_id: `listen-once-${requestId}`,
      duration_sec: timeoutSeconds,
      output_path: rawWavPath,
      input_device_preference: deviceId,
    });
    if (record.status !== 'succeeded' || !record.output_path) {
      logger.info(
        `[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=record_error error=${record.reason || 'record_failed'} elapsed_ms=${Date.now() - startedAt}`
      );
      return res.status(422).json({
        ok: false,
        request_id: requestId,
        locale,
        device_id: deviceId,
        elapsed_ms: Date.now() - startedAt,
        error: record.reason || 'record_failed',
      });
    }

    await convertWavForWhisper(rawWavPath, normalizedWavPath);
    const stt = await transcribeRecordedAudio(
      normalizedWavPath,
      locale,
      backendOrder.filter((backend) => backend !== 'native_speech')
    );
    if (!stt.ok || !stt.text?.trim()) {
      logger.info(
        `[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=empty_or_error error=${stt.error || 'empty_transcript'} elapsed_ms=${Date.now() - startedAt}`
      );
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
    logger.info(
      `[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=ok text=${JSON.stringify(stt.text.trim())} elapsed_ms=${Date.now() - startedAt}`
    );
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
  const selection = getVoiceSelectionSnapshot();
  const selected = resolveVoiceSttBackendOrder(
    selection.preferences.stt_backend,
    available,
    process.env
  );
  res.json({
    ok: true,
    available,
    selected,
    selection: selection.stt,
    server: serverConfig
      ? {
          base_url: serverConfig.baseUrl,
          model: serverConfig.model,
          provider: serverConfig.provider,
        }
      : null,
  });
});

app.get('/api/input-devices', async (_req, res) => {
  try {
    const devices = await listVoiceInputDevices();
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
