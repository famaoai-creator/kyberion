import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { commandLocatorAdapter } from '../platform-command-adapters.js';
import { logger } from '../core.js';
import { probeToolRuntime } from '../tool/tool-runtime-registry.js';
import { isAppleSilicon } from '../platform.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from '../seam-provider-selection.js';
import { matchSeamSelectionRule } from '../seam-selection-rules.js';
import {
  MUSAUDIOGEN_REQUIRED_FILES,
  MUSAUDIOGEN_VARIANT_HF_REPO,
  clampMlAudioGenDurationSec,
  clampMusicGenDurationSec,
  clampStableAudioDurationSec,
  resolveChatMusicianGenerationPolicy,
  resolveLocalMusicGenMlxGenerationPolicy,
  resolveLocalStableAudioGenerationPolicy,
  resolveMlAudioGenGenerationPolicy,
  resolveMlAudioGenVariant,
} from './music-generation-policy.js';
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
} from './music-generation-types.js';

function getFallbackTargetPath(request: MusicGenerationRequest): string {
  const filename = `generated-music-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`;
  const candidate = request.targetPath || pathResolver.resolve(`active/shared/tmp/${filename}`);
  assertSafeRepositoryPath(pathResolver.resolve(candidate), { allowMissingLeaf: true });
  return candidate;
}

function ensureWavTargetPath(targetPath: string): string {
  const extension = path.extname(targetPath);
  if (extension.toLowerCase() === '.wav') return targetPath;
  return extension ? `${targetPath.slice(0, -extension.length)}.wav` : `${targetPath}.wav`;
}

function patchUvxPackageSpec(args: string[], packageSpec: string): string[] {
  const next = [...args];
  const fromIndex = next.indexOf('--from');
  if (fromIndex >= 0 && next[fromIndex + 1]) {
    next[fromIndex + 1] = packageSpec;
  }
  return next;
}

async function runLocalMusicGenMlxGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveLocalMusicGenMlxGenerationPolicy();
  const durationSec = clampMusicGenDurationSec(request.durationSec, policy);
  const model = request.model?.trim() || policy.model;
  const packageSpec = policy.packageSpec;
  const prompt = request.prompt.trim();
  if (!prompt) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_prompt_required',
    };
  }

  const runtime = probeToolRuntime('musicgen_mlx', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_mlx_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  let args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    args = patchUvxPackageSpec(args, packageSpec);
  }

  // musicgen-mlx CLI: musicgen-mlx "<prompt>" [-m model] -d <sec> -o <path>
  args.push(prompt);
  if (!args.includes('-m') && !args.includes('--model')) {
    args.push('-m', model);
  }
  args.push('-d', String(durationSec), '-o', outputPath);

  const result = safeExecResult(runner.command, args, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 50,
  });

  if (result.status !== 0 || result.error) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error:
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        result.error?.message ||
        'musicgen_mlx_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_mlx_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

async function runLocalStableAudioGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveLocalStableAudioGenerationPolicy();
  const durationSec = clampStableAudioDurationSec(request.durationSec, policy);
  const model = request.model?.trim() || policy.model;
  const packageSpec = policy.packageSpec;
  const prompt = request.prompt.trim();
  if (!prompt) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'stable_audio_prompt_required',
    };
  }

  const runtime = probeToolRuntime('stable_audio_3', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'stable_audio_3_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  let args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    args = patchUvxPackageSpec(args, packageSpec);
  }

  // stable-audio --model small-music -p "<prompt>" --duration <sec> -o <path> [--device ...] [--seed ...]
  args.push('--model', model, '-p', prompt, '--duration', String(durationSec), '-o', outputPath);
  if (policy.device) {
    args.push('--device', policy.device);
  }
  if (policy.steps) {
    args.push('--steps', String(policy.steps));
  }
  const seed = request.seed?.trim() || policy.seed;
  if (seed) {
    args.push('--seed', seed);
  }

  const result = safeExecResult(runner.command, args, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 80,
  });

  if (result.status !== 0 || result.error) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error:
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        result.error?.message ||
        'stable_audio_3_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'stable_audio_3_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Resolve the `--weights-dir` for mlx-audiogen. An explicit env value that
 * looks like a path is used as-is (user-managed). Otherwise the variant
 * short name maps to a pre-converted weight repo that is downloaded once
 * into the tool's own model cache (`~/.mlx-audiogen/models/<variant>`).
 */
