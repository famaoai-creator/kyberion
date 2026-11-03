import { logger } from '../../core.js';
import { getMediaBackendRegistry } from '../media-backend-registry.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
} from '../image-generation-types.js';
import {
  assertReferenceEgressAllowed,
  hasReferenceImages,
  recordReferenceEgressReceipt,
  referenceImageViolation,
} from '../image-reference-consent.js';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  resolveSeamSelectionEntry,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from '../../seam-provider-selection.js';
import { imageNeedsAdmission, governImageProvider } from './admission.js';
import { IMAGE_GENERATION_PROVIDER_SEAM } from './provider-registry.js';
import { isRateLimitOrQuotaError } from './provider-support.js';

/** Request facts operator rules may match on (e.g. `{ mode: 'fast' }`). */
function imageSelectionContext(request: ImageGenerationRequest): Record<string, string> {
  const context: Record<string, string> = {};
  if (request.mode) context.mode = request.mode;
  const aspectRatio = request.aspectRatio?.trim();
  if (aspectRatio) context.aspect_ratio = aspectRatio;
  return context;
}

export class AdaptivePolicyRouter {
  private providers: Map<string, ImageGenerationProvider> = new Map();
  private fallbackGraph: Map<string, string> = new Map();

  constructor(providers: ImageGenerationProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, governImageProvider(p));
    }
    this.initFallbackGraph();
  }

  private initFallbackGraph(): void {
    try {
      const registry = getMediaBackendRegistry();
      const backends = registry.backends.filter((b) => b.modality === 'image');
      const providerIdByBackendId = new Map<string, string>(
        [...this.providers.values()].flatMap((provider) =>
          (provider.backendIds ?? []).map((backendId) => [backendId, provider.id] as const)
        )
      );
      const resolveProviderId = (backendId: string): string => {
        const exact = providerIdByBackendId.get(backendId);
        if (exact) return exact;
        const aliasId = backends.find((backend) =>
          backend.aliases?.includes(backendId)
        )?.backend_id;
        return providerIdByBackendId.get(aliasId ?? backendId) ?? aliasId ?? backendId;
      };
      for (const b of backends) {
        if (b.fallback_backend_id) {
          const fromId = resolveProviderId(b.backend_id);
          const toId = resolveProviderId(b.fallback_backend_id);
          this.fallbackGraph.set(fromId, toId);
        }
      }
    } catch (_) {
      // Ignore registry loading issues in unit tests with mocked environments
    }
  }

  /** Why the request's mode forbids this provider (hard constraint), or null. */
  private modeViolation(
    request: ImageGenerationRequest,
    provider: ImageGenerationProvider
  ): string | null {
    if (
      (request.mode === 'privacy_first' || request.mode === 'local_only') &&
      provider.dataPolicy === 'training_eligible'
    ) {
      return `mode ${request.mode} excludes training_eligible data policy`;
    }
    if (request.mode === 'local_only' && provider.executionLocality !== 'local') {
      return `mode local_only excludes ${provider.executionLocality ?? 'unknown'} execution`;
    }
    return null;
  }

  /**
   * Every hard constraint: the mode's filters, then PA-10 reference-image
   * rules (reference support; cloud egress needs a consent naming the provider).
   */
  private hardViolation(
    request: ImageGenerationRequest,
    provider: ImageGenerationProvider,
    options: { ignoreConsent?: boolean } = {}
  ): string | null {
    if (request.allowedProviders && !request.allowedProviders.includes(provider.id)) {
      return 'not in the request allowlist (allowed_providers)';
    }
    return (
      this.modeViolation(request, provider) ?? referenceImageViolation(request, provider, options)
    );
  }

  /**
   * Eligibility of every registered provider for this request: the mode's
   * hard constraints, availability and (unless allowed) interactive hand-off.
   */
  private async selectionCandidates(
    request: ImageGenerationRequest,
    allowHostHandoff: boolean
  ): Promise<SeamProviderCandidate[]> {
    const candidates: SeamProviderCandidate[] = [];
    for (const provider of this.providers.values()) {
      const unmet: string[] = [];
      const violation = this.hardViolation(request, provider);
      if (violation) unmet.push(violation);
      if (provider.requiresInteractiveHandoff && !allowHostHandoff) {
        unmet.push('interactive host hand-off not allowed (allow_host_handoff)');
      }
      if (unmet.length === 0 && !(await provider.isAvailable())) unmet.push('unavailable');
      candidates.push({ id: provider.id, eligible: unmet.length === 0, unmet });
    }
    return candidates;
  }

  /** Candidates with eligibility for this request (hand-off only when allowed); for calibration. */
  async listCandidates(request: ImageGenerationRequest): Promise<SeamProviderCandidate[]> {
    return this.selectionCandidates(request, request.allowHostHandoff === true);
  }

  /**
   * Purpose-driven chain: every registered provider is filtered by the mode's
   * hard constraints, availability and (unless allowed) interactive hand-off;
   * the eligible ones are ranked by the governed seam policy. The decision is
   * audited and pinned per mission under the purpose.
   */
  private async resolvePurposeChain(
    request: ImageGenerationRequest,
    selection: Omit<ResolveSeamProviderOptions, 'candidates'>
  ): Promise<ImageGenerationProvider[]> {
    const purpose = selection.purpose!;
    const known = listSeamSelectionPurposes(IMAGE_GENERATION_PROVIDER_SEAM);
    if (!known.includes(purpose)) {
      throw new Error(
        `[IMAGE_GENERATION_SELECTION] unknown purpose '${purpose}' for seam '${IMAGE_GENERATION_PROVIDER_SEAM}' (known: ${known.join(', ')})`
      );
    }
    const candidates = await this.selectionCandidates(request, request.allowHostHandoff === true);
    const decision = resolveSeamProviderDecision({ ...selection, candidates });
    if (!decision.provider_id) {
      throw new Error(`[IMAGE_GENERATION_SELECTION] ${decision.rationale}`);
    }
    logger.info(
      `[image_generation_bridge] provider '${decision.provider_id}' selected (${decision.strategy}): ${decision.rationale}`
    );
    return decision.ranked.map((id) => this.providers.get(id)!);
  }

  /**
   * Without a purpose, an operator rule matching this request picks the
   * provider that leads the mode chain (a mission pin it produced is reused).
   * A request no rule matches keeps the mode chain unchanged — nothing is
   * recorded or pinned for it. Hand-off providers stay eligible, as in the
   * mode chain.
   */
  private async resolveOperatorRuleLead(request: ImageGenerationRequest): Promise<string[]> {
    const entry = resolveSeamSelectionEntry({
      seam: IMAGE_GENERATION_PROVIDER_SEAM,
      context: imageSelectionContext(request),
    });
    if (entry.kind !== 'governed') return [];
    const options: ResolveSeamProviderOptions = {
      ...entry.request,
      candidates: await this.selectionCandidates(request, request.allowHostHandoff === true),
    };
    // A matching rule whose providers are all ineligible keeps the mode chain.
    const preview = explainSeamProviderDecision(options);
    if (preview.strategy !== 'rule' && preview.strategy !== 'pinned') return [];
    const decision = resolveSeamProviderDecision(options);
    if (!decision.provider_id) return [];
    logger.info(
      `[image_generation_bridge] provider '${decision.provider_id}' leads the ${request.mode || 'balanced'} chain (${decision.strategy}): ${decision.rationale}`
    );
    return [decision.provider_id];
  }

  async resolveCandidateChain(
    request: ImageGenerationRequest,
    options: { ignoreConsent?: boolean } = {}
  ): Promise<ImageGenerationProvider[]> {
    const hasPreference = Boolean(request.providerPreference && request.providerPreference.length);
    if (!hasPreference) {
      const entry = resolveSeamSelectionEntry({
        seam: IMAGE_GENERATION_PROVIDER_SEAM,
        purpose: request.purpose,
        context: imageSelectionContext(request),
      });
      if (entry.kind === 'governed' && entry.request.purpose) {
        return this.resolvePurposeChain(request, entry.request);
      }
    }
    const ruleLead = hasPreference ? [] : await this.resolveOperatorRuleLead(request);
    const candidates: ImageGenerationProvider[] = [];
    const seenIds = new Set<string>();

    const addIfAvailableAndCompliant = async (provider: ImageGenerationProvider | undefined) => {
      if (!provider || seenIds.has(provider.id)) return;
      if (this.hardViolation(request, provider, options)) return;
      if (await provider.isAvailable()) {
        candidates.push(provider);
        seenIds.add(provider.id);
      }
    };

    for (const id of [...ruleLead, ...(request.providerPreference ?? [])]) {
      await addIfAvailableAndCompliant(this.providers.get(id));
    }

    const mode = request.mode || 'balanced';

    let defaultChain: string[] = [];
    if (mode === 'local_only' || mode === 'privacy_first') {
      defaultChain = [
        'apple_playground',
        'windows_native',
        'local_flux',
        'local_diffusion',
        'comfyui',
      ];
    } else if (mode === 'fast') {
      defaultChain = [
        'gemini_fast',
        'gemini_service',
        'gemini_image',
        'apple_playground',
        'windows_native',
        'local_flux',
        'comfyui',
        'llm_api',
        'cursor_host_bridge',
        'host_agent',
      ];
    } else if (mode === 'artistic') {
      defaultChain = [
        'cursor_host_bridge',
        'codex_host_bridge',
        'agy_host_bridge',
        'host_agent',
        'apple_playground',
        'windows_native',
        'gemini_service',
        'gemini_fast',
        'gemini_image',
        'llm_api',
        'local_flux',
        'comfyui',
      ];
    } else {
      // balanced
      defaultChain = [
        'cursor_host_bridge',
        'codex_host_bridge',
        'agy_host_bridge',
        'host_agent',
        'apple_playground',
        'windows_native',
        'local_flux',
        'comfyui',
        'gemini_fast',
        'gemini_service',
        'gemini_image',
        'llm_api',
      ];
    }

    for (const id of defaultChain) {
      await addIfAvailableAndCompliant(this.providers.get(id));
    }

    // Follow governed fallback_backend_id chains for any selected candidates
    const visited = new Set<string>(seenIds);
    for (const c of [...candidates]) {
      let curr = c.id;
      while (this.fallbackGraph.has(curr)) {
        const nextId = this.fallbackGraph.get(curr)!;
        if (visited.has(nextId)) break;
        visited.add(nextId);
        await addIfAvailableAndCompliant(this.providers.get(nextId));
        curr = nextId;
      }
    }

    return candidates;
  }

  async selectProvider(request: ImageGenerationRequest): Promise<ImageGenerationProvider> {
    const chain = await this.resolveCandidateChain(request);
    if (chain.length > 0) {
      return chain[0];
    }
    throw new Error('No available Image Generation provider could be resolved.');
  }

  /**
   * PA-10: the provider a request would reach once any required consent is
   * given — for consent prompts that must name the provider before anything
   * is sent. Mode filters, reference support and availability still apply.
   */
  async planProvider(request: ImageGenerationRequest): Promise<ImageGenerationProvider | null> {
    const chain = await this.resolveCandidateChain(request, { ignoreConsent: true });
    return chain[0] ?? null;
  }

  async generateWithFallback(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const candidates = await this.resolveCandidateChain(request);
    if (candidates.length === 0) {
      if (hasReferenceImages(request)) {
        const blocked = (await this.resolveCandidateChain(request, { ignoreConsent: true }))[0];
        if (blocked) {
          recordReferenceEgressReceipt(
            request,
            blocked,
            'denied',
            referenceImageViolation(request, blocked) ?? undefined
          );
          throw new Error(
            `[IMAGE_REFERENCE_EGRESS_DENIED] ${blocked.id} would receive the reference image(s) but no valid user_photo consent names it.`
          );
        }
        throw new Error(
          'No available Image Generation provider can honour reference images for this request.'
        );
      }
      throw new Error('No available Image Generation provider could be resolved.');
    }

    let lastError: unknown = null;

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i];
      try {
        logger.info(
          `[image_generation_bridge] Routing generation request to provider: ${provider.id}`
        );
        if (hasReferenceImages(request)) {
          // Re-checked at dispatch (a consent can expire between routing and
          // the call); the receipt precedes any egress.
          assertReferenceEgressAllowed(request, provider);
          recordReferenceEgressReceipt(request, provider, 'allowed');
        }
        const result = await provider.generate(request);
        // An external request was attempted. A quota/error receipt cannot
        // prove no generation or charge occurred; never change providers now.
        if (imageNeedsAdmission(provider)) return result;
        if (result.status === 'failed' && isRateLimitOrQuotaError(result.error)) {
          logger.warn(
            `[image_generation_bridge] Provider ${provider.id} encountered rate limit / quota error: ${result.error}. Attempting fallback.`
          );
          lastError = new Error(result.error);
          continue;
        }
        return result;
      } catch (err: any) {
        lastError = err;
        if (imageNeedsAdmission(provider) || err?.adfControlFlow === 'preflight') throw err;
        if (isRateLimitOrQuotaError(err)) {
          logger.warn(
            `[image_generation_bridge] Provider ${provider.id} threw rate limit / quota error: ${err?.message || err}. Attempting fallback.`
          );
          continue;
        }
        throw err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || 'All image generation providers failed.'));
  }
}
