import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExecResult,
  safeMkdir,
} from './secure-io.js';
import { logger } from './core.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import { isAppleSilicon } from './platform.js';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from './seam-provider-selection.js';
import { matchSeamSelectionRule } from './seam-selection-rules.js';
import {
  clampMusicGenDurationSec,
  clampStableAudioDurationSec,
  resolveLocalMusicGenMlxGenerationPolicy,
  resolveLocalStableAudioGenerationPolicy,
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

export class LocalMusicGenMlxGenerationProvider implements MusicGenerationProvider {
  readonly id = 'musicgen_mlx';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;

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

const MUSIC_GENERATION_PROVIDER_SEAM = 'music-generation-provider';

const providers: MusicGenerationProvider[] = [
  new LocalMusicGenMlxGenerationProvider(),
  new LocalStableAudioGenerationProvider(),
];

export function listMusicGenerationProviders(): MusicGenerationProvider[] {
  return [...providers];
}

export function getMusicGenerationProvider(id: string): MusicGenerationProvider | undefined {
  return providers.find((provider) => provider.id === id);
}

/** Order used without a purpose: MLX first on Apple Silicon, Stable Audio elsewhere. */
function platformOrder(): string[] {
  return isAppleSilicon() ? ['musicgen_mlx', 'stable_audio_3'] : ['stable_audio_3', 'musicgen_mlx'];
}

/**
 * Which providers can run this request here and now: availability
 * (isAvailable) plus the declared duration and output-format limits.
 */
export async function listMusicGenerationCandidates(
  request: Pick<MusicGenerationRequest, 'durationSec' | 'format'>
): Promise<SeamProviderCandidate[]> {
  const format = request.format?.trim().toLowerCase().replace(/^\./u, '');
  const candidates: SeamProviderCandidate[] = [];
  for (const provider of providers) {
    const unmet: string[] = [];
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
  const chain = [
    ...lead,
    ...platformOrder().filter((id) => eligible.has(id) && !lead.includes(id)),
  ];
  if (chain.length > 0) return chain;
  const reasons = candidates.map((c) => `${c.id}: ${(c.unmet ?? []).join(', ') || 'ineligible'}`);
  return `No available Music Generation provider could be resolved (${reasons.join('; ')})`;
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
  for (const providerId of preference) {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) continue;
    const result = await provider.generate(request);
    if (result.status !== 'failed') return result;
    lastError = result.error;
  }

  return {
    status: 'failed',
    provider: preference[0] || 'stable_audio_3',
    elapsedMs: 0,
    error: lastError || 'No available Music Generation provider could be resolved.',
  };
}
