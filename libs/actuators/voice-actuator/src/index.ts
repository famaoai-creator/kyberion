import AjvModule from 'ajv';
import {
  compileSchemaFromPath,
  getVoiceSampleIngestionPolicy,
  getVoiceEngineRecord,
  getVoiceProfileRecord,
  getVoiceRuntimePolicy,
  getVoiceTtsLanguageConfig,
  logger,
  pathResolver,
  resolveVoiceEngineForPlatform,
  safeExec,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  validateVoiceProfileRegistration,
  VoiceGenerationRuntime,
  splitVoiceTextIntoChunks,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const voiceActionValidate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/voice-action.schema.json'));

type VoiceAction =
  | { action: 'speak_local'; params: Record<string, unknown> }
  | { action: 'list_voices'; params: Record<string, unknown> }
  | {
    action: 'register_voice_profile';
    request_id: string;
    profile: {
      profile_id: string;
      display_name: string;
      tier: 'personal' | 'confidential' | 'public';
      languages: string[];
      default_engine_id: string;
      notes?: string;
    };
    samples: Array<{ sample_id: string; path: string; language?: string }>;
    policy?: { strict_personal_voice?: boolean };
  }
  | Record<string, any>;

type VoiceArtifactFormat = 'wav' | 'mp3' | 'ogg' | 'aiff';

export async function handleSingleAction(input: VoiceAction) {
  if (input.action === 'speak_local') {
    return speakLocal(((input as any).params || {}));
  }
  if (input.action === 'list_voices') {
    return listVoices();
  }
  if (input.action === 'generate_voice') {
    return generateVoice(input);
  }
  if (input.action === 'register_voice_profile') {
    const payload = (input as any).params
      ? { action: 'register_voice_profile', ...((input as any).params || {}) }
      : input;
    return registerVoiceProfile(payload as any);
  }
  throw new Error(`Unsupported voice action: ${String((input as any)?.action)}`);
}

export async function handleAction(input: VoiceAction) {
  validateVoiceAction(input);
  if ((input as any).action === 'pipeline') {
    const results = [];
    for (const step of (input as any).steps) {
      validateVoiceAction(step);
      results.push(await handleSingleAction(step));
    }
    return { status: 'succeeded', results };
  }
  return handleSingleAction(input);
}

function validateVoiceAction(input: unknown): void {
  const ok = voiceActionValidate(input);
  if (ok) return;
  const detail = (voiceActionValidate.errors || [])
    .map((error: any) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`Invalid voice action: ${detail}`);
}

async function listVoices(): Promise<any> {
  const engine = resolveVoiceEngineForPlatform();
  if (!engine.supports.list_voices) {
    return { status: 'succeeded', voices: [], engine_id: engine.engine_id };
  }

  if (process.platform === 'darwin') {
    const output = safeExec('say', ['-v', '?']);
    const voices = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const voice = line.split(/\s+/)[0];
        return { id: voice, display_name: voice, provider: 'say' };
      });
    return { status: 'succeeded', voices, engine_id: engine.engine_id };
  }

  if (process.platform === 'linux') {
    return {
      status: 'succeeded',
      voices: [{ id: 'espeak-default', display_name: 'espeak default', provider: 'espeak' }],
      engine_id: engine.engine_id,
    };
  }

  if (process.platform === 'win32') {
    return {
      status: 'succeeded',
      voices: [{ id: 'windows-default', display_name: 'Windows Speech Synthesizer', provider: 'sapi' }],
      engine_id: engine.engine_id,
    };
  }

  return { status: 'succeeded', voices: [], engine_id: engine.engine_id };
}

async function speakLocal(params: Record<string, unknown>): Promise<any> {
  const text = String(params.text || '').trim();
  if (!text) throw new Error('speak_local requires params.text');

  const language = String(params.language || '').trim().toLowerCase() || 'en';
  const defaults = getVoiceTtsLanguageConfig(language);
  const voice = typeof params.voice === 'string' && params.voice.trim() ? params.voice.trim() : defaults.voice;
  const rate = Number.isFinite(params.rate) ? Number(params.rate) : defaults.rate;
  const requestedEngineId = String(params.engine_id || 'local_say').trim() || 'local_say';
  const engine = resolveVoiceEngineForPlatform(requestedEngineId);

  await performPlayback(text, { language, voice, rate, engineId: engine.engine_id });
  return {
    status: 'succeeded',
    mode: 'playback',
    engine: engine.kind,
    engine_id: requestedEngineId,
    resolved_engine_id: engine.engine_id,
    language,
    voice,
    rate,
  };
}

