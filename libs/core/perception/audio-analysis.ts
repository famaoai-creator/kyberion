import { resolvePerceptionScope } from './observation.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as yaml from 'js-yaml';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeLstat,
  safeReaddir,
  safeReadFile,
  safeReadFileRange,
  buildSafeExecEnv,
  assertGovernedExec,
} from '../secure-io.js';
import { spawnManagedProcess, stopManagedProcess } from '../managed-process.js';
import { isRecord } from '../foundation/text.js';

/** Actual local inference only. Inputs are 16 kHz mono PCM16 WAV, bounded to ten minutes. */
export interface AudioAnalysisRequest {
  path: string;
  diarize?: boolean;
  events?: boolean;
  /** Local Community-1 bundle directory, including config.yaml and all three model subfolders. */
  diarizationModel?: string;
  /** Local MediaPipe-compatible YAMNet TFLite model with label metadata. */
  audioModel?: string;
  python?: string;
  timeoutMs?: number;
}
export interface SpeakerInterval {
  start_sec: number;
  end_sec: number;
  /** Session-local anonymous label, never an authenticated person identity. */
  speaker_id: string;
  confidence?: number;
}
export interface SoundEvent {
  start_sec: number;
  end_sec: number;
  label: string;
  confidence: number;
}
export interface AudioAnalysisResult {
  provider: string;
  speakers: SpeakerInterval[];
  events: SoundEvent[];
  warnings: string[];
}
export interface AlignedTranscriptSegment {
  start_sec: number;
  end_sec: number;
  text: string;
  speaker_id?: string;
  /** All positively overlapping labels. A single winner is omitted for overlapping speech. */
  speaker_ids: string[];
  speaker_status?: 'tentative';
  speaker_source?: 'diarization';
}
const MAX_INTERVALS = 10000;
const MAX_AUDIO_SECONDS = 600;
const MAX_HELPER_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 8192;

function invalid(message: string): never {
  throw new Error('[AUDIO_ANALYSIS_INVALID] ' + message);
}
function finiteTime(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_AUDIO_SECONDS
  )
    return invalid(name + ' must be a finite timestamp within 0..600 seconds');
  return value;
}
function interval(value: unknown): { start_sec: number; end_sec: number } {
  if (!isRecord(value)) return invalid('interval must be an object');
  const start_sec = finiteTime(value.start_sec, 'start_sec');
  const end_sec = finiteTime(value.end_sec, 'end_sec');
  if (end_sec <= start_sec) return invalid('end_sec must exceed start_sec');
  return { start_sec, end_sec };
}
function confidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    return invalid('confidence must be within 0..1');
  return value;
}
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    return invalid(name + ' must be a nonempty bounded string');
  return value;
}
function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_INTERVALS)
    return invalid(name + ' must contain at most 10000 entries');
  return value;
}

/** Provider results are untrusted data; never coerce strings or silently truncate them. */
export function validateAudioAnalysisResult(value: unknown): AudioAnalysisResult {
  if (!isRecord(value)) return invalid('result must be an object');
  const provider = text(value.provider, 'provider');
  const speakers = list(value.speakers, 'speakers').map((entry): SpeakerInterval => {
    if (!isRecord(entry)) return invalid('speaker must be an object');
    const speaker_id = text(entry.speaker_id, 'speaker_id', 128);
    if (!/^[a-zA-Z0-9_.:-]+$/u.test(speaker_id)) return invalid('invalid speaker_id');
    return {
      ...interval(entry),
      speaker_id,
      ...(entry.confidence !== undefined ? { confidence: confidence(entry.confidence) } : {}),
    };
  });
  const events = list(value.events, 'events').map((entry): SoundEvent => {
    if (!isRecord(entry)) return invalid('event must be an object');
    return {
      ...interval(entry),
      label: text(entry.label, 'label'),
      confidence: confidence(entry.confidence),
    };
  });
  if (!Array.isArray(value.warnings) || value.warnings.length > 32)
    return invalid('invalid warnings');
  const warnings = value.warnings.map((entry) => text(entry, 'warning', 2048));
  return { provider, speakers, events, warnings };
}

function localAsset(file: string, directory: boolean): string {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(file));
  const stat = safeLstat(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) return invalid('asset has wrong file type');
  if (!directory) safeReadFileRange(absolute, 0, 1);
  return absolute;
}

