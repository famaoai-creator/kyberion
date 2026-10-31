import { isRecord } from '@agent/core/foundation/text';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { resolveScopeContext } from '@agent/core/scope-context';
import { resolveStorageFloor, classifyStorageFloorPath } from '@agent/core/storage-layout';
import { resolvePerceptionScope } from '@agent/core/perception/observation';
import { inferImagePayloadTier } from '@agent/core/media/image-description-bridge';
import { KNOWLEDGE_TIER_RANK } from '@agent/core/foundation/knowledge-tier';
import { parsePerceptionOption } from './perception-enhancements.js';
/**
 * Shared plumbing for the perception CLI commands (`pnpm kyberion see |
 * listen | watch`). Same contract as `pnpm kyberion read`: inputs must be
 * inside the repository, stdout carries the content, caveats arrive as
 * `> [<cmd>] …` lines.
 *
 * Everything that touches a provider (OCR, image description, STT, ffmpeg)
 * goes through `PerceptionDeps`, so the commands stay hermetically testable:
 * the defaults lazily bind the governed core bridges
 * (@agent/core/ocr-bridge, image-description-bridge, speech-to-text-bridge,
 * platform media runner).
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  assertSafeRepositoryPath,
  safeReadFileRange,
} from '@agent/core/secure-io';
import type { OcrRequest, OcrResult } from '@agent/core/ocr-types';
import type { describeImage } from '@agent/core/media/image-description-bridge';
import type {
  SpeechToTextBridge,
  TranscribeResult,
  TranscriptSegment,
} from '@agent/core/voice/speech-to-text-bridge';
import { ScriptExitError } from './harness.js';

export const LOCAL_MEDIA_INPUT_ARGS = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'wav,mp3,flac,ogg,aac,mov,matroska,webm,aiff,caf,avi',
] as const;

export type MediaTool = 'ffmpeg' | 'ffprobe';
type ImageDescriptionRequest = Parameters<typeof describeImage>[0];
type ImageDescriptionResult = Awaited<ReturnType<typeof describeImage>>;

export interface PerceptionDeps {
  enhancements?: import('./perception-enhancements.js').PerceptionEnhancementDeps;
  ocr(request: OcrRequest): Promise<OcrResult>;
  describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult>;
  /** Registered STT bridges (stub included when nothing real is installed). */
  sttBridges(): Promise<SpeechToTextBridge[]>;
  runMedia(tool: MediaTool, args: string[]): Promise<string>;
}

export const defaultPerceptionDeps: PerceptionDeps = {
  async ocr(request) {
    const { ocrImage } = await import('@agent/core/ocr-bridge');
    return ocrImage(request);
  },
  async describe(request) {
    const { describeImage } = await import('@agent/core/media/image-description-bridge');
    return describeImage(request);
  },
  async sttBridges() {
    // Same install order as minutes:record — synchronous local backends
    // first; Apple's on-device recognizers only when nothing else registered.
    const stt = await import('@agent/core/voice/speech-to-text-bridge');
    stt.installAvailableSpeechToTextBridges();
    if (stt.getSpeechToTextBridge().name === 'stub') {
      const { installAppleSpeechToTextBridgeIfAvailable } =
        await import('@agent/core/apple-intelligence-bridge');
      if (!(await installAppleSpeechToTextBridgeIfAvailable().catch(() => false))) {
        const { installAppleSpeechFileToTextBridgeIfAvailable } =
          await import('@agent/core/apple-speech-file-stt-bridge');
        installAppleSpeechFileToTextBridgeIfAvailable();
      }
    }
    return stt.getSpeechToTextBridges();
  },
  async runMedia(tool, args) {
    const { getPlatformDriver } = await import('@agent/core/platform');
    return getPlatformDriver().runMediaCommand(tool, args);
  },
};

/**
 * R04 — media signature sniffing. An extension alone does not prove media:
 * check the leading bytes for a known container magic before ffmpeg is ever
 * spawned, so an 8-byte 'fake-wav' reports input_invalid instead of dumping
 * raw ffmpeg stderr. Signatures cover the accepted AUDIO_EXTENSIONS +
 * VIDEO_EXTENSIONS families (RIFF/WAVE, ID3/MPEG-sync, ISO-BMFF ftyp, Ogg,
 * FLAC, CAF/AIFF, EBML/Matroska).
 */
