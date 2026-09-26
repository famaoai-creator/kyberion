/**
 * `pnpm kyberion speak <text | --file <txt>> [--out <audio>] [--voice <name>] [--lang <bcp47>] [--rate <n>] [--json]`
 *
 * The action-side inverse of `pnpm kyberion listen`. Text goes through the
 * voice actuator's engine-routed TTS (governed voice-tts-engine selection
 * over the voice engine registry) — no TTS of its own:
 *   - no --out  → `voice:speak_local` (plays on the local audio output)
 *   - --out     → `voice:generate_voice` (artifact delivery) rendered into a
 *                 unique shared-tmp scratch dir, then copied / transcoded to
 *                 the requested file; the scratch dir is always removed.
 *
 * Engines are restricted to local ones (`local_only`): the text never leaves
 * the machine. Inputs and outputs must be inside the repository.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
} from '@agent/core/secure-io';
import { ScriptExitError } from './lib/harness.js';
import {
  assertExtension,
  createPerceptionWorkDir,
  defaultPerceptionDeps,
  explainMediaError,
  isInsideRepository,
  parseCommonOption,
  removeWorkDir,
  resolveRepositoryInput,
  type CommonArgs,
  type MediaTool,
} from './lib/perception.js';

/** Hard cap on spoken text; longer scripts should be split (or rendered via a pipeline). */
export const MAX_SPEAK_CHARS = 10_000;
/** Audio files `--out` can produce: engine-native formats, plus ffmpeg transcodes. */
export const SPEAK_OUT_EXTENSIONS = ['.wav', '.aiff', '.m4a', '.mp3'] as const;

export const SPEAK_USAGE = `Usage: pnpm kyberion speak <text | --file <txt>> [--out <audio-file>] [--voice <name>] [--lang <bcp47>] [--rate <n>] [--json]

Speaks text with the local text-to-speech engine (governed engine selection, local engines only).
  --file <txt>    Read the text from a file inside the repository instead of the argument
  --out <file>    Write audio (${SPEAK_OUT_EXTENSIONS.join(' / ')}) inside the repository instead of playing it
  --voice <name>  Voice name for playback (file output uses the language-default voice)
  --lang <tag>    Language, e.g. ja, en (detected from the text when omitted)
  --rate <n>      Speaking rate in words per minute for playback
  --json          Print {backend, voice, language, out, bytes, warnings} as JSON
  --verbose       Keep runtime logs (off by default)

Text is limited to ${MAX_SPEAK_CHARS} characters. Hear it back with \`pnpm kyberion listen <file>\`.`;

/** Everything that touches a provider goes through here so the command stays hermetically testable. */
export interface SpeakDeps {
  /** Run one voice-actuator action (speak_local / generate_voice). */
  voice(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  runMedia(tool: MediaTool, args: string[]): Promise<string>;
  /** Voice profile + default voice generate_voice will use for a language. */
  voiceDefaults(language: string): Promise<{ profileId: string; voice?: string }>;
}

export const defaultSpeakDeps: SpeakDeps = {
  async voice(input) {
    const { handleAction } = await import('../libs/actuators/voice-actuator/src/index.js');
    return (await handleAction(input as never)) as Record<string, unknown>;
  },
  runMedia: (tool, args) => defaultPerceptionDeps.runMedia(tool, args),
  async voiceDefaults(language) {
    const { getVoiceProfileRegistry } = await import('@agent/core/voice-profile-registry');
    const { getVoiceTtsLanguageConfig } = await import('@agent/core/voice-tts-config');
    const primary = language.split('-')[0]!;
    const registry = getVoiceProfileRegistry();
    const profiles = registry.profiles.filter((p) => p.status === 'active');
    const profile =
      profiles.find((p) => p.profile_id === `operator-${primary}-default`) ??
      profiles.find((p) => p.tier === 'public' && p.languages.includes(primary));
    return {
      profileId: profile?.profile_id ?? registry.default_profile_id,
      voice: getVoiceTtsLanguageConfig(primary).voice,
    };
  },
};

interface SpeakArgs extends CommonArgs {
  words: string[];
  voice?: string;
  rate?: number;
}

export interface SpeakResult {
  backend: string;
  voice: string | null;
  language: string | null;
  out: string | null;
  bytes: number | null;
  warnings: string[];
}

function parseSpeakArgs(argv: string[]): SpeakArgs {
  const args: SpeakArgs = { json: false, help: false, words: [] };
  const takeValue = (index: number, label: string): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--'))
      throw new ScriptExitError(1, `${argv[index]} requires ${label}`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    const common = parseCommonOption(args, argv, index);
    if (common) {
      index += common.consumed;
      continue;
    }
    if (value === '--file') {
      args.file = takeValue(index, 'a text file path');
      index += 1;
    } else if (value === '--voice') {
      args.voice = takeValue(index, 'a voice name');
      index += 1;
    } else if (value === '--rate') {
      const raw = takeValue(index, 'a number (words per minute)');
      const rate = Number(raw);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) {
        throw new ScriptExitError(1, `--rate must be a number between 1 and 1000, got "${raw}"`);
      }
      args.rate = rate;
      index += 1;
    } else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else args.words.push(value);
  }
  return args;
}

function resolveSpeakText(args: SpeakArgs): string {
  if (args.file && args.words.length > 0) {
    throw new ScriptExitError(1, '[speak] pass the text or --file <txt>, not both');
  }
  let text = args.words.join(' ');
  if (args.file) {
    const absolute = resolveRepositoryInput('speak', args.file);
    if (!safeExistsSync(absolute)) throw new ScriptExitError(1, `[speak] ${args.file} not found`);
    text = String(safeReadFile(absolute, { encoding: 'utf8' }));
  }
  text = text.trim();
  if (!text) throw new ScriptExitError(1, '[speak] nothing to say: the text is empty');
  if (text.length > MAX_SPEAK_CHARS) {
    throw new ScriptExitError(
      1,
      `[speak] the text is ${text.length} characters; the limit is ${MAX_SPEAK_CHARS}. Split it into shorter parts.`
    );
  }
  return text;
}