function provisionMlAudioGenWeights(
  variant: string,
  policy: { weightsDir?: string; timeoutMs: number }
): { dir: string } | { error: string } {
  const explicit = variant.trim();
  if (explicit.includes('/') || explicit.includes('\\')) {
    return { dir: explicit };
  }
  const repo = MUSAUDIOGEN_VARIANT_HF_REPO[explicit];
  if (!repo) {
    return {
      error:
        `musicgen_audiogen_weights_required: set KYBERION_MUSAUDIOGEN_WEIGHTS_DIR to a converted ` +
        `weights dir (mlx-audiogen-convert --model facebook/<variant> --output <dir>)`,
    };
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheDir = home
    ? path.join(home, '.mlx-audiogen', 'models', explicit)
    : path.join('active', 'shared', 'cache', 'mlx-audiogen', explicit);
  const complete = MUSAUDIOGEN_REQUIRED_FILES.every((file) =>
    safeExistsSync(path.join(cacheDir, file))
  );
  if (complete) return { dir: cacheDir };
  // huggingface_hub renamed its CLI to `hf`; older installs still ship
  // `huggingface-cli`. Try the new name first, then the legacy one.
  let downloadError = '';
  for (const cli of ['hf', 'huggingface-cli']) {
    const download = safeExecResult(
      'uvx',
      ['--from', 'huggingface_hub', cli, 'download', repo, '--local-dir', cacheDir],
      { timeoutMs: policy.timeoutMs, maxOutputMB: 20 }
    );
    if (download.status === 0 && !download.error) {
      downloadError = '';
      break;
    }
    downloadError = download.stderr?.trim() || download.stdout?.trim() || '';
  }
  if (downloadError) {
    return {
      error:
        downloadError ||
        `musicgen_audiogen_weights_download_failed: pre-converted weights for '${explicit}' ` +
          `could not be fetched from ${repo}; convert manually (mlx-audiogen-convert --model ` +
          `facebook/${explicit} --output <dir>) and set KYBERION_MUSAUDIOGEN_WEIGHTS_DIR`,
    };
  }
  const ready = MUSAUDIOGEN_REQUIRED_FILES.every((file) =>
    safeExistsSync(path.join(cacheDir, file))
  );
  if (!ready) {
    return {
      error: `musicgen_audiogen_weights_incomplete: ${cacheDir} lacks ${MUSAUDIOGEN_REQUIRED_FILES.join(', ')}`,
    };
  }
  return { dir: cacheDir };
}

async function runMlAudioGenGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveMlAudioGenGenerationPolicy();
  const durationSec = clampMlAudioGenDurationSec(request.durationSec, policy);
  const prompt = request.prompt.trim();
  if (!prompt) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_audiogen_prompt_required',
    };
  }

  const runtime = probeToolRuntime('musicgen_audiogen', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_audiogen_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  let args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    args = patchUvxPackageSpec(args, policy.packageSpec);
  }

  // mlx-audiogen CLI: mlx-audiogen --model musicgen --prompt "<p>" --seconds <s> --output <path>
  // The model variant (mono/stereo/melody) follows --weights-dir, which the
  // bridge always passes: explicit env path as-is, otherwise a provisioned
  // pre-converted weights dir (auto-downloaded once). request.model selects
  // the variant (never forwarded).
  const weights = provisionMlAudioGenWeights(
    resolveMlAudioGenVariant(request.model, policy),
    policy
  );
  if ('error' in weights) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: weights.error,
    };
  }
  args.push(
    '--model',
    'musicgen',
    '--prompt',
    prompt,
    '--seconds',
    String(durationSec),
    '--output',
    outputPath,
    '--weights-dir',
    weights.dir,
    '--top-k',
    String(policy.topK),
    '--guidance-coef',
    String(policy.guidance)
  );
  const seed = request.seed?.trim() || policy.seed;
  if (seed) {
    args.push('--seed', seed);
  }

  const result = safeExecResult(runner.command, args, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 50,
  });

  if (result.status !== 0 || result.error) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error:
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        result.error?.message ||
        'musicgen_audiogen_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_audiogen_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Extract an ABC notation block from free-form LLM output. ChatMusician
 * answers with prose around the score; the score starts at the first `X:`
 * reference-number header.
 */
