import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import {
  buildPresenceAssistantReplyTimeline,
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
  listAgentRuntimeSnapshots,
  listSurfaceAsyncRequests,
  listSurfaceNotifications,
  logger,
  pathResolver,
  parseVoiceSttBackend,
  reflectPresenceAgentReply,
  resolveVoiceSttBackendOrder,
  resolveVoiceSttServerConfig,
  runSurfaceConversation,
  safeExec,
  safeReadFile,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  updateSurfaceAsyncRequest,
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

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
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
let activeSpeechProcess: ChildProcessWithoutNullStreams | null = null;
let activeSpeechState: SpeechPlaybackState = { status: 'idle' };

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
        await reflectTimeline(buildPresenceAssistantReplyTimeline({
          agentId: 'presence-surface-agent',
          text: replyText,
          speaking_ms: speakingMs,
        }));
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
    const forcedReceiver = deriveSurfaceDelegationReceiver(userText);
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