function resolveSpeakOut(out: string): string {
  const target = pathResolver.rootResolve(out);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[speak] --out ${out} must be inside the repository`);
  }
  assertExtension('speak', target, SPEAK_OUT_EXTENSIONS);
  return target;
}

function assertVoiceSucceeded(result: Record<string, unknown>, op: string): void {
  if (result.status === 'succeeded') return;
  const reason = result.message ?? result.reason ?? `status=${String(result.status)}`;
  throw new ScriptExitError(1, `[speak] voice:${op} failed: ${String(reason)}`);
}

function toWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((w) => String(w)) : [];
}

export function renderSpeakResult(result: SpeakResult, options: { json: boolean }): string {
  if (options.json) return JSON.stringify(result, null, 2);
  const detail = [result.backend, result.voice ? `voice ${result.voice}` : undefined];
  const lines = [
    result.out
      ? `[speak] wrote ${result.out} (${result.backend}, ${result.bytes ?? 0} bytes)`
      : `[speak] spoke (${detail.filter(Boolean).join(', ')})`,
  ];
  lines.push(...result.warnings.map((w) => `> [speak] ${w}`));
  return lines.join('\n');
}

async function speakToFile(
  deps: SpeakDeps,
  text: string,
  args: SpeakArgs,
  target: string
): Promise<SpeakResult> {
  const ext = path.extname(target).toLowerCase();
  const format = ext === '.aiff' ? 'aiff' : 'wav';
  const language = (args.lang || (await detectLanguage(text))).toLowerCase();
  const defaults = await deps.voiceDefaults(language);
  const warnings: string[] = [];
  if (args.voice || args.rate !== undefined) {
    warnings.push(
      `--voice/--rate apply to playback only; file output uses the language-default voice${defaults.voice ? ` (${defaults.voice})` : ''}`
    );
  }
  const workDir = createPerceptionWorkDir('speak');
  try {
    const result = await deps.voice({
      action: 'generate_voice',
      request_id: `speak-${randomUUID()}`,
      text,
      profile_ref: { profile_id: defaults.profileId },
      engine: { engine_id: 'auto', local_only: true },
      rendering: {
        language,
        chunking: { max_chunk_chars: 5000, crossfade_ms: 0, preserve_paralinguistic_tags: false },
      },
      delivery: {
        mode: 'artifact',
        format,
        artifact_path: path.join(workDir, `speech.${format}`),
        emit_progress_packets: false,
      },
    });
    assertVoiceSucceeded(result, 'generate_voice');
    warnings.push(...toWarnings(result.warnings));
    const refs = Array.isArray(result.artifact_refs) ? result.artifact_refs : [];
    const rendered = typeof refs[0] === 'string' ? refs[0] : undefined;
    if (!rendered || !safeExistsSync(rendered)) {
      throw new ScriptExitError(
        1,
        '[speak] voice:generate_voice reported success but wrote no audio'
      );
    }
    safeMkdir(path.dirname(target), { recursive: true });
    if (ext === `.${format}`) {
      safeCopyFileSync(rendered, target);
    } else {
      const codec =
        ext === '.mp3' ? ['-c:a', 'libmp3lame', '-q:a', '4'] : ['-c:a', 'aac', '-b:a', '128k'];
      try {
        await deps.runMedia('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          rendered,
          ...codec,
          target,
        ]);
      } catch (error) {
        explainMediaError('speak', error);
      }
    }
    return {
      backend: String(result.resolved_engine_id ?? result.backend_id ?? 'unknown'),
      voice: defaults.voice ?? null,
      language,
      out: path.relative(pathResolver.rootDir(), target),
      bytes: safeStat(target).size,
      warnings,
    };
  } finally {
    removeWorkDir(workDir);
  }
}

async function detectLanguage(text: string): Promise<string> {
  const { detectTextLanguage } = await import('@agent/core/voice-engine-registry');
  return detectTextLanguage(text);
}

async function speakAloud(deps: SpeakDeps, text: string, args: SpeakArgs): Promise<SpeakResult> {
  const result = await deps.voice({
    action: 'speak_local',
    params: {
      text,
      local_only: true,
      ...(args.lang ? { language: args.lang } : {}),
      ...(args.voice ? { voice: args.voice } : {}),
      ...(args.rate !== undefined ? { rate: args.rate } : {}),
    },
  });
  assertVoiceSucceeded(result, 'speak_local');
  return {
    backend: String(result.resolved_engine_id ?? result.backend_id ?? 'unknown'),
    voice: typeof result.voice === 'string' ? result.voice : (args.voice ?? null),
    language: typeof result.language === 'string' ? result.language : (args.lang ?? null),
    out: null,
    bytes: null,
    warnings: toWarnings(result.warnings),
  };
}

export async function runSpeakCommand(
  argv: string[],
  print: (text: string) => void,
  deps: SpeakDeps = defaultSpeakDeps
): Promise<SpeakResult | undefined> {
  const args = parseSpeakArgs(argv);
  if (args.help) {
    print(SPEAK_USAGE);
    return undefined;
  }
  if (!args.file && args.words.length === 0) throw new ScriptExitError(1, SPEAK_USAGE);
  const target = args.out ? resolveSpeakOut(args.out) : undefined;
  const text = resolveSpeakText(args);
  const result = target
    ? await speakToFile(deps, text, args, target)
    : await speakAloud(deps, text, args);
  print(renderSpeakResult(result, { json: args.json }));
  return result;
}
