import { isAppleSilicon } from '../../platform.js';
import {
  ProviderChainRouter,
  ProviderSelectionError,
  unmetCandidateSummary,
} from '../../provider-chain-router.js';
import { type SeamProviderCandidate } from '../../seam-provider-selection.js';
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
} from '../music-generation-types.js';
import {
  MUSIC_GENERATION_PROVIDER_SEAM,
  listMusicGenerationProviders,
  getMusicGenerationProvider,
} from './provider-registry.js';

/**
 * Label used for the provider field of a total-failure result — mirrors the
 * platform-ordered head of the policy's `default_chains` without reading the
 * policy (selection itself is data-driven; this is report text only).
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

const chainSpec = {
  seam: MUSIC_GENERATION_PROVIDER_SEAM,
  label: '[music_generation_bridge]',
  errorTag: '[MUSIC_GENERATION_SELECTION]',
  eligibility: (request: MusicGenerationRequest) => listMusicGenerationCandidates(request),
  // A named provider runs as asked — no default order or eligible tail is
  // appended; the loop below reports each failure itself.
  explicitPreference: (request: MusicGenerationRequest) => request.providerPreference,
  preferenceOnly: true,
  purpose: (request: MusicGenerationRequest) => request.purpose,
  defaultOrderKey: () => `platform:${isAppleSilicon() ? 'apple_silicon' : 'generic'}`,
  builtinDefaultOrder: () => platformOrder(),
  governedScope: 'lead',
  strictPurposes: true,
  sortEligibleTail: true,
} as const;

/**
 * Which providers to try, in order: a purpose yields the governed ranked
 * chain; an operator rule or mission pin leads the platform default chain;
 * the remaining eligible providers trail alphabetically. Throws on an
 * unknown purpose; an unresolvable governed selection surfaces as
 * ProviderSelectionError.
 */
async function resolveMusicProviderChain(request: MusicGenerationRequest): Promise<string[]> {
  const router = new ProviderChainRouter<MusicGenerationProvider, MusicGenerationRequest>(
    listMusicGenerationProviders(),
    chainSpec
  );
  return router.resolveProviderIds(request);
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
  let preference: string[];
  try {
    preference = await resolveMusicProviderChain(request);
  } catch (error) {
    if (error instanceof ProviderSelectionError) {
      return failedSelection(platformOrder()[0]!, error.message);
    }
    throw error;
  }
  if (preference.length === 0) {
    const candidates = await listMusicGenerationCandidates(request);
    const reasons = unmetCandidateSummary(candidates);
    const vocalHint =
      request.vocals === true
        ? ' No vocal-capable provider is registered (all local providers are instrumental-only; singing-voice synthesis via SongGeneration-MLX is a documented future path).'
        : '';
    return failedSelection(
      platformOrder()[0]!,
      `No available Music Generation provider could be resolved (${reasons}).${vocalHint}`
    );
  }

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