export function extractAbcNotation(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^X:\s*\d/.test(line.trim()));
  if (start < 0) return null;
  const abc = lines.slice(start).join('\n').trim();
  return abc && /^(T|M|L|R|K):/m.test(abc) ? abc : null;
}

function locateSystemCommand(command: string): string | null {
  const found = commandLocatorAdapter.locate(command);
  return found.length > 0 ? found[0]! : null;
}

async function runChatMusicianGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const failed = (error: string): MusicGenerationResult => ({
    status: 'failed',
    provider: providerId,
    elapsedMs: Date.now() - startedAt,
    error,
  });

  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveChatMusicianGenerationPolicy();
  const prompt = request.prompt.trim();
  if (!prompt) return failed('chatmusician_prompt_required');

  // Cheap static preconditions first: never burn a full LLM composition run
  // when the render toolchain is missing (explicit preferences bypass
  // isAvailable, so this check must live on the generate path too).
  if (!locateSystemCommand('abc2midi')) return failed('chatmusician_abc2midi_install_required');
  if (!locateSystemCommand('fluidsynth')) return failed('chatmusician_fluidsynth_install_required');
  if (!policy.soundfont || !safeExistsSync(policy.soundfont)) {
    return failed('chatmusician_soundfont_missing');
  }

  const runtime = probeToolRuntime('chatmusician_mlx', 'trial');
  if (runtime.selected_action === 'install') {
    return failed('chatmusician_mlx_install_required');
  }
  const runner = runtime.selected_backend || runtime.trial_backend;
  let llmArgs = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    llmArgs = patchUvxPackageSpec(llmArgs, policy.packageSpec);
  }

  // Stage 1: compose ABC notation with the ChatMusician LLM. durationSec
  // cannot clamp symbolic composition, so it rides along as a soft hint.
  const durationHint =
    typeof request.durationSec === 'number' && Number.isFinite(request.durationSec)
      ? ` Aim for approximately ${Math.round(request.durationSec)} seconds of music.`
      : '';
  const abcPrompt =
    `Using ABC notation, compose a well-structured instrumental score for the following brief. ` +
    `Output the ABC notation (X:/T:/M:/L:/K: headers followed by the tune) and keep prose minimal.${durationHint}\n${prompt}`;
  llmArgs.push(
    '--model',
    policy.model || policy.hfRepo,
    '--prompt',
    abcPrompt,
    '--max-tokens',
    String(policy.maxTokens),
    '--temp',
    String(policy.temperature)
  );
  const seed = request.seed?.trim() || policy.seed;
  if (seed) {
    llmArgs.push('--seed', seed);
  }
  const llmResult = safeExecResult(runner.command, llmArgs, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 10,
  });
  if (llmResult.status !== 0 || llmResult.error) {
    return failed(
      llmResult.stderr?.trim() ||
        llmResult.stdout?.trim() ||
        llmResult.error?.message ||
        'chatmusician_compose_failed'
    );
  }
  const abc = extractAbcNotation(llmResult.stdout ?? '');
  if (!abc) return failed('chatmusician_abc_parse_failed');

  const stem = outputPath.slice(0, -'.wav'.length);
  const abcPath = `${stem}.abc`;
  const midiPath = `${stem}.midi`;
  safeWriteFile(abcPath, abc + '\n');

  // Stage 2: ABC -> MIDI.
  if (!locateSystemCommand('abc2midi')) return failed('chatmusician_abc2midi_install_required');
  // Sub-stage budget: bounded by the policy timeout, never more than 5 min.
  const convertBudgetMs = Math.min(5 * 60 * 1000, policy.timeoutMs);
  const abc2midiDirect = safeExecResult('abc2midi', [abcPath, '-o', midiPath], {
    timeoutMs: convertBudgetMs,
    maxOutputMB: 10,
  });
  let renderedMidi: string | null = safeExistsSync(midiPath) ? midiPath : null;
  let legacyStderr = '';
  if (!renderedMidi) {
    // Older abcmidi builds ignore -o; fall back to the default output name.
    const legacy = safeExecResult('abc2midi', [abcPath], {
      timeoutMs: convertBudgetMs,
      maxOutputMB: 10,
    });
    legacyStderr = legacy.stderr?.trim() || '';
    renderedMidi =
      [`${stem}.midi`, `${stem}.mid`].find((candidate) => safeExistsSync(candidate)) || null;
    if (!renderedMidi) {
      return failed(legacyStderr || abc2midiDirect.stderr?.trim() || 'chatmusician_midi_missing');
    }
  }

  // Stage 3: MIDI -> WAV via a SoundFont synthesizer.
  if (!locateSystemCommand('fluidsynth')) return failed('chatmusician_fluidsynth_install_required');
  if (!policy.soundfont || !safeExistsSync(policy.soundfont)) {
    return failed('chatmusician_soundfont_missing');
  }
  // NB: fluidsynth parses options positionally — every flag must precede
  // the SoundFont and MIDI file arguments.
  const render = safeExecResult(
    'fluidsynth',
    ['-ni', '-F', outputPath, '-r', '44100', policy.soundfont, renderedMidi],
    { timeoutMs: policy.timeoutMs, maxOutputMB: 20 }
  );
  if (render.status !== 0 || render.error) {
    return failed(render.stderr?.trim() || 'chatmusician_render_failed');
  }
  if (!safeExistsSync(outputPath)) return failed('chatmusician_output_missing');

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export class LocalMusicGenMlxGenerationProvider implements MusicGenerationProvider {
  readonly id = 'musicgen_mlx';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** MusicGen renders instrumental audio only — no sung voice. */
  readonly supportsVocals = false;

  maxDurationSec(): number {
    return resolveLocalMusicGenMlxGenerationPolicy().maxDurationSec;
  }

  async isAvailable(): Promise<boolean> {
    return isAppleSilicon() && probeToolRuntime('musicgen_mlx').selected_action !== 'install';
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runLocalMusicGenMlxGeneration(request, Date.now(), this.id);
  }
}

