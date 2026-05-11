import AjvModule from 'ajv';
import {
  collectVoiceSamples,
  compileSchemaFromPath,
  classifyError,
  getVoiceSampleIngestionPolicy,
  getVoiceEngineRecord,
  getVoiceProfileRecord,
  getVoiceProfileRegistry,
  getVoiceRuntimePolicy,
  getVoiceTtsLanguageConfig,
  logger,
  pathResolver,
  recordInteraction,
  resolveVars,
  resolveVoiceEngineForPlatform,
  recordVoiceSample,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  withRetry,
  validateVoiceProfileRegistration,
  VoiceGenerationRuntime,
  writeVoiceProfileRegistry,
  splitVoiceTextIntoChunks,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

function resolvePythonBin(): string {
  if (process.env.KYBERION_PYTHON) return process.env.KYBERION_PYTHON;
  const venvPython = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(venvPython)) return venvPython;
  return 'python3';
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(VOICE_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_VOICE_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const voiceActionValidate = compileSchemaFromPath(ajv, pathResolver.rootResolve('schemas/voice-action.schema.json'));
const VOICE_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/voice-actuator/manifest.json');
const DEFAULT_VOICE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

type VoiceAction =
  | { action: 'speak_local'; params: Record<string, unknown> }
  | { action: 'list_voices'; params: Record<string, unknown> }
  | {
    action: 'record_voice_sample';
    request_id: string;
    sample_id: string;
    duration_sec: number;
    language?: string;
    prompt_text?: string;
    output_path?: string;
  }
  | {
    action: 'collect_voice_samples';
    request_id: string;
    profile_draft?: {
      profile_id: string;
      display_name: string;
      tier: 'personal' | 'confidential' | 'public';
      languages: string[];
      default_engine_id: string;
      notes?: string;
    };
    samples: Array<{ sample_id: string; path: string; language?: string; note?: string }>;
  }
  | {
    action: 'collect_and_register_voice_profile';
    request_id: string;
    profile: {
      profile_id: string;
      display_name: string;
      tier: 'personal' | 'confidential' | 'public';
      languages: string[];
      default_engine_id: string;
      notes?: string;
    };
    samples: Array<{ sample_id: string; path: string; language?: string; note?: string }>;
    policy?: { strict_personal_voice?: boolean };
  }
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
  if (input.action === 'record_voice_sample') {
    const payload = (input as any).params
      ? { action: 'record_voice_sample', ...((input as any).params || {}) }
      : input;
    return recordVoiceSample(payload as any);
  }
  if (input.action === 'collect_voice_samples') {
    const payload = (input as any).params
      ? { action: 'collect_voice_samples', ...((input as any).params || {}) }
      : input;
    return collectVoiceSamples(payload as any);
  }
  if (input.action === 'collect_and_register_voice_profile') {
    const payload = (input as any).params
      ? { action: 'collect_and_register_voice_profile', ...((input as any).params || {}) }
      : input;
    return collectAndRegisterVoiceProfile(payload as any);
  }
  if (input.action === 'register_voice_profile') {
    const payload = (input as any).params
      ? { action: 'register_voice_profile', ...((input as any).params || {}) }
      : input;
    return registerVoiceProfile(payload as any);
  }
  if (input.action === 'transcribe_voice_sample') {
    const payload = (input as any).params
      ? { action: 'transcribe_voice_sample', ...((input as any).params || {}) }
      : input;
    return transcribeVoiceSample(payload as any);
  }
  if ((input as any).action === 'record_interaction') {
    const p = (input as any).params ?? {};
    if (!p.person_slug || !p.org || !p.summary) {
      throw new Error('[VOICE] record_interaction requires person_slug, org, and summary');
    }
    const node = recordInteraction({
      personSlug: p.person_slug,
      org: p.org,
      source: 'voice-actuator',
      interaction: {
        at: new Date().toISOString(),
        summary: p.summary,
        channel: p.channel ?? 'voice',
        ...(p.tone_shifts ? { tone_shifts: p.tone_shifts } : {}),
      },
    });
    logger.info(`[VOICE] recorded interaction with ${p.org}/${p.person_slug} (${node.history.length} entries)`);
    return { status: 'interaction_recorded', person_slug: p.person_slug, org: p.org, history_length: node.history.length };
  }
  throw new Error(`Unsupported voice action: ${String((input as any)?.action)}`);
}

async function collectAndRegisterVoiceProfile(input: {
  action: 'collect_and_register_voice_profile';
  request_id: string;
  profile: {
    profile_id: string;
    display_name: string;
    tier: 'personal' | 'confidential' | 'public';
    languages: string[];
    default_engine_id: string;
    notes?: string;
  };
  samples: Array<{ sample_id: string; path: string; language?: string; note?: string }>;
  policy?: { strict_personal_voice?: boolean; allow_update?: boolean };
}): Promise<any> {
  const collected = collectVoiceSamples({
    action: 'collect_voice_samples',
    request_id: input.request_id,
    profile_draft: input.profile,
    samples: input.samples,
  });
  const registration = await registerVoiceProfile({
    action: 'register_voice_profile',
    request_id: input.request_id,
    profile: input.profile,
    samples: collected.registration_candidate.samples,
    policy: input.policy,
  });
  return {
    status: registration.status === 'succeeded' ? 'succeeded' : registration.status,
    action: 'collect_and_register_voice_profile',
    request_id: input.request_id,
    collection: collected,
    registration,
  };
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
        const artifactRef = await renderNativeArtifact(String(input.text || ''), {
          requestId: jobId,
          voice: defaults.voice,
          rate: defaults.rate,
          format: requestedFormat,
          engineId: engine.engine_id,
          supportsFormats: engine.supports.artifact_formats,
          outputPath: input.delivery?.artifact_path,
          profile,
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
            profile,
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
  policy?: { strict_personal_voice?: boolean; allow_update?: boolean };
}): Promise<any> {
  if (!String(input.request_id || '').trim()) {
    throw new Error('register_voice_profile requires request_id');
  }
  const ingestionPolicy = getVoiceSampleIngestionPolicy();
  const validation = validateVoiceProfileRegistration(
    { ...input, policy: { ...input.policy, strict_personal_voice: input.policy?.strict_personal_voice } },
    ingestionPolicy,
  );
  if (!validation.ok) {
    return {
      status: 'blocked',
      action: 'register_voice_profile',
      request_id: input.request_id,
      policy_version: ingestionPolicy.version,
      violations: validation.violations,
      summary: validation.summary,
    };
  }

  // Direct upsert: update existing profile's sample_refs in registry
  if (input.policy?.allow_update) {
    const registry = getVoiceProfileRegistry();
    const sampleRefs = input.samples.map((s) => s.path);
    const existing = registry.profiles.find((p) => p.profile_id === input.profile.profile_id);
    const updated = existing
      ? { ...existing, ...input.profile, sample_refs: sampleRefs, status: existing.status }
      : { ...input.profile, sample_refs: sampleRefs, status: 'active' as const };
    const nextProfiles = existing
      ? registry.profiles.map((p) => (p.profile_id === input.profile.profile_id ? updated : p))
      : [...registry.profiles, updated];
    writeVoiceProfileRegistry({ ...registry, profiles: nextProfiles });
    logger.info(`[VOICE] ${existing ? 'updated' : 'created'} profile ${input.profile.profile_id} with ${sampleRefs.length} sample(s)`);
    return {
      status: 'succeeded',
      action: 'register_voice_profile',
      request_id: input.request_id,
      profile_id: input.profile.profile_id,
      sample_refs: sampleRefs,
      upserted: true,
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
        policy_version: ingestionPolicy.version,
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

async function transcribeVoiceSample(input: {
  action: 'transcribe_voice_sample';
  audio_path: string;
  language?: string;
  model?: string;
  write_sidecar?: boolean;
}): Promise<any> {
  const audioPath = String(input.audio_path || '').trim();
  if (!audioPath) throw new Error('transcribe_voice_sample requires audio_path');

  const bridgeScript = pathResolver.rootResolve(
    'libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py',
  );
  const payload = JSON.stringify({
    action: 'transcribe',
    params: {
      audio_path: pathResolver.rootResolve(audioPath),
      ...(input.language ? { language: input.language } : {}),
      ...(input.model ? { model: input.model } : {}),
    },
  });

  const result = safeExecResult(resolvePythonBin(), [bridgeScript], { input: payload });
  if (result.error || result.status !== 0) {
    throw new Error(`mlx_audio_stt_bridge failed: ${result.stderr || result.error?.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`mlx_audio_stt_bridge returned non-JSON: ${result.stdout}`);
  }

  if (parsed.status !== 'success') {
    throw new Error(`mlx_audio_stt_bridge error: ${parsed.error}`);
  }

  if (input.write_sidecar !== false) {
    const sidecarPath = pathResolver.rootResolve(`${audioPath}.transcript.txt`);
    const sidecarDir = path.dirname(sidecarPath);
    safeMkdir(sidecarDir, { recursive: true });
    safeWriteFile(sidecarPath, parsed.text);
    logger.info(`[VOICE] transcript written to ${sidecarPath}`);
  }

  return {
    status: 'succeeded',
    action: 'transcribe_voice_sample',
    audio_path: audioPath,
    transcript: parsed.text,
    language: parsed.language,
    model: parsed.model,
  };
}

async function performPlayback(
  text: string,
  options: { language: string; voice: string; rate: number; engineId: string; profile?: any },
): Promise<void> {
  const engine = resolveVoiceEngineForPlatform(options.engineId);
  if (!engine.supports.playback) {
    throw new Error(`Voice engine ${engine.engine_id} does not support playback`);
  }

  if (engine.engine_id === 'mlx_audio_qwen3') {
    const tmpPath = pathResolver.sharedTmp(`voice-playback-${Date.now()}.wav`);
    await withRetry(async () => {
      await runMlxAudioGenerate(text, tmpPath, options.profile);
      safeExec('open', [tmpPath]);
    }, buildRetryOptions());
    return;
  }

  if (process.platform === 'darwin') {
    await withRetry(async () => {
      safeExec('say', ['-v', options.voice, '-r', String(options.rate), text]);
    }, buildRetryOptions());
    return;
  }
  if (process.platform === 'linux') {
    await withRetry(async () => {
      safeExec('espeak', ['-s', String(options.rate), text]);
    }, buildRetryOptions());
    return;
  }
  if (process.platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    await withRetry(async () => {
      safeExec('powershell', [
        '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${escaped}')`,
      ]);
    }, buildRetryOptions());
    return;
  }
  throw new Error(`Unsupported voice playback platform: ${process.platform}`);
}

async function runMlxAudioGenerate(text: string, outputPath: string, profile?: any): Promise<void> {
  const bridgeScript = pathResolver.rootResolve(
    'libs/actuators/voice-actuator/scripts/mlx_audio_tts_bridge.py',
  );

  const refAudio = resolveProfileRefAudio(profile);
  const refText = refAudio ? resolveRefTranscript(refAudio) : undefined;

  const payload = JSON.stringify({
    action: 'generate',
    params: {
      text,
      output_path: outputPath,
      ...(refAudio ? { ref_audio: refAudio } : {}),
      ...(refText ? { ref_text: refText } : {}),
    },
  });

  const result = safeExecResult(resolvePythonBin(), [bridgeScript], { input: payload });
  if (result.error || result.status !== 0) {
    throw new Error(`mlx_audio_tts_bridge failed: ${result.stderr || result.error?.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`mlx_audio_tts_bridge returned non-JSON: ${result.stdout}`);
  }

  if (parsed.status !== 'success') {
    throw new Error(`mlx_audio_tts_bridge error: ${parsed.error}`);
  }
}

function resolveProfileRefAudio(profile?: any): string | undefined {
  if (!profile) return undefined;
  const samples: string[] = profile.sample_refs || [];
  if (samples.length === 0) return undefined;
  const absPath = pathResolver.rootResolve(samples[0]);
  return absPath;
}

function resolveRefTranscript(refAudioPath: string): string | undefined {
  const sidecarPath = `${refAudioPath}.transcript.txt`;
  try {
    const content = safeReadFile(sidecarPath, { encoding: 'utf8' });
    return typeof content === 'string' ? content.trim() : undefined;
  } catch {
    return undefined;
  }
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
    profile?: any;
  },
): string | Promise<string> {
  if (!options.supportsFormats.includes(options.format)) {
    throw new Error(`Voice engine ${options.engineId} does not support artifact format ${options.format}`);
  }
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });

  if (options.engineId === 'mlx_audio_qwen3') {
    return withRetry(async () => {
      await runMlxAudioGenerate(text, artifactPath, options.profile);
      return artifactPath;
    }, buildRetryOptions());
  }

  if (process.platform === 'darwin') {
    return withRetry(async () => {
      safeExec('say', ['-v', options.voice, '-r', String(options.rate), '-o', artifactPath, text]);
      return artifactPath;
    }, buildRetryOptions());
  }

  if (process.platform === 'linux') {
    if (options.format !== 'wav') {
      throw new Error(`linux native artifact rendering supports only wav, received ${options.format}`);
    }
    return withRetry(async () => {
      safeExec('espeak', ['-s', String(options.rate), '-w', artifactPath, text]);
      return artifactPath;
    }, buildRetryOptions());
  }

  throw new Error(`native artifact rendering is unsupported on ${process.platform}`);
}

function resolveArtifactPath(requestId: string, format: VoiceArtifactFormat, outputPath?: string): string {
  const requestedPath = typeof outputPath === 'string' && outputPath.trim() ? outputPath.trim() : null;
  if (requestedPath) return pathResolver.rootResolve(requestedPath);
  return pathResolver.sharedTmp(`voice-generation/${requestId}.${format}`);
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

function deepResolve(val: any, ctx: any): any {
  if (typeof val === 'string') return resolveVars(val, ctx);
  if (Array.isArray(val)) return val.map((item) => deepResolve(item, ctx));
  if (val !== null && typeof val === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) result[k] = deepResolve(v, ctx);
    return result;
  }
  return val;
}

export async function dispatchDecisionOp(
  op: string,
  params: Record<string, any>,
  ctx: Record<string, any>,
): Promise<{ handled: boolean; ctx: any }> {
  const resolvedParams = deepResolve(params, ctx);
  const payload = { action: op, ...resolvedParams };
  try {
    const result = await handleSingleAction(payload as any);
    const exportAs = resolvedParams.export_as;
    return {
      handled: true,
      ctx: exportAs ? { ...ctx, [exportAs]: result } : { ...ctx, last_voice_result: result },
    };
  } catch (err: any) {
    throw err;
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputData = JSON.parse(safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string);
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
