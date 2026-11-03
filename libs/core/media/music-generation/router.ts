import { logger } from '../../core.js';
import { isAppleSilicon } from '../../platform.js';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  resolveSeamSelectionEntry,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from '../../seam-provider-selection.js';
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
  const entry = resolveSeamSelectionEntry({ seam: MUSIC_GENERATION_PROVIDER_SEAM });
  if (entry.kind !== 'governed') return [];
  const options: ResolveSeamProviderOptions = {
    ...entry.request,
    candidates,
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
    const entry = resolveSeamSelectionEntry({ seam: MUSIC_GENERATION_PROVIDER_SEAM, purpose });
    if (entry.kind !== 'governed')
      throw new Error('[MUSIC_GENERATION_SELECTION] Purpose requires a governed selection');
    const decision = resolveSeamProviderDecision({
      ...entry.request,
      candidates,
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