export class LocalStableAudioGenerationProvider implements MusicGenerationProvider {
  readonly id = 'stable_audio_3';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** Stable Audio renders instrumental audio only — no sung voice. */
  readonly supportsVocals = false;

  maxDurationSec(): number {
    return resolveLocalStableAudioGenerationPolicy().maxDurationSec;
  }

  async isAvailable(): Promise<boolean> {
    return probeToolRuntime('stable_audio_3').selected_action !== 'install';
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runLocalStableAudioGeneration(request, Date.now(), this.id);
  }
}

export class MlAudioGenGenerationProvider implements MusicGenerationProvider {
  readonly id = 'musicgen_audiogen';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** mlx-audiogen musicgen renders instrumental audio only — no sung voice. */
  readonly supportsVocals = false;

  maxDurationSec(): number {
    return resolveMlAudioGenGenerationPolicy().maxDurationSec;
  }

  async isAvailable(): Promise<boolean> {
    try {
      return (
        isAppleSilicon() && probeToolRuntime('musicgen_audiogen').selected_action !== 'install'
      );
    } catch {
      // Availability probes must never throw (see ChatMusician provider).
      return false;
    }
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runMlAudioGenGeneration(request, Date.now(), this.id);
  }
}

export class ChatMusicianGenerationProvider implements MusicGenerationProvider {
  readonly id = 'chatmusician_mlx';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** ABC scores render through a GM SoundFont — instrumental only. */
  readonly supportsVocals = false;

  async isAvailable(): Promise<boolean> {
    try {
      if (!isAppleSilicon()) return false;
      if (probeToolRuntime('chatmusician_mlx').selected_action === 'install') return false;
      const policy = resolveChatMusicianGenerationPolicy();
      return (
        locateSystemCommand('abc2midi') !== null &&
        locateSystemCommand('fluidsynth') !== null &&
        Boolean(policy.soundfont && safeExistsSync(policy.soundfont))
      );
    } catch {
      // Availability probes must never throw — an unprovable toolchain
      // simply means the provider cannot run here.
      return false;
    }
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runChatMusicianGeneration(request, Date.now(), this.id);
  }
}

const MUSIC_GENERATION_PROVIDER_SEAM = 'music-generation-provider';

const musicGenerationProviderSeam = createSeam<MusicGenerationProvider>({
  key: MUSIC_GENERATION_PROVIDER_SEAM,
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/media/music-generation-bridge.ts',
});
const musicGenerationProviderDisposers = new Map<string, () => void>();
let musicGenerationBuiltinsRegistered = false;

