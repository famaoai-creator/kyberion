import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { createVirtualAudioOutputPlaybackBridge } from '@agent/core/virtual-audio-output-playback-bridge';
import { createVirtualDeviceInventoryBridge } from '@agent/core/virtual-device-inventory-bridge';
import {
  getVoiceEngineRecord,
  getVoiceEngineRegistry,
  resolveVoiceEngineForPlatform,
} from '@agent/core/voice-engine-registry';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveManagedToolPythonBin } from '@agent/core/tool-runtime-registry';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeLstat,
  safeStat,
} from '@agent/core/secure-io';
import { retry } from '@agent/core/async-utils';
import { VoiceGenerationRuntime } from '@agent/core/voice-generation-runtime';
import { waitForJob } from '@agent/core/job-lifecycle';
import { getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';
import type {
  SpeechToTextCapabilities,
  TranscriptSegment,
} from '@agent/core/speech-to-text-bridge';
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
export const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: VOICE_MANIFEST_PATH,
  defaults: DEFAULT_VOICE_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

type VoicePythonTool = 'mlx_audio' | 'mlx_whisper' | 'faster_whisper' | 'kokoro_tts' | 'pocket_tts';

export interface VoiceSttBridgeResponse {
  status: 'success' | 'error';
  text?: string;
  language?: string;
  model?: string;
  capabilities?: SpeechToTextCapabilities;
  segments?: TranscriptSegment[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseVoiceSttBridgeResponse(value: unknown): VoiceSttBridgeResponse | undefined {
  if (!isRecord(value) || (value.status !== 'success' && value.status !== 'error')) {
    return undefined;
  }
  if (value.text !== undefined && typeof value.text !== 'string') return undefined;
  if (value.language !== undefined && typeof value.language !== 'string') return undefined;
  if (value.model !== undefined && typeof value.model !== 'string') return undefined;
  if (value.error !== undefined && typeof value.error !== 'string') return undefined;

  let capabilities: SpeechToTextCapabilities | undefined;
  if (value.capabilities !== undefined) {
    const candidate = value.capabilities;
    if (!isRecord(candidate) || typeof candidate.timestamps !== 'boolean') return undefined;
    const granularity = candidate.granularity;
    if (granularity !== 'none' && granularity !== 'segment' && granularity !== 'word') {
      return undefined;
    }
    capabilities = {
      timestamps: candidate.timestamps,
      granularity,
      ...(typeof candidate.local_only === 'boolean' ? { local_only: candidate.local_only } : {}),
      ...(typeof candidate.confidence === 'boolean' ? { confidence: candidate.confidence } : {}),
    };
  }

  let segments: TranscriptSegment[] | undefined;
  if (value.segments !== undefined) {
    if (!Array.isArray(value.segments)) return undefined;
    segments = value.segments.flatMap((candidate): TranscriptSegment[] => {
      if (!isRecord(candidate)) return [];
      if (
        typeof candidate.start_sec !== 'number' ||
        !Number.isFinite(candidate.start_sec) ||
        typeof candidate.end_sec !== 'number' ||
        !Number.isFinite(candidate.end_sec) ||
        typeof candidate.text !== 'string'
      ) {
        return [];
      }
      return [{ start_sec: candidate.start_sec, end_sec: candidate.end_sec, text: candidate.text }];
    });
  }

  if (value.status === 'success' && typeof value.text !== 'string') return undefined;
  return {
    status: value.status,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(typeof value.language === 'string' ? { language: value.language } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(segments ? { segments } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function resolvePythonBin(preferredTool: VoicePythonTool = 'mlx_audio'): string {
  const configuredPythonBin = getRegisteredEnvText('KYBERION_PYTHON_BIN');
  if (configuredPythonBin) return configuredPythonBin;
  const configuredPython = getRegisteredEnvText('KYBERION_PYTHON');
  if (configuredPython) return configuredPython;
  for (const toolId of [
    preferredTool,
    preferredTool === 'mlx_audio' ? 'mlx_whisper' : 'mlx_audio',
  ] as const) {
    const managedPython = resolveManagedToolPythonBin(toolId);
    if (managedPython) return managedPython;
  }
  const venvPython = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(venvPython)) return venvPython;
  return 'python3';
}

function hasEspeakNg(): boolean {
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  const result = safeExecResult(resolver, ['espeak-ng'], { timeoutMs: 3000 });
  return result.status === 0 && Boolean(result.stdout.trim());
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
  const candidate = assertSafeRepositoryPath(pathResolver.rootResolve(samples[0]), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(candidate) || !safeLstat(candidate).isFile()) {
    throw new Error(`Voice reference audio must be an existing regular file: ${candidate}`);
  }
  return candidate;
}

function resolveRefTranscript(refAudioPath: string): string | undefined {
  const sidecarPath = assertSafeRepositoryPath(`${refAudioPath}.transcript.txt`, {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(sidecarPath) || !safeLstat(sidecarPath).isFile()) return undefined;
  try {
    const content = safeReadFile(sidecarPath, { encoding: 'utf8' });
    return typeof content === 'string' ? content.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveArtifactPath(
  requestId: string,
  format: VoiceArtifactFormat,
  outputPath?: string
): string {
  const requestedPath =
    typeof outputPath === 'string' && outputPath.trim() ? outputPath.trim() : null;
  if (requestedPath) {
    return assertSafeRepositoryPath(pathResolver.rootResolve(requestedPath), {
      allowMissingLeaf: true,
    });
  }
  return assertSafeRepositoryPath(
    pathResolver.sharedTmp(`voice-generation/${requestId}.${format}`),
    { allowMissingLeaf: true }
  );
}

function parseTrailingJson(raw: string): any {
  for (const line of raw.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return parseSafeJsonInput(trimmed, 'voice bridge response');
    } catch {
      continue;
    }
  }
  throw new Error('No JSON payload received');
}

async function runPythonTtsBridge(
  bridgeScriptPath: string,
  text: string,
  outputPath: string,
  language: string,
  profile?: any,
  runtimeId: VoicePythonTool = 'mlx_audio',
  voice?: string
): Promise<void> {
  const bridgeScript = assertSafeRepositoryPath(pathResolver.rootResolve(bridgeScriptPath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(bridgeScript) || !safeLstat(bridgeScript).isFile()) {
    throw new Error(`Voice bridge script must be an existing regular file: ${bridgeScript}`);
  }
  const safeOutputPath = assertSafeRepositoryPath(outputPath, { allowMissingLeaf: true });

  const refAudio = resolveProfileRefAudio(profile);
  const refText = refAudio ? resolveRefTranscript(refAudio) : undefined;

  const payload = JSON.stringify({
    action: 'generate',
    params: {
      text,
      output_path: safeOutputPath,
      lang_code: language.trim().toLowerCase().startsWith('ja') ? 'ja' : 'en',
      ...(voice ? { voice } : {}),
      ...(refAudio ? { ref_audio: refAudio } : {}),
      ...(refText ? { ref_text: refText } : {}),
    },
  });

  const result = safeExecResult(resolvePythonBin(runtimeId), [bridgeScript], { input: payload });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${path.basename(bridgeScriptPath)} failed: ${result.stderr || result.error?.message}`
    );
  }

  let parsed: any;
  try {
    const stdout = String(result.stdout || '').trim();
    if (!stdout) throw new Error('No stdout received');
    parsed = parseTrailingJson(stdout);
  } catch {
    throw new Error(`${path.basename(bridgeScriptPath)} returned non-JSON: ${result.stdout}`);
  }

  if (parsed.status !== 'success') {
    throw new Error(`${path.basename(bridgeScriptPath)} error: ${parsed.error}`);
  }

  // Auto-trim output based on text duration from end (remove reference audio context)
  if (refAudio && safeExistsSync(safeOutputPath) && safeLstat(safeOutputPath).isFile()) {
    try {
      const probeTotal = safeExec('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        safeOutputPath,
      ]).trim();
      const totalDuration = parseFloat(probeTotal);
      const estimatedDuration = Math.min(totalDuration, text.length / 5.5 + 0.6);

      if (Number.isFinite(totalDuration) && totalDuration > estimatedDuration) {
        const tempPath = assertSafeRepositoryPath(`${safeOutputPath}.tmp.wav`, {
          allowMissingLeaf: true,
        });
        safeExec('ffmpeg', [
          '-y',
          '-sseof',
          `-${estimatedDuration.toFixed(2)}`,
          '-i',
          safeOutputPath,
          '-c',
          'copy',
          tempPath,
        ]);
        if (safeExistsSync(tempPath) && safeLstat(tempPath).isFile()) {
          safeExec('mv', [tempPath, safeOutputPath]);
          logger.info(
            `[VOICE_CLONE] Trimmed context reference speech, kept target text speech of ${estimatedDuration.toFixed(2)}s from end.`
          );
        }
      }
    } catch (err: any) {
      logger.warn(`[VOICE_CLONE] Failed to auto-trim reference context: ${err.message}`);
    }
  }
}

interface VoicePlaybackPlatformAdapter {
  openArtifact(path: string): void;
}

class DarwinVoicePlaybackAdapter implements VoicePlaybackPlatformAdapter {
  openArtifact(path: string): void {
    safeExec('open', [path]);
  }
}

class LinuxVoicePlaybackAdapter implements VoicePlaybackPlatformAdapter {
  openArtifact(path: string): void {
    safeExec('xdg-open', [path]);
  }
}

class WindowsVoicePlaybackAdapter implements VoicePlaybackPlatformAdapter {
  openArtifact(path: string): void {
    safeExec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${path.replace(/'/g, "''")}'`,
    ]);
  }
}

interface VoiceNativeArtifactAdapter {
  render(
    text: string,
    options: {
      requestId: string;
      voice: string;
      rate: number;
      format: VoiceArtifactFormat;
      outputPath?: string;
    }
  ): string;
}

class DarwinVoiceArtifactAdapter implements VoiceNativeArtifactAdapter {
  render(
    text: string,
    options: {
      requestId: string;
      voice: string;
      rate: number;
      format: VoiceArtifactFormat;
      outputPath?: string;
    }
  ): string {
    return renderWithSay(text, options);
  }
}
class LinuxVoiceArtifactAdapter implements VoiceNativeArtifactAdapter {
  render(
    text: string,
    options: {
      requestId: string;
      voice: string;
      rate: number;
      format: VoiceArtifactFormat;
      outputPath?: string;
    }
  ): string {
    if (options.format !== 'wav')
      throw new Error(
        `linux native artifact rendering supports only wav, received ${options.format}`
      );
    const path = resolveArtifactPath(options.requestId, options.format, options.outputPath);
    safeExec('espeak', ['-s', String(options.rate), '-w', path, text]);
    return path;
  }
}
class WindowsVoiceArtifactAdapter implements VoiceNativeArtifactAdapter {
  render(
    text: string,
    options: {
      requestId: string;
      voice: string;
      rate: number;
      format: VoiceArtifactFormat;
      outputPath?: string;
    }
  ): string {
    if (options.format !== 'wav')
      throw new Error(
        `win32 native artifact rendering supports only wav, received ${options.format}`
      );
    const path = resolveArtifactPath(options.requestId, options.format, options.outputPath);
    safeExec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${path.replace(/'/g, "''")}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`,
    ]);
    return path;
  }
}
const voiceArtifactAdapters: Record<string, VoiceNativeArtifactAdapter> = {
  darwin: new DarwinVoiceArtifactAdapter(),
  linux: new LinuxVoiceArtifactAdapter(),
  win32: new WindowsVoiceArtifactAdapter(),
};

interface VoiceSpeechPlaybackAdapter {
  speak(text: string, rate: number): void;
}
const voiceSpeechAdapters: Partial<Record<string, VoiceSpeechPlaybackAdapter>> = {
  linux: { speak: (text, rate) => safeExec('espeak', ['-s', String(rate), text]) },
  win32: {
    speak: (text) =>
      safeExec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`,
      ]),
  },
};

function resolveVoicePlaybackAdapter(platform: NodeJS.Platform): VoicePlaybackPlatformAdapter {
  switch (platform) {
    case 'darwin':
      return new DarwinVoicePlaybackAdapter();
    case 'win32':
      return new WindowsVoicePlaybackAdapter();
    default:
      return new LinuxVoicePlaybackAdapter();
  }
}

function openPlaybackArtifact(artifactPath: string): void {
  const safeArtifactPath = assertSafeRepositoryPath(artifactPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeArtifactPath) || !safeLstat(safeArtifactPath).isFile()) {
    throw new Error(`Voice playback artifact must be an existing regular file: ${artifactPath}`);
  }
  resolveVoicePlaybackAdapter(process.platform).openArtifact(safeArtifactPath);
}

async function renderWithEspeakNg(
  text: string,
  options: {
    requestId: string;
    language: string;
    rate: number;
    format: VoiceArtifactFormat;
    outputPath?: string;
  }
): Promise<string> {
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });

  const normalizedLanguage = resolveEspeakLanguage(options.language);
  const adjustedRate = resolveEspeakRate(options.language, options.rate);

  if (options.format === 'wav') {
    safeExec('espeak-ng', [
      '-v',
      normalizedLanguage,
      '-s',
      String(adjustedRate),
      '-w',
      artifactPath,
      text,
    ]);
    return artifactPath;
  }

  const tempWav = pathResolver.sharedTmp(`voice-generation/${options.requestId}.wav`);
  safeMkdir(path.dirname(tempWav), { recursive: true });
  safeExec('espeak-ng', [
    '-v',
    normalizedLanguage,
    '-s',
    String(adjustedRate),
    '-w',
    tempWav,
    text,
  ]);
  safeExec('ffmpeg', ['-y', '-i', tempWav, artifactPath]);
  return artifactPath;
}

function renderWithSay(
  text: string,
  options: {
    requestId: string;
    voice: string;
    rate: number;
    format: VoiceArtifactFormat;
    outputPath?: string;
  }
): string {
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });
  safeExec('say', ['-v', options.voice, '-r', String(options.rate), '-o', artifactPath, text]);
  return artifactPath;
}

async function isRenderableAudioArtifact(artifactPath: string): Promise<boolean> {
  if (!artifactPath || !safeExistsSync(artifactPath)) {
    return false;
  }

  try {
    if (!safeLstat(artifactPath).isFile() || safeStat(artifactPath).size < 1024) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const durationText = safeExec('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      artifactPath,
    ]).trim();
    const duration = Number(durationText);
    return Number.isFinite(duration) && duration > 0;
  } catch {
    return false;
  }
}

function resolveVoiceArtifactCandidates(
  requestedEngineId: string,
  format: VoiceArtifactFormat,
  options: { requireVoiceClone?: boolean } = {}
): Array<ReturnType<typeof getVoiceEngineRecord>> {
  const registry = getVoiceEngineRegistry();
  const visited = new Set<string>();
  const candidates: Array<ReturnType<typeof getVoiceEngineRecord>> = [];

  const addCandidate = (engine?: ReturnType<typeof getVoiceEngineRecord>): void => {
    if (!engine || visited.has(engine.engine_id)) return;
    visited.add(engine.engine_id);
    if (engine.status !== 'active') return;
    if (!engine.platforms.includes('any') && !engine.platforms.includes(process.platform as any))
      return;
    if (!engine.supports.artifact_formats.includes(format)) return;
    if (
      options.requireVoiceClone &&
      (!engine.supports.voice_clone || !engine.supports.icl_ref_audio)
    )
      return;
    candidates.push(engine);
  };

  let current = getVoiceEngineRecord(requestedEngineId);
  while (current && !visited.has(current.engine_id)) {
    addCandidate(current);
    if (!current.fallback_engine_id) break;
    current = getVoiceEngineRecord(current.fallback_engine_id);
  }

  addCandidate(getVoiceEngineRecord(registry.default_engine_id));
  for (const engine of registry.engines) {
    addCandidate(engine);
  }

  return candidates;
}

async function renderVoiceArtifactWithEngine(
  text: string,
  options: {
    requestId: string;
    voice: string;
    rate: number;
    language: string;
    format: VoiceArtifactFormat;
    outputPath?: string;
    profile?: any;
  },
  engine: ReturnType<typeof getVoiceEngineRecord>
): Promise<string> {
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  if (engine.bridge_script) {
    await runPythonTtsBridge(
      engine.bridge_script,
      text,
      artifactPath,
      options.language,
      options.profile,
      (engine.runtime_id as VoicePythonTool | undefined) || 'mlx_audio',
      options.voice
    );
    return artifactPath;
  }

  const nativeAdapter = voiceArtifactAdapters[process.platform];
  if (nativeAdapter) {
    const rendered = nativeAdapter.render(text, options);
    if (await isRenderableAudioArtifact(rendered)) {
      return rendered;
    }
    throw new Error(`native voice adapter produced an invalid audio artifact: ${rendered}`);
  }

  throw new Error(`native artifact rendering is unsupported on ${process.platform}`);
}

async function renderNativeArtifact(
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
    requireVoiceClone?: boolean;
  }
): Promise<string> {
  if (!options.supportsFormats.includes(options.format)) {
    throw new Error(
      `Voice engine ${options.engineId} does not support artifact format ${options.format}`
    );
  }
  const artifactPath = resolveArtifactPath(options.requestId, options.format, options.outputPath);
  const artifactDir = path.dirname(artifactPath);
  safeMkdir(artifactDir, { recursive: true });

  const candidates = resolveVoiceArtifactCandidates(options.engineId, options.format, {
    requireVoiceClone: options.requireVoiceClone,
  });
  if (candidates.length === 0) {
    const cloneRequirement = options.requireVoiceClone ? ' with learned-voice support' : '';
    throw new Error(
      `No configured voice engine${cloneRequirement} can render artifact format ${options.format} on ${process.platform}`
    );
  }

  let lastError: unknown;
  for (const engine of candidates) {
    try {
      const rendered = await retry(async () => {
        const renderedPath = await renderVoiceArtifactWithEngine(text, options, engine);
        if (await isRenderableAudioArtifact(renderedPath)) {
          return renderedPath;
        }
        throw new Error(
          `voice engine ${engine.engine_id} produced an invalid audio artifact: ${renderedPath}`
        );
      }, buildRetryOptions());
      return rendered;
    } catch (error) {
      lastError = error;
      logger.warn(
        `[VOICE] configured engine ${engine.engine_id} failed for artifact rendering: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `Configured voice engines failed to render a valid audio artifact for ${options.engineId}`
      );
}

async function performPlayback(
  text: string,
  options: {
    language: string;
    voice: string;
    rate: number;
    engineId: string;
    profile?: any;
    requireVoiceClone?: boolean;
  },
  playbackSourcePath?: string
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

  if (engine.bridge_script && process.platform !== 'darwin') {
    const tmpPath = playbackSourcePath
      ? assertSafeRepositoryPath(playbackSourcePath, { allowMissingLeaf: true })
      : assertSafeRepositoryPath(pathResolver.sharedTmp(`voice-playback-${Date.now()}.wav`), {
          allowMissingLeaf: true,
        });
    await retry(async () => {
      if (!playbackSourcePath) {
        await runPythonTtsBridge(
          engine.bridge_script!,
          text,
          tmpPath,
          options.language,
          options.profile,
          (engine.runtime_id as VoicePythonTool | undefined) || 'mlx_audio',
          options.voice
        );
      }
      openPlaybackArtifact(tmpPath);
    }, buildRetryOptions());
    return {
      playback_source_path: tmpPath,
      outputs: [],
    };
  }

  if (process.platform === 'darwin') {
    const playbackSource = playbackSourcePath
      ? assertSafeRepositoryPath(playbackSourcePath, { allowMissingLeaf: true })
      : await renderVoicePlaybackSource(text, options);
    const bridge = createVirtualAudioOutputPlaybackBridge({
      inventory_bridge: createVirtualDeviceInventoryBridge(),
    });
    const probe = await bridge.probe();
    if (!probe.available) {
      throw new Error(
        `[VOICE] virtual audio output bridge unavailable: ${probe.reason || 'unknown reason'}`
      );
    }
    const outputs = await retry(
      async () => bridge.playOnOutputs(probe.outputs, { source_path: playbackSource }),
      buildRetryOptions()
    );
    return {
      bridge_id: outputs.bridge_id,
      platform: outputs.platform,
      playback_source_path: playbackSource,
      outputs: outputs.outputs,
    };
  }
  const speechAdapter = voiceSpeechAdapters[process.platform];
  if (speechAdapter) {
    await retry(async () => {
      speechAdapter.speak(text, options.rate);
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
  options: {
    language: string;
    voice: string;
    rate: number;
    engineId: string;
    profile?: any;
    requireVoiceClone?: boolean;
  }
): Promise<string> {
  const playbackRequestId = `${randomUUID()}-playback`;
  const playbackEngine = resolveVoiceEngineForPlatform(options.engineId);
  const playbackFormat: VoiceArtifactFormat = playbackEngine.supports.artifact_formats.includes(
    'aiff'
  )
    ? 'aiff'
    : 'wav';
  return renderNativeArtifact(text, {
    requestId: playbackRequestId,
    voice: options.voice,
    rate: options.rate,
    language: options.language,
    format: playbackFormat,
    engineId: options.engineId,
    supportsFormats: playbackEngine.supports.artifact_formats,
    profile: options.profile,
    requireVoiceClone: options.requireVoiceClone,
  });
}

async function waitForVoiceJob(runtime: VoiceGenerationRuntime, jobId: string): Promise<any> {
  const waited = await waitForJob({
    getStatus: async () => runtime.getPacket(jobId),
    isTerminal: (packet: any) =>
      Boolean(packet && ['completed', 'failed', 'cancelled'].includes(packet.status)),
    timeoutMs: 30_000,
    pollIntervalMs: 10,
  });
  if (waited.status === 'completed' && waited.value) {
    return waited.value;
  }
  throw new Error(`voice job timed out: ${jobId}`);
}

export type VoiceArtifactFormat = 'wav' | 'mp3' | 'ogg' | 'aiff';
export {
  performPlayback,
  renderVoicePlaybackSource,
  renderNativeArtifact,
  resolveArtifactPath,
  runPythonTtsBridge,
  resolveProfileRefAudio,
  resolveRefTranscript,
  renderWithEspeakNg,
  resolvePythonBin,
  resolveEspeakLanguage,
  resolveEspeakRate,
  waitForVoiceJob,
};
