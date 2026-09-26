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
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import type { OcrRequest, OcrResult } from '@agent/core/ocr-types';
import type { describeImage } from '@agent/core/image-description-bridge';
import type {
  SpeechToTextBridge,
  TranscribeResult,
  TranscriptSegment,
} from '@agent/core/speech-to-text-bridge';
import { ScriptExitError } from './harness.js';

export type MediaTool = 'ffmpeg' | 'ffprobe';
type ImageDescriptionRequest = Parameters<typeof describeImage>[0];
type ImageDescriptionResult = Awaited<ReturnType<typeof describeImage>>;

export interface PerceptionDeps {
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
    const { describeImage } = await import('@agent/core/image-description-bridge');
    return describeImage(request);
  },
  async sttBridges() {
    // Same install order as minutes:record — synchronous local backends
    // first; Apple's on-device recognizers only when nothing else registered.
    const stt = await import('@agent/core/speech-to-text-bridge');
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
  return absolute;
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
export function createPerceptionWorkDir(command: string): string {
  const dir = pathResolver.sharedTmp(`perception-${command}-${randomUUID()}`);
  safeMkdir(dir, { recursive: true });
  return dir;
}

export function removeWorkDir(dir: string | undefined): void {
  if (dir) safeRmSync(dir, { recursive: true, force: true });
}

/** Cheap header sniff for common raster formats; undefined when unknown. */
export function sniffImageDimensions(
  buffer: Buffer
): { width: number; height: number } | undefined {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
    return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) return undefined;
      const marker = buffer[offset + 1]!;
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

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
  output: string
): Promise<void> {
  await deps.runMedia('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
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
    await import('@agent/core/speech-to-text-bridge');
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
        errors.push(`${bridge.name}: returned a synthetic (sidecar) transcript — ignored`);
        continue;
      }
      return { result: normalizeSpeechToTextResult(bridge, raw), errors };
    } catch (error) {
      errors.push(`${bridge.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new NoTranscriptError(
    `every speech-to-text backend failed (${errors.join('; ')}). ${VOICE_SETUP_HINT}`
  );
}

/** Turn a missing-ffmpeg failure into the install instruction. */
export function explainMediaError(command: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|ENOENT/i.test(message) && /ffmpeg|ffprobe/i.test(message)) {
    throw new ScriptExitError(
      1,
      `[${command}] ffmpeg/ffprobe is not installed. Install it (macOS: \`brew install ffmpeg\`) and retry.`
    );
  }
  throw new ScriptExitError(1, `[${command}] media processing failed: ${message}`);
}

/** Shared option parsing: every perception command takes --json / --out / --lang / --verbose / --help. */
export interface CommonArgs {
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
  } else return undefined;
  return { consumed: 0 };
}

export function emitOutput(
  command: string,
  rendered: string,
  out: string | undefined,
  print: (text: string) => void,
  summary: string
): void {
  if (!out) {
    print(rendered);
    return;
  }
  const target = pathResolver.rootResolve(out);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[${command}] --out ${out} must be inside the repository`);
  }
  safeWriteFile(target, `${rendered}\n`);
  print(`[${command}] wrote ${out} (${summary})`);
}