/** Register an implementation into the governed music generation provider seam. */
export function registerMusicGenerationProvider(
  provider: MusicGenerationProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'music-generation-extension' }
): () => void {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('MusicGenerationProvider.id is required');
  const disposeFromSeam = musicGenerationProviderSeam.register(id, provider, metadata);
  const dispose = () => {
    disposeFromSeam();
    if (musicGenerationProviderDisposers.get(id) === dispose) {
      musicGenerationProviderDisposers.delete(id);
    }
  };
  musicGenerationProviderDisposers.set(id, dispose);
  return dispose;
}

function ensureBuiltinMusicGenerationProviders(): void {
  if (musicGenerationBuiltinsRegistered) return;
  for (const provider of [
    new LocalMusicGenMlxGenerationProvider(),
    new MlAudioGenGenerationProvider(),
    new LocalStableAudioGenerationProvider(),
    new ChatMusicianGenerationProvider(),
  ]) {
    registerMusicGenerationProvider(provider, {
      provenance: 'builtin',
      source: 'music-generation-bridge',
    });
  }
  musicGenerationBuiltinsRegistered = true;
}

export function listMusicGenerationProviders(): MusicGenerationProvider[] {
  ensureBuiltinMusicGenerationProviders();
  return musicGenerationProviderSeam.list().map((entry) => entry.implementation);
}

export function getMusicGenerationProvider(id: string): MusicGenerationProvider | undefined {
  return listMusicGenerationProviders().find((provider) => provider.id === id);
}

export function resetMusicGenerationProviders(): void {
  for (const dispose of musicGenerationProviderDisposers.values()) dispose();
  musicGenerationProviderDisposers.clear();
  musicGenerationBuiltinsRegistered = false;
}

/**
 * Order used without a purpose: MLX first on Apple Silicon, Stable Audio
 * elsewhere. Composition-only providers (chatmusician_mlx) are intentionally
 * absent here, but resolveMusicProviderChain still tries eligible leftovers
 * as a sorted last-resort tail — so chatmusician may run without a purpose
 * when every platform-ordered provider is ineligible. Prefer purpose
 * 'compose' or an explicit preference to select it deliberately.
 */
function platformOrder(): string[] {
  return isAppleSilicon()
    ? ['musicgen_mlx', 'musicgen_audiogen', 'stable_audio_3']
    : ['stable_audio_3', 'musicgen_mlx', 'musicgen_audiogen'];
}

/**
 * Which providers can run this request here and now: availability
 * (isAvailable) plus the declared duration, vocal, and output-format limits.
 */
export async function listMusicGenerationCandidates(
  request: Pick<MusicGenerationRequest, 'durationSec' | 'format' | 'vocals'>
): Promise<SeamProviderCandidate[]> {
  const format = request.format?.trim().toLowerCase().replace(/^\./u, '');
  const wantsVocals = request.vocals === true;
  const candidates: SeamProviderCandidate[] = [];
  for (const provider of listMusicGenerationProviders()) {
    const unmet: string[] = [];
    if (wantsVocals && provider.supportsVocals !== true) {
      unmet.push('vocals requested (instrumental-only provider)');
    }
    if (format && provider.outputFormats && !provider.outputFormats.includes(format)) {
      unmet.push(`format ${format} (writes ${provider.outputFormats.join(', ')})`);
    }
    const maxDurationSec = provider.maxDurationSec?.();
    if (
      typeof request.durationSec === 'number' &&
      maxDurationSec !== undefined &&
      request.durationSec > maxDurationSec
    ) {
      unmet.push(`duration ${request.durationSec}s exceeds max ${maxDurationSec}s`);
    }
    if (unmet.length === 0 && !(await provider.isAvailable())) unmet.push('unavailable');
    candidates.push({ id: provider.id, eligible: unmet.length === 0, unmet });
  }
  return candidates;
}

function failedSelection(provider: string, error: string): MusicGenerationResult {
  return { status: 'failed', provider, elapsedMs: 0, error };
}

/**
 * Without a purpose an operator rule matching the request may lead the
 * platform order (a mission pin it produced is reused); requests no rule
 * matches keep that order and record nothing.
 */
