import {
  classifyError,
  createVirtualAudioOutputPlaybackBridge,
  createVirtualDeviceInventoryBridge,
  getVoiceEngineRecord,
  getVoiceProfileRecord,
  getVoiceRuntimePolicy,
  getVoiceTtsLanguageConfig,
  logger,
  pathResolver,
  resolveVoiceBackend,
  resolveVoiceEngineForPlatform,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  splitVoiceTextIntoChunks,
  withRetry,
  VoiceGenerationRuntime,
} from '@agent/core';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

const VOICE_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/voice-actuator/manifest.json');
const DEFAULT_VOICE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};
const ESPEAK_NG_CANDIDATES = [
  '/opt/homebrew/bin/espeak-ng',
  '/usr/local/bin/espeak-ng',
  '/opt/homebrew/bin/espeak',
  '/usr/local/bin/espeak',
];

let cachedRecoveryPolicy: Record<string, any> | null = null;

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

export function buildRetryOptions(override?: Record<string, any>) {
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

function resolvePythonBin(): string {
  if (process.env.KYBERION_PYTHON) return process.env.KYBERION_PYTHON;
  const venvPython = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(venvPython)) return venvPython;
  return 'python3';
}

function hasEspeakNg(): boolean {
  return ESPEAK_NG_CANDIDATES.some((candidate) => safeExistsSync(candidate));
}

function resolveEspeakLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('zh')) return 'zh';
  return normalized || 'en';
}