const MEDIA_MAGICS: ReadonlyArray<{ offset: number; bytes: number[]; label: string }> = [
  { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], label: 'RIFF' }, // .wav/.avi (WAVE checked below)
  { offset: 0, bytes: [0x49, 0x44, 0x33], label: 'ID3' }, // .mp3 w/ tags
  { offset: 0, bytes: [0xff, 0xfb], label: 'MPEG frame' }, // .mp3/.aac raw
  { offset: 0, bytes: [0xff, 0xf3], label: 'MPEG frame' },
  { offset: 0, bytes: [0xff, 0xf2], label: 'MPEG frame' },
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], label: 'Ogg' }, // .ogg/.opus
  { offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43], label: 'fLaC' }, // .flac
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], label: 'EBML' }, // .webm/.mkv
  { offset: 0, bytes: [0x46, 0x4f, 0x52, 0x4d], label: 'FORM' }, // .aiff/.aifc
  { offset: 0, bytes: [0x63, 0x61, 0x66, 0x66], label: 'caff' }, // .caf
];

export function sniffMediaSignature(absolute: string): boolean {
  let header: Buffer;
  try {
    header = safeReadFileRange(absolute, 0, 16) as Buffer;
  } catch {
    return false;
  }
  for (const magic of MEDIA_MAGICS) {
    if (magic.bytes.every((byte, index) => header[magic.offset + index] === byte)) return true;
  }
  // ISO-BMFF: size(4) + 'ftyp' box at offset 4 — .m4a/.mp4/.mov/.m4v
  return header.length >= 8 && header.toString('latin1', 4, 8) === 'ftyp';
}

/**
 * R04 — perception error classes. Keep these names stable: they are the
 * outcome categories the CLI reliability matrix classifies against.
 */
export type PerceptionErrorClass =
  | 'input_invalid'
  | 'backend_missing'
  | 'assets_missing'
  | 'permission_denied'
  | 'backend_runtime_error';

export interface ClassifiedPerceptionError {
  cls: PerceptionErrorClass;
  message: string;
}

/** Strip absolute repository paths from text meant for public stdout/stderr. */
function scrubPaths(text: string): string {
  const root = pathResolver.rootDir();
  return text.split(root).join('<repo>');
}

const PERMISSION_PATTERN = /ROLE_VIOLATION|EACCES|permission denied|PERCEPTION_SCOPE/i;
const ASSETS_PATTERN =
  /model(s)? (not|not found|missing|unavailable)|assets? (not|missing|unavailable)|ja_JP|no such file|ENOENT.*model|weights? not found/i;
const BACKEND_MISSING_PATTERN =
  /not installed|not in PATH|ENOENT.*(ffmpeg|ffprobe|whisper|python)|command not found|spawn .*ENOENT|no transcript backend|no speech-to-text backend/i;

export function classifyPerceptionError(message: string): PerceptionErrorClass {
  if (PERMISSION_PATTERN.test(message)) return 'permission_denied';
  if (ASSETS_PATTERN.test(message)) return 'assets_missing';
  if (BACKEND_MISSING_PATTERN.test(message)) return 'backend_missing';
  return 'backend_runtime_error';
}

/** Human-usable next step per error class — never 'voice setup' for denials. */
export function perceptionErrorNext(cls: PerceptionErrorClass): string {
  switch (cls) {
    case 'input_invalid':
      return 'supply a real audio/video file (check its content, not just the extension)';
    case 'backend_missing':
      return VOICE_SETUP_HINT;
    case 'assets_missing':
      return 'install the backend model/language assets for the chosen STT backend (e.g. Apple Speech assets via System Settings, or a whisper model directory), then retry';
    case 'permission_denied':
      return 'the STT backend could not read the tenant-scoped intermediate under the current role — run `pnpm kyberion listen` from an operator shell (no inherited worker MISSION_ROLE) or dispatch through a claimed WorkItem whose scope owns the tier';
    case 'backend_runtime_error':
      return 'retry; if it persists, check `pnpm kyberion doctor` and the backend binary version';
  }
}

export function isInsideRepository(absolute: string): boolean {
  const relative = path.relative(pathResolver.rootDir(), absolute);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Resolve a CLI input path, refusing anything outside the repository with the copy-in hint. */
export function resolveRepositoryInput(command: string, file: string): string {
  const absolute = pathResolver.rootResolve(file);
  if (!isInsideRepository(absolute)) {
    throw new ScriptExitError(
      1,
      `[${command}] ${file} is outside the repository. Copy it in first:\n` +
        `  mkdir -p active/shared/tmp/<job> && cp "${file}" active/shared/tmp/<job>/`
    );
  }
  return assertSafeRepositoryPath(absolute, { allowMissingLeaf: true });
}

export function assertExtension(
  command: string,
  absolute: string,
  allowed: readonly string[],
  hint = ''
): void {
  const ext = path.extname(absolute).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new ScriptExitError(
      1,
      `[${command}] unsupported file type "${ext || '(none)'}". Supported: ${allowed.join(', ')}.${hint ? ` ${hint}` : ''}`
    );
  }
}