/** Validate descendant paths before native loaders can follow them outside the governed bundle. */
function assertModelTree(directory: string): void {
  let files = 0;
  let bytes = 0;
  function visit(dir: string, depth: number): void {
    if (depth > 6) return invalid('model bundle nesting exceeds its budget');
    for (const entry of safeReaddir(dir)) {
      if (++files > 512) return invalid('model bundle exceeds 512 entries');
      const file = assertSafeRepositoryPath(path.join(dir, entry));
      const stat = safeLstat(file);
      if (stat.isSymbolicLink()) return invalid('model bundle must not contain symbolic links');
      if (stat.isDirectory()) visit(file, depth + 1);
      else if (stat.isFile()) {
        safeReadFileRange(file, 0, 1);
        bytes += stat.size;
        if (bytes > 2 * 1024 * 1024 * 1024) return invalid('model bundle exceeds 2 GiB');
      } else return invalid('model bundle contains a non-regular asset');
    }
  }
  visit(directory, 0);
}

/** Restrict the configuration to the built-in Community-1 pipeline; no dynamic plugin classes. */
export function validateDiarizationConfig(value: unknown, bundle: string): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.pipeline) || !isRecord(value.pipeline.params))
    return invalid('Community-1 config must declare pipeline.params');
  if (Object.keys(value).some((key) => !['version', 'pipeline', 'params'].includes(key)))
    return invalid('Community-1 config contains unsupported root options');
  const name = value.pipeline.name;
  if (
    ![
      'pyannote.audio.pipelines.SpeakerDiarization',
      'pyannote.audio.pipelines.speaker_diarization.SpeakerDiarization',
    ].includes(String(name))
  )
    return invalid('only the built-in pyannote SpeakerDiarization pipeline is supported');
  if (Object.keys(value.pipeline).some((key) => !['name', 'params'].includes(key)))
    return invalid('unsupported pipeline options');
  const allowed = [
    'segmentation',
    'embedding',
    'plda',
    'clustering',
    'embedding_exclude_overlap',
    'segmentation_batch_size',
    'embedding_batch_size',
    'segmentation_step',
    'legacy',
  ];
  const params: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value.pipeline.params)) {
    if (!allowed.includes(key)) return invalid('unsupported pipeline parameter: ' + key);
    if (['segmentation', 'embedding', 'plda'].includes(key)) {
      if (item !== '$model/' + key)
        return invalid('model references must use bundled $model/' + key);
      assertModelTree(localAsset(path.join(bundle, key), true));
      params[key] = { checkpoint: bundle, subfolder: key, token: false };
    } else if (key === 'clustering') {
      if (item !== 'VBxClustering' && item !== 'AgglomerativeClustering')
        return invalid('unsupported clustering');
      params[key] = item;
    } else if (key.endsWith('_batch_size')) {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 128)
        return invalid('invalid batch size');
      // Small fixed batches keep the adapter's inference memory bounded.
      params[key] = Math.min(item, 4);
    } else if (key === 'segmentation_step') {
      if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0 || item > 1)
        return invalid('invalid segmentation step');
      params[key] = item;
    } else {
      if (typeof item !== 'boolean') return invalid('invalid pipeline boolean');
      params[key] = item;
    }
  }
  for (const key of ['segmentation', 'embedding', 'plda']) {
    if (!params[key]) return invalid('Community-1 config requires bundled ' + key);
  }
  function numericParameters(input: unknown, depth = 0): Record<string, unknown> {
    if (!isRecord(input) || depth > 3 || Object.keys(input).length > 32)
      return invalid('invalid pipeline hyperparameters');
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => {
        if (!/^[a-zA-Z0-9_]+$/u.test(key)) return invalid('invalid hyperparameter name');
        if (isRecord(item)) return [key, numericParameters(item, depth + 1)];
        if (typeof item !== 'number' || !Number.isFinite(item))
          return invalid('hyperparameters must be finite numbers');
        return [key, item];
      })
    );
  }
  return {
    pipeline: { name, params },
    ...(value.params !== undefined ? { params: numericParameters(value.params) } : {}),
  };
}