async function generateVoice(input: Record<string, any>): Promise<any> {
  const profile = getVoiceProfileRecord(input.profile_ref?.profile_id);
  const policy = getVoiceRuntimePolicy();
  const jobId = String(input.request_id || randomUUID());
  const language = String(input.rendering?.language || profile.languages[0] || 'en').toLowerCase();
  const defaults = getVoiceTtsLanguageConfig(language);
  const maxChunkChars = Number(input.rendering?.chunking?.max_chunk_chars || policy.chunking.default_max_chunk_chars);
  const crossfadeMs = Number(input.rendering?.chunking?.crossfade_ms || policy.chunking.default_crossfade_ms);
  const chunks = splitVoiceTextIntoChunks(String(input.text || ''), maxChunkChars);
  const deliveryMode = String(input.delivery?.mode || 'playback');
  const requestedFormat = String(input.delivery?.format || policy.delivery.default_format) as VoiceArtifactFormat;
  const requestedEngineId = String(input.engine?.engine_id || profile.default_engine_id || '').trim() || profile.default_engine_id;
  const defaultEngine = getVoiceEngineRecord(profile.default_engine_id);
  const engine = resolveVoiceEngineForPlatform(requestedEngineId);
  const personalVoiceMode = String(input.routing?.personal_voice_mode || policy.routing.default_personal_voice_mode);
  const fallbackDetected = engine.engine_id !== requestedEngineId;
  const requiresPersonalVoice = personalVoiceMode === 'require_personal_voice'
    || (policy.routing.enforce_clone_engine_for_personal_tier && profile.tier === 'personal');
  if (requiresPersonalVoice && (engine.kind !== 'voice_clone_service' || fallbackDetected)) {
    return {
      status: 'blocked',
      request_id: jobId,
      profile_id: profile.profile_id,
      profile_tier: profile.tier,
      engine_id: requestedEngineId,
      resolved_engine_id: engine.engine_id,
      fallback_detected: fallbackDetected,
      personal_voice_mode: personalVoiceMode,
      reason: fallbackDetected
        ? `personal voice required but engine resolved to fallback (${engine.engine_id})`
        : `personal voice required but resolved engine is not clone-capable (${engine.engine_id})`,
    };
  }
  const runtime = new VoiceGenerationRuntime(policy);
  const progress_packets: any[] = [];
  runtime.subscribe((packet) => {
    progress_packets.push(packet);
  });

  runtime.enqueue({
    jobId,
    async run(api) {
      api.report({
        status: 'loading_profile',
        progress: { current: 1, total: 4, percent: 25, unit: 'steps' },
        message: `resolved profile ${profile.profile_id}`,
      });
      api.report({
        status: 'loading_model',
        progress: { current: 2, total: 4, percent: 50, unit: 'steps' },
        message: `using engine ${engine.engine_id} (requested: ${requestedEngineId || defaultEngine.engine_id})`,
      });

      let artifactRefs: string[] = [];
      if (deliveryMode === 'artifact' || deliveryMode === 'artifact_and_playback') {
        const artifactRef = renderNativeArtifact(String(input.text || ''), {
          requestId: jobId,
          voice: defaults.voice,
          rate: defaults.rate,
          format: requestedFormat,
          engineId: engine.engine_id,
          supportsFormats: engine.supports.artifact_formats,
          outputPath: input.delivery?.artifact_path,
        });
        artifactRefs = [artifactRef];
      }

      api.report({
        status: 'generating',
        progress: { current: 0, total: Math.max(1, chunks.length), percent: 50, unit: 'chunks' },
        message: `chunking into ${chunks.length} segment(s) with ${crossfadeMs}ms crossfade policy`,
      });

      if (deliveryMode === 'playback' || deliveryMode === 'artifact_and_playback') {
        for (let index = 0; index < chunks.length; index += 1) {
          if (api.isCancelled()) return { artifactRefs };
          api.report({
            status: 'generating',
            progress: {
              current: index + 1,
              total: Math.max(1, chunks.length),
              percent: ((index + 1) / Math.max(1, chunks.length)) * 100,
              unit: 'chunks',
            },
            message: `rendering chunk ${index + 1}/${chunks.length}`,
            artifact_refs: artifactRefs,
          });
          await performPlayback(chunks[index], {
            language,
            voice: defaults.voice,
            rate: defaults.rate,
            engineId: engine.engine_id,
          });
        }
      }

      api.report({
        status: 'persisting',
        progress: { current: 4, total: 4, percent: 100, unit: 'steps' },
        message: 'voice generation runtime completed',
        artifact_refs: artifactRefs,
      });
      return { artifactRefs };
    },
  });

  const finalPacket = await waitForVoiceJob(runtime, jobId);
  return {
    status: finalPacket.status === 'completed' ? 'succeeded' : finalPacket.status,
    request_id: jobId,
    profile_id: profile.profile_id,
    language,
    engine_id: requestedEngineId,
    resolved_engine_id: engine.engine_id,
    chunks: chunks.length,
    progress_packets,
    artifact_refs: finalPacket.artifact_refs || [],
    delivery_mode: deliveryMode,
    format: requestedFormat,
  };
}