export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.heic',
  '.tif',
  '.tiff',
  '.bmp',
] as const;
export const AUDIO_EXTENSIONS = [
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.webm',
  '.caf',
  '.aiff',
] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'] as const;

/** A uniquely named scratch directory under the shared tmp floor. */
export function createPerceptionWorkDir(command: string, sourceFile?: string): string {
  const scope = sourceFile ? resolvePerceptionScope(sourceFile) : resolveScopeContext();
  const dir = resolveStorageFloor(
    'scratch',
    { kind: 'tier', tier: scope.tier, tenant: scope.tenant_slug },
    'perception',
    command + '-' + randomUUID()
  );
  safeMkdir(dir, { recursive: true });
  return dir;
}

export function removeWorkDir(dir: string | undefined): void {
  if (dir) safeRmSync(dir, { recursive: true, force: true });
}

export { sniffImageDimensions } from '@agent/core/perception/image-dimensions';

/** `mm:ss` (or `h:mm:ss` from one hour). */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function renderSegments(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (segment) =>
        `[${formatTimestamp(segment.start_sec)}–${formatTimestamp(segment.end_sec)}] ${segment.text.trim()}`
    )
    .join('\n');
}

export const VOICE_SETUP_HINT =
  'Install a local speech-to-text backend with `pnpm kyberion voice setup` ' +
  '(or set KYBERION_STT_COMMAND), then retry.';

export class NoTranscriptError extends Error {}

/** 16 kHz mono PCM wav — the STT-ready shape the voice actuator normalizes to. */
export async function extractSttWav(
  deps: PerceptionDeps,
  input: string,
  output: string,
  maxSeconds?: number
): Promise<void> {
  await deps.runMedia('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...LOCAL_MEDIA_INPUT_ARGS,
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    ...(maxSeconds === undefined ? [] : ['-t', String(maxSeconds)]),
    output,
  ]);
}

export interface TranscriptOutcome {
  result: TranscribeResult;
  errors: string[];
}

/**
 * Transcribe an STT-ready wav with the registered bridges, highest priority
 * first (timestamp-capable first when asked). The stub bridge and any
 * `synthetic` result are never accepted — a sidecar is not a transcript.
 * The bridge's transcript file is pinned into `workDir`, never next to input.
 */
export async function transcribeWav(
  deps: PerceptionDeps,
  wavPath: string,
  workDir: string,
  options: { language?: string; preferTimestamps?: boolean }
): Promise<TranscriptOutcome> {
  const { normalizeSpeechToTextResult, getSpeechToTextCapabilities } =
    await import('@agent/core/voice/speech-to-text-bridge');
  const bridges = (await deps.sttBridges())
    .filter((bridge) => bridge.name !== 'stub')
    .sort((left, right) => {
      if (options.preferTimestamps) {
        const lt = getSpeechToTextCapabilities(left).timestamps ? 1 : 0;
        const rt = getSpeechToTextCapabilities(right).timestamps ? 1 : 0;
        if (lt !== rt) return rt - lt;
      }
      return (right.priority ?? 0) - (left.priority ?? 0) || left.name.localeCompare(right.name);
    });
  if (bridges.length === 0) {
    throw new NoTranscriptError(`no speech-to-text backend is installed. ${VOICE_SETUP_HINT}`);
  }
  const errors: string[] = [];
  for (const [index, bridge] of bridges.entries()) {
    try {
      const raw = await bridge.transcribe({
        audioPath: wavPath,
        ...(options.language ? { language: options.language } : {}),
        outputPath: path.join(workDir, `transcript-${index}.txt`),
      });
      if (raw.synthetic) {
        // A sidecar is not a real backend — counts as backend_missing.
        errors.push(
          `${bridge.name}: backend_missing — returned a synthetic (sidecar) transcript — ignored`
        );
        continue;
      }
      return { result: normalizeSpeechToTextResult(bridge, raw), errors };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // R04: classify each backend failure; raw stderr paths are scrubbed from
      // the message. permission_denied short-circuits — trying the remaining
      // backends under the same denied role can only repeat the violation.
      const cls = classifyPerceptionError(raw);
      errors.push(`${bridge.name}: ${cls} — ${scrubPaths(raw)}`);
      if (cls === 'permission_denied') break;
    }
  }
  const classified = errors
    .map((entry) => entry.match(/^([^:]+): (\w+) — /)?.[2] ?? 'backend_runtime_error')
    .filter((value, index, all) => all.indexOf(value) === index);
  const primary = classified[0] as PerceptionErrorClass;
  throw new NoTranscriptError(
    `every speech-to-text backend failed (${primary}: ${errors.join('; ')}). ${perceptionErrorNext(primary)}`
  );
}