/** Do not turn duration/model absence into a successful empty recognition. */
export async function analyzeAudio(request: AudioAnalysisRequest): Promise<AudioAnalysisResult> {
  if (!request.diarize && !request.events) return invalid('select diarize and/or events');
  resolvePerceptionScope(request.path);
  const audio = localAsset(request.path, false);
  if (path.extname(audio).toLowerCase() !== '.wav')
    return invalid('input must be a normalized PCM16 WAV');
  if (safeLstat(audio).size > 20 * 1024 * 1024)
    return invalid('WAV exceeds the ten-minute input budget');
  const timeoutMs = request.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    return invalid('timeoutMs must be within 1..600000');
  let diarizationConfig: Record<string, unknown> | undefined;
  if (request.diarize) {
    if (!request.diarizationModel)
      throw new Error(
        '[AUDIO_MODEL_MISSING] --diarization-model requires a local Community-1 bundle; accept its model terms and provision assets under active/shared/cache/system/perception-models/ (or another repo path the scope may read — public or own-tenant tmp/staging) before running'
      );
    const bundle = localAsset(request.diarizationModel, true);
    const configPath = localAsset(path.join(bundle, 'config.yaml'), false);
    if (safeLstat(configPath).size > 65536) return invalid('diarization config exceeds 64 KiB');
    diarizationConfig = validateDiarizationConfig(
      yaml.load(safeReadFile(configPath, { encoding: 'utf8' }) as string, {
        schema: yaml.JSON_SCHEMA,
      }),
      bundle
    );
  }
  if (request.events && !request.audioModel)
    throw new Error(
      '[AUDIO_MODEL_MISSING] --audio-model requires a local MediaPipe-compatible YAMNet TFLite asset under active/shared/cache/system/perception-models/ (or another repo path the scope may read — public or own-tenant tmp/staging)'
    );
  const audioModel = request.events ? localAsset(request.audioModel!, false) : undefined;
  if (audioModel && !/\.(tflite|task)$/iu.test(audioModel))
    return invalid('audio model must be a .tflite or .task asset');
  const script = localAsset('libs/core/perception/audio-analysis.py', false);
  const command = request.python ?? 'python3';
  if (!command.trim() || command.startsWith('-') || /[\r\n\0]/u.test(command))
    return invalid('invalid Python executable');
  const args = ['-I', script];
  assertGovernedExec(command, args);
  const childEnv = buildSafeExecEnv({
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    PYANNOTE_METRICS_ENABLED: '0',
    DO_NOT_TRACK: '1',
    OMP_NUM_THREADS: '2',
  });
  delete childEnv.HF_TOKEN;
  delete childEnv.HUGGING_FACE_HUB_TOKEN;
  const resourceId = 'audio-analysis:' + randomUUID();
  const managed = spawnManagedProcess({
    resourceId,
    kind: 'service',
    ownerId: 'audio-perception',
    ownerType: 'perception-adapter',
    command,
    args,
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    },
    shutdownPolicy: 'manual',
  });
  return new Promise((resolve, reject) => {
    const child = managed.child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopManagedProcess(resourceId, null);
      if (error) reject(error);
      else {
        try {
          const result = validateAudioAnalysisResult(JSON.parse(stdout));
          if (request.diarize && !result.provider.includes('pyannote'))
            return invalid('diarization provider not reported');
          if (request.events && !result.provider.includes('mediapipe'))
            return invalid('event provider not reported');
          resolve(result);
        } catch (failure) {
          reject(failure);
        }
      }
    };
    const kill = (message: string) => {
      child.kill('SIGKILL');
      finish(new Error(message));
    };
    const timer = setTimeout(
      () => kill('[AUDIO_ANALYSIS_TIMEOUT] local inference deadline exceeded'),
      timeoutMs
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_HELPER_BYTES)
        return kill('[AUDIO_ANALYSIS_OUTPUT_LIMIT] output exceeded 4 MiB');
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_ERROR_BYTES)
        stderr += chunk.toString('utf8').slice(0, MAX_ERROR_BYTES - Buffer.byteLength(stderr));
    });
    child.once('error', (error) =>
      finish(new Error('[AUDIO_ANALYSIS_UNAVAILABLE] cannot run Python helper: ' + error.message))
    );
    child.once('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              '[AUDIO_ANALYSIS_FAILED] ' + (stderr.trim() || 'helper exited with code ' + code)
            )
      )
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(
      JSON.stringify({ audio, diarization_config: diarizationConfig, audio_model: audioModel })
    );
  });
}

/** Reconcile timestamps by positive overlap. Overlapping speech keeps all labels, never a guessed identity. */
export function alignSpeakerSegments(
  segments: readonly { start_sec: number; end_sec: number; text: string }[],
  speakers: readonly SpeakerInterval[]
): AlignedTranscriptSegment[] {
  if (segments.length > MAX_INTERVALS || speakers.length > MAX_INTERVALS)
    return invalid('too many intervals to align');
  const checked = speakers.map((speaker) => ({ ...speaker, ...interval(speaker) }));
  return segments.map((segment) => {
    const range = interval(segment);
    const labelText = text(segment.text, 'transcript text', 100000);
    const speaker_ids = [
      ...new Set(
        checked
          .filter(
            (speaker) =>
              Math.min(speaker.end_sec, range.end_sec) >
              Math.max(speaker.start_sec, range.start_sec)
          )
          .map((speaker) => text(speaker.speaker_id, 'speaker_id', 128))
      ),
    ].sort();
    return {
      ...range,
      text: labelText,
      speaker_ids,
      ...(speaker_ids.length === 1 ? { speaker_id: speaker_ids[0] } : {}),
      ...(speaker_ids.length
        ? { speaker_status: 'tentative' as const, speaker_source: 'diarization' as const }
        : {}),
    };
  });
}
