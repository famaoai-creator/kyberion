import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  buildPresenceAssistantReplyTimeline,
  buildPresenceVoiceIngressTimeline,
  createPresenceVoiceStimulus,
  estimateSpeechDurationMs,
  logger,
  pathResolver,
  runSurfaceConversation,
  speak,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
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

process.env.MISSION_ROLE ||= 'surface_runtime';

const recent: VoiceHubRecord[] = [];
const recentResponses = new Map<string, VoiceHubResponseRecord>();
const inflightResponses = new Map<string, Promise<VoiceHubResponseRecord>>();

function requestFingerprint(input: { text: string; intent: string; sourceId: string; speaker: string }): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
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
        replyText = await generateReply(text);
        const speakingMs = estimateSpeechDurationMs(replyText);
        await reflectTimeline(buildPresenceAssistantReplyTimeline({ text: replyText, speaking_ms: speakingMs }));
        speak(replyText).then(() => {
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

async function generateReply(userText: string): Promise<string> {
  try {
    const result = await Promise.race([
      runSurfaceConversation({
        agentId: 'presence-surface-agent',
        query: `User said via voice channel:\n${userText}\n\nRespond conversationally in the user's language. Keep it concise and suitable for a spoken realtime companion. Do not emit A2UI or A2A.`,
        senderAgentId: 'kyberion:voice-hub',
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('surface_conversation_timeout')), 4000);
      }),
    ]);
    const text = (result.text || '').trim();
    if (text) return text;
  } catch (error: any) {
    logger.warn(`[voice-hub] Surface conversation failed: ${error?.message || error}`);
  }
  return `I heard you say: ${userText}`;
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
  const startedAt = Date.now();

  logger.info(`[voice-hub] native STT start request=${requestId} locale=${locale} device=${deviceId || 'default'} timeout=${timeoutSeconds}s`);

  try {
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
    const stt = await transcribeWithWhisperCpp(normalizedWavPath, locale);
    if (!stt.ok || !stt.text?.trim()) {
      logger.info(`[voice-hub] native STT end request=${requestId} device=${deviceId || 'default'} status=empty_or_error error=${stt.error || 'empty_transcript'} elapsed_ms=${Date.now() - startedAt}`);
      return res.status(422).json({
        ok: false,
        request_id: requestId,
        locale,
        device_id: deviceId,
        elapsed_ms: Date.now() - startedAt,
        error: stt.error || 'empty_transcript',
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
        backend: 'whisper.cpp',
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
});
