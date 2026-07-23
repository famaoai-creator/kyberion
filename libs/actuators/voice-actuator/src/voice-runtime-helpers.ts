import {
  buildGovernedRetryOptions,
  classifyError,
  createVirtualAudioOutputPlaybackBridge,
  createVirtualDeviceInventoryBridge,
  getVoiceEngineRecord,
  getVoiceEngineRegistry,
  getVoiceProfileRecord,
  getVoiceRuntimePolicy,
  getVoiceTtsLanguageConfig,
  logger,
  pathResolver,
  resolveVoiceBackend,
  resolveVoiceEngineForPlatform,
  resolveManagedToolPythonBin,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  splitVoiceTextIntoChunks,
  retry,
  VoiceGenerationRuntime,
  waitForJob,
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

export function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: VOICE_MANIFEST_PATH,
    defaults: DEFAULT_VOICE_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

type VoicePythonTool = 'mlx_audio' | 'mlx_whisper' | 'kokoro_tts' | 'pocket_tts';

function resolvePythonBin(preferredTool: VoicePythonTool = 'mlx_audio'): string {
  if (process.env.KYBERION_PYTHON_BIN) return process.env.KYBERION_PYTHON_BIN;
  if (process.env.KYBERION_PYTHON) return process.env.KYBERION_PYTHON;
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

function resolveArtifactPath(
  requestId: string,
  format: VoiceArtifactFormat,
  outputPath?: string
): string {
  const requestedPath =
    typeof outputPath === 'string' && outputPath.trim() ? outputPath.trim() : null;
  if (requestedPath) return pathResolver.rootResolve(requestedPath);
  return pathResolver.sharedTmp(`voice-generation/${requestId}.${format}`);
}

function parseTrailingJson(raw: string): any {
  for (const line of raw.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed);
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
  const bridgeScript = pathResolver.rootResolve(bridgeScriptPath);

  const refAudio = resolveProfileRefAudio(profile);
  const refText = refAudio ? resolveRefTranscript(refAudio) : undefined;

  const payload = JSON.stringify({
    action: 'generate',
    params: {
      text,
      output_path: outputPath,
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
  if (refAudio && safeExistsSync(outputPath)) {
    try {
      const probeTotal = safeExec('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        outputPath,
      ]).trim();
      const totalDuration = parseFloat(probeTotal);
      const estimatedDuration = Math.min(totalDuration, text.length / 5.5 + 0.6);

      if (Number.isFinite(totalDuration) && totalDuration > estimatedDuration) {
        const tempPath = `${outputPath}.tmp.wav`;
        safeExec('ffmpeg', [
          '-y',
          '-sseof',
          `-${estimatedDuration.toFixed(2)}`,
          '-i',
          outputPath,
          '-c',
          'copy',
          tempPath,
        ]);
        if (safeExistsSync(tempPath)) {
          safeExec('mv', [tempPath, outputPath]);
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

function openPlaybackArtifact(artifactPath: string): void {
  if (process.platform === 'linux') {
    safeExec('xdg-open', [artifactPath]);
    return;
  }
  if (process.platform === 'win32') {
    safeExec('powershell', [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${artifactPath.replace(/'/g, "''")}'`,
    ]);
    return;
  }
  safeExec('open', [artifactPath]);
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
    if (safeStat(artifactPath).size < 1024) {
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

  if (process.platform === 'darwin') {
    const rendered = renderWithSay(text, {
      requestId: options.requestId,
      voice: options.voice,
      rate: options.rate,
      format: options.format,
      outputPath: options.outputPath,
    });
    if (await isRenderableAudioArtifact(rendered)) {
      return rendered;
    }
    throw new Error(`say produced an invalid audio artifact: ${rendered}`);
  }

  if (process.platform === 'linux') {
    if (options.format !== 'wav') {
      throw new Error(
        `linux native artifact rendering supports only wav, received ${options.format}`
      );
    }
    safeExec('espeak', ['-s', String(options.rate), '-w', artifactPath, text]);
    return artifactPath;
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
    const tmpPath =
      playbackSourcePath || pathResolver.sharedTmp(`voice-playback-${Date.now()}.wav`);
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
    const playbackSource = playbackSourcePath || (await renderVoicePlaybackSource(text, options));
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
  if (process.platform === 'linux') {
    await retry(async () => {
      safeExec('espeak', ['-s', String(options.rate), text]);
    }, buildRetryOptions());
    return {
      playback_source_path: undefined,
      outputs: [],
    };
  }
  if (process.platform === 'win32') {
    const escaped = text.replace(/'/g, "''");
    await retry(async () => {
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