function resolveEspeakRate(language: string, rate: number): number {
  if (!hasEspeakNg()) return rate;
  if (language.trim().toLowerCase().startsWith('ja')) {
    return Math.max(260, rate);
  }
  return rate;
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

function resolveArtifactPath(requestId: string, format: VoiceArtifactFormat, outputPath?: string): string {
  const requestedPath = typeof outputPath === 'string' && outputPath.trim() ? outputPath.trim() : null;
  if (requestedPath) return pathResolver.rootResolve(requestedPath);
  return pathResolver.sharedTmp(`voice-generation/${requestId}.${format}`);
}

async function runPythonBridgeGenerate(
  bridgeScriptPath: string,
  text: string,
  outputPath: string,
  options: {
    voice?: string;
    language?: string;
    profile?: any;
  },
): Promise<void> {
  const bridgeScript = pathResolver.rootResolve(bridgeScriptPath);

  const refAudio = resolveProfileRefAudio(options.profile);
  const refText = refAudio ? resolveRefTranscript(refAudio) : undefined;

  const payload = JSON.stringify({
    action: 'generate',
    params: {
      text,
      output_path: outputPath,
      voice: options.voice,
      language: options.language,
      ...(refAudio ? { ref_audio: refAudio } : {}),
      ...(refText ? { ref_text: refText } : {}),
    },
  });

  const result = safeExecResult(resolvePythonBin(), [bridgeScript], { input: payload });
  if (result.error || result.status !== 0) {
    throw new Error(`bridge script execution failed for ${bridgeScriptPath}: ${result.stderr || result.error?.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`bridge script returned non-JSON: ${result.stdout}`);
  }

  if (parsed.status !== 'success') {
    throw new Error(`bridge script error in ${bridgeScriptPath}: ${parsed.error}`);
  }
}

async function renderWithEspeakNg(
  text: string,
  options: {
    requestId: string;
    language: string;
    rate: number;
    format: VoiceArtifactFormat;
    outputPath?: string;
  },
): Promise<string> {
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });

  const normalizedLanguage = resolveEspeakLanguage(options.language);
  const adjustedRate = resolveEspeakRate(options.language, options.rate);

  if (options.format === 'wav') {
    safeExec('espeak-ng', ['-v', normalizedLanguage, '-s', String(adjustedRate), '-w', artifactPath, text]);
    return artifactPath;
  }

  const tempWav = pathResolver.sharedTmp(`voice-generation/${options.requestId}.wav`);
  safeMkdir(path.dirname(tempWav), { recursive: true });
  safeExec('espeak-ng', ['-v', normalizedLanguage, '-s', String(adjustedRate), '-w', tempWav, text]);
  safeExec('ffmpeg', ['-y', '-i', tempWav, artifactPath]);
  return artifactPath;
}

function renderNativeArtifact(
  text: string,
  options: {
    requestId: string;
    voice: string;
    rate: number;
    language: string;
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

  const engineRecord = getVoiceEngineRecord(options.engineId) as any;
  if (engineRecord && engineRecord.bridge_script) {
    return withRetry(async () => {
      await runPythonBridgeGenerate(engineRecord.bridge_script, text, artifactPath, {
        voice: options.voice,
        language: options.language,
        profile: options.profile,
      });
      return artifactPath;
    }, buildRetryOptions());
  }

  if (process.platform === 'darwin') {
    return withRetry(async () => {
      if (hasEspeakNg()) {
        return renderWithEspeakNg(text, {
          requestId: options.requestId,
          language: options.language,
          rate: options.rate,
          format: options.format,
          outputPath: options.outputPath,
        });
      }
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

async function performPlayback(
  text: string,
  options: { language: string; voice: string; rate: number; engineId: string; profile?: any },
  playbackSourcePath?: string,
): Promise<{
  bridge_id?: string;
  platform?: NodeJS.Platform;
  playback_source_path?: string;
  outputs?: any[];
}> {
  const engine = resolveVoiceEngineForPlatform(options.engineId);
  if (!engine.supports.playback) {
    throw new Error(`Voice engine ${engine.engine_id} does not support playback`);
  }

  const engineRecord = engine as any;
  if (engineRecord.bridge_script && process.platform !== 'darwin') {
    const tmpPath = playbackSourcePath || pathResolver.sharedTmp(`voice-playback-${Date.now()}.wav`);
    await withRetry(async () => {
      if (!playbackSourcePath) {
        await runPythonBridgeGenerate(engineRecord.bridge_script, text, tmpPath, {
          profile: options.profile,
          language: options.language,
          voice: options.voice,
        });
      }
      safeExec('open', [tmpPath]);
    }, buildRetryOptions());
    return {
      playback_source_path: tmpPath,
      outputs: [],
    };
  }

  if (process.platform === 'darwin') {
    const playbackSource = playbackSourcePath || await renderVoicePlaybackSource(text, options);
    const bridge = createVirtualAudioOutputPlaybackBridge({
      inventory_bridge: createVirtualDeviceInventoryBridge(),
    });
    const probe = await bridge.probe();
    if (!probe.available) {
      throw new Error(`[VOICE] virtual audio output bridge unavailable: ${probe.reason || 'unknown reason'}`);
    }
    const outputs = await withRetry(async () => bridge.playOnOutputs(probe.outputs, { source_path: playbackSource }), buildRetryOptions());
    return {
      bridge_id: outputs.bridge_id,
      platform: outputs.platform,
      playback_source_path: playbackSource,
      outputs: outputs.outputs,
    };
  }
  if (process.platform === 'linux') {
    await withRetry(async () => {
      safeExec('espeak', ['-s', String(options.rate), text]);
    }, buildRetryOptions());
    return {
      playback_source_path: undefined,
      outputs: [],
    };
  }
  if (process.platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    await withRetry(async () => {
      safeExec('powershell', [
        '-Command',
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${escaped}')`,
      ]);
    }, buildRetryOptions());
    return {
      playback_source_path: undefined,
      outputs: [],
    };
  }
  throw new Error(`Unsupported voice playback platform: ${process.platform}`);
}

async function renderVoicePlaybackSource(
  text: string,
  options: { language: string; voice: string; rate: number; engineId: string; profile?: any },
): Promise<string> {
  const playbackRequestId = `${randomUUID()}-playback`;
  const playbackFormat: VoiceArtifactFormat = process.platform === 'darwin'
    ? (hasEspeakNg() ? 'wav' : 'aiff')
    : 'wav';
  return renderNativeArtifact(text, {
    requestId: playbackRequestId,
    voice: options.voice,
    rate: options.rate,
    language: options.language,
    format: playbackFormat,
    engineId: options.engineId,
    supportsFormats: resolveVoiceEngineForPlatform(options.engineId).supports.artifact_formats,
    profile: options.profile,
  });
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

export type VoiceArtifactFormat = 'wav' | 'mp3' | 'ogg' | 'aiff';
export {
  performPlayback,
  renderVoicePlaybackSource,
  renderNativeArtifact,
  resolveArtifactPath,
  runPythonBridgeGenerate,
  resolveProfileRefAudio,
  resolveRefTranscript,
  renderWithEspeakNg,
  resolvePythonBin,
  resolveEspeakLanguage,
  resolveEspeakRate,
  waitForVoiceJob,
};