async function registerVoiceProfile(input: {
  action: 'register_voice_profile';
  request_id: string;
  profile: {
    profile_id: string;
    display_name: string;
    tier: 'personal' | 'confidential' | 'public';
    languages: string[];
    default_engine_id: string;
    notes?: string;
  };
  samples: Array<{ sample_id: string; path: string; language?: string }>;
  policy?: { strict_personal_voice?: boolean };
}): Promise<any> {
  if (!String(input.request_id || '').trim()) {
    throw new Error('register_voice_profile requires request_id');
  }
  const policy = getVoiceSampleIngestionPolicy();
  const validation = validateVoiceProfileRegistration(input, policy);
  if (!validation.ok) {
    return {
      status: 'blocked',
      action: 'register_voice_profile',
      request_id: input.request_id,
      policy_version: policy.version,
      violations: validation.violations,
      summary: validation.summary,
    };
  }

  const receiptDir = pathResolver.sharedTmp('voice-profile-registration');
  safeMkdir(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `${input.request_id}.json`);
  safeWriteFile(
    receiptPath,
    JSON.stringify(
      {
        kind: 'voice_profile_registration_receipt',
        created_at: new Date().toISOString(),
        status: 'validated_pending_promotion',
        request_id: input.request_id,
        profile: input.profile,
        samples: input.samples,
        summary: validation.summary,
        policy_version: policy.version,
      },
      null,
      2,
    ),
  );

  return {
    status: 'succeeded',
    action: 'register_voice_profile',
    request_id: input.request_id,
    registration_receipt_path: receiptPath,
    summary: validation.summary,
    next_step: 'governance review and profile promotion required',
  };
}

async function performPlayback(
  text: string,
  options: { language: string; voice: string; rate: number; engineId: string },
): Promise<void> {
  const engine = resolveVoiceEngineForPlatform(options.engineId);
  if (!engine.supports.playback) {
    throw new Error(`Voice engine ${engine.engine_id} does not support playback`);
  }

  if (process.platform === 'darwin') {
    safeExec('say', ['-v', options.voice, '-r', String(options.rate), text]);
    return;
  }
  if (process.platform === 'linux') {
    safeExec('espeak', ['-s', String(options.rate), text]);
    return;
  }
  if (process.platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    safeExec('powershell', [
      '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${escaped}')`,
    ]);
    return;
  }
  throw new Error(`Unsupported voice playback platform: ${process.platform}`);
}

function renderNativeArtifact(
  text: string,
  options: {
    requestId: string;
    voice: string;
    rate: number;
    format: VoiceArtifactFormat;
    engineId: string;
    supportsFormats: VoiceArtifactFormat[];
    outputPath?: string;
  },
): string {
  if (!options.supportsFormats.includes(options.format)) {
    throw new Error(`Voice engine ${options.engineId} does not support artifact format ${options.format}`);
  }
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });

  if (process.platform === 'darwin') {
    const format = options.format === 'wav' ? 'aiff' : options.format;
    safeExec('say', ['-v', options.voice, '-r', String(options.rate), '-o', artifactPath, text]);
    return artifactPath.endsWith(`.${format}`) ? artifactPath : `${artifactPath}.${format}`;
  }

  if (process.platform === 'linux') {
    if (options.format !== 'wav') {
      throw new Error(`linux native artifact rendering supports only wav, received ${options.format}`);
    }
    safeExec('espeak', ['-s', String(options.rate), '-w', artifactPath, text]);
    return artifactPath;
  }

  throw new Error(`native artifact rendering is unsupported on ${process.platform}`);
}

function resolveArtifactPath(requestId: string, format: VoiceArtifactFormat, outputPath?: string): string {
  const requestedPath = typeof outputPath === 'string' && outputPath.trim() ? outputPath.trim() : null;
  if (requestedPath) return path.resolve(process.cwd(), requestedPath);
  const safeFormat = process.platform === 'darwin' && format === 'wav' ? 'aiff' : format;
  return pathResolver.sharedTmp(`voice-generation/${requestId}.${safeFormat}`);
}

async function waitForVoiceJob(runtime: VoiceGenerationRuntime, jobId: string): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const packet = runtime.getPacket(jobId);
    if (packet && ['completed', 'failed', 'cancelled'].includes(packet.status)) {
      return packet;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`voice job timed out: ${jobId}`);
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string);
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('voice-actuator/src/index.ts')
  || process.argv[1].endsWith('voice-actuator/dist/index.js')
  || process.argv[1].endsWith('voice-actuator/src/index.js')
);

if (isMain) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