/** R04: classify media errors — never dump raw ffmpeg stderr or scoped paths. */
export function explainMediaError(command: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const cls = classifyPerceptionError(message);
  if (cls === 'backend_missing' && /ffmpeg|ffprobe/i.test(message)) {
    throw new ScriptExitError(
      1,
      `[${command}] backend_missing: ffmpeg/ffprobe is not installed. Install it (macOS: \`brew install ffmpeg\`) and retry.`
    );
  }
  throw new ScriptExitError(
    1,
    `[${command}] ${cls}: media processing failed — ${scrubPaths(message)} | next: ${perceptionErrorNext(cls)}`
  );
}

/** Shared option parsing: every perception command takes --json / --out / --lang / --verbose / --help. */
export interface CommonArgs {
  enhancement?: import('./perception-enhancements.js').PerceptionOptions;
  file?: string;
  json: boolean;
  out?: string;
  lang?: string;
  help: boolean;
}

export function parseCommonOption(
  args: CommonArgs,
  argv: string[],
  index: number
): { consumed: number } | undefined {
  const value = argv[index]!;
  const takeValue = (label: string): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new ScriptExitError(1, `${value} requires ${label}`);
    return next;
  };
  if (value === '--json') args.json = true;
  else if (value === '--verbose')
    return { consumed: 0 }; // handled by the CLI dispatcher
  else if (value === '--help' || value === '-h') args.help = true;
  else if (value === '--out') {
    args.out = takeValue('a file path');
    return { consumed: 1 };
  } else if (value === '--lang') {
    args.lang = takeValue('a BCP-47 language tag');
    return { consumed: 1 };
  } else return parsePerceptionOption(args, argv, index);
  return { consumed: 0 };
}

export function emitOutput(
  command: string,
  rendered: string,
  out: string | undefined,
  print: (text: string) => void,
  summary: string,
  sourceFile?: string
): void {
  if (!out) {
    print(rendered);
    return;
  }
  const target = pathResolver.rootResolve(out);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[${command}] --out ${out} must be inside the repository`);
  }
  assertPerceptionOutput(sourceFile, target);
  safeWriteFile(target, `${rendered}\n`);
  print(`[${command}] wrote ${out} (${summary})`);
}

export function assertPerceptionOutput(sourceFile: string | undefined, target: string): void {
  const scope = sourceFile ? resolvePerceptionScope(sourceFile) : resolveScopeContext();
  const tier = inferImagePayloadTier(target);
  if (KNOWLEDGE_TIER_RANK[tier] < KNOWLEDGE_TIER_RANK[scope.tier])
    throw new ScriptExitError(1, '[PERCEPTION_SCOPE] derived output would lower source tier');
  const floor = classifyStorageFloorPath(target);
  if (floor?.partition.kind === 'tier' && floor.partition.tenant !== scope.tenant_slug)
    throw new ScriptExitError(1, '[PERCEPTION_SCOPE] output partition tenant differs');
  if (tier === 'public' && scope.tenant_slug && floor?.partition.kind !== 'tier')
    throw new ScriptExitError(1, '[PERCEPTION_SCOPE] tenant output requires an owned partition');
  // For private outputs resolve the existing parent to authenticate tenant scope.
  if (tier !== 'public') {
    const destination = resolvePerceptionScope(path.dirname(target));
    if (destination.tenant_slug !== scope.tenant_slug)
      throw new ScriptExitError(1, '[PERCEPTION_SCOPE] output tenant differs');
  }
}

export async function assertAudioAnalysisDuration(
  deps: PerceptionDeps,
  input: string
): Promise<void> {
  const output = await deps.runMedia('ffprobe', [
    '-v',
    'error',
    ...LOCAL_MEDIA_INPUT_ARGS,
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    input,
  ]);
  const info = parseSafeJsonInput(output, 'audio analysis duration');
  const raw = isRecord(info) && isRecord(info.format) ? info.format.duration : undefined;
  const duration = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600)
    throw new ScriptExitError(
      1,
      '[perception] audio analysis requires a known positive duration <=600 seconds'
    );
}

/** Authorize content before any native media loader receives the path. */
export function assertPerceptionInput(file: string): void {
  resolvePerceptionScope(file);
  safeReadFileRange(file, 0, 1);
}