function operatorRuleLead(candidates: SeamProviderCandidate[]): string[] {
  if (!matchSeamSelectionRule(MUSIC_GENERATION_PROVIDER_SEAM, {})) return [];
  const options: ResolveSeamProviderOptions = {
    seam: MUSIC_GENERATION_PROVIDER_SEAM,
    candidates,
    decisionKey: 'default',
  };
  const preview = explainSeamProviderDecision(options);
  if (preview.strategy !== 'rule' && preview.strategy !== 'pinned') return [];
  const decision = resolveSeamProviderDecision(options);
  return decision.provider_id ? [decision.provider_id] : [];
}

/** Which providers to try, in order; a string is a selection failure. */
async function resolveMusicProviderChain(
  request: MusicGenerationRequest
): Promise<string[] | string> {
  const purpose = request.purpose?.trim();
  if (purpose) {
    const known = listSeamSelectionPurposes(MUSIC_GENERATION_PROVIDER_SEAM);
    if (!known.includes(purpose)) {
      throw new Error(
        `[MUSIC_GENERATION_SELECTION] unknown purpose '${purpose}' for seam '${MUSIC_GENERATION_PROVIDER_SEAM}' (known: ${known.join(', ')})`
      );
    }
  }
  const candidates = await listMusicGenerationCandidates(request);
  if (purpose) {
    const decision = resolveSeamProviderDecision({
      seam: MUSIC_GENERATION_PROVIDER_SEAM,
      candidates,
      purpose,
      decisionKey: purpose,
    });
    if (!decision.provider_id) return `[MUSIC_GENERATION_SELECTION] ${decision.rationale}`;
    logger.info(
      `[music_generation_bridge] provider '${decision.provider_id}' selected (${decision.strategy}): ${decision.rationale}`
    );
    return decision.ranked;
  }
  const eligible = new Set(candidates.filter((c) => c.eligible).map((c) => c.id));
  const lead = operatorRuleLead(candidates);
  const preferred = platformOrder();
  const chain = [
    ...lead,
    ...preferred.filter((id) => eligible.has(id) && !lead.includes(id)),
    ...[...eligible]
      .filter((id) => !lead.includes(id) && !preferred.includes(id))
      .sort((left, right) => left.localeCompare(right)),
  ];
  if (chain.length > 0) return chain;
  const reasons = candidates.map((c) => `${c.id}: ${(c.unmet ?? []).join(', ') || 'ineligible'}`);
  const vocalHint =
    request.vocals === true
      ? ' No vocal-capable provider is registered (all local providers are instrumental-only; singing-voice synthesis via SongGeneration-MLX is a documented future path).'
      : '';
  return `No available Music Generation provider could be resolved (${reasons.join('; ')}).${vocalHint}`;
}

/**
 * Generate music. A named provider (providerPreference) runs as asked, with
 * its own error on failure. Otherwise only providers that can run the
 * request are tried: ranked by `purpose` (seam music-generation-provider),
 * or in platform order led by a matching operator rule.
 */
export async function generateMusic(
  request: MusicGenerationRequest
): Promise<MusicGenerationResult> {
  const explicit = Boolean(request.providerPreference?.length);
  const resolved = explicit
    ? request.providerPreference!
    : await resolveMusicProviderChain(request);
  if (typeof resolved === 'string') {
    return failedSelection(platformOrder()[0]!, resolved);
  }
  const preference = resolved;

  let lastError: string | undefined;
  const wantsVocals = request.vocals === true;
  for (const providerId of preference) {
    const provider = getMusicGenerationProvider(providerId);
    if (!provider) continue;
    // Explicit naming does not bypass the vocal split: an
    // instrumental-only provider fails closed instead of silently
    // rendering vocals:true requests as instrumentals.
    if (wantsVocals && provider.supportsVocals !== true) {
      lastError = `No vocal-capable provider: '${providerId}' is instrumental-only.`;
      continue;
    }
    try {
      const result = await provider.generate(request);
      if (result.status !== 'failed') return result;
      lastError = result.error;
    } catch (error) {
      // Policy-gated exec rejections surface as throws; contain them so
      // direct bridge consumers always get a failed result, not a throw.
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    status: 'failed',
    provider: preference[0] || 'stable_audio_3',
    elapsedMs: 0,
    error: lastError || 'No available Music Generation provider could be resolved.',
  };
}
