import { logger } from '../core.js';
import { validateFileSize } from '../secure-io.js';
import { OcrRequest, OcrResult, OcrProvider, OcrDataEgress, OcrRoutingMode } from '../ocr-types.js';
import {
  resolveSeamProviderDecision,
  resolveSeamSelectionEntry,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from '../seam-provider-selection.js';
import { withEgressPayloadContext } from '../egress-policy.js';
import { providerDataPolicy, resolveOcrImagePath } from './provider-support.js';

export class AdaptivePolicyRouter {
  private providers: Map<string, OcrProvider> = new Map();

  constructor(providers: OcrProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
  }

  /**
   * Egress a mode is allowed to use. This is the enforcement point: it also
   * constrains providerPreference, so a preference can reorder the chain but
   * can never widen it past what the mode permits.
   */
  private allowedEgress(mode: OcrRoutingMode): ReadonlySet<OcrDataEgress> {
    if (mode === 'local_only') return new Set<OcrDataEgress>(['none']);
    if (mode === 'privacy_first') return new Set<OcrDataEgress>(['none', 'loopback']);
    return new Set<OcrDataEgress>(['none', 'loopback', 'external']);
  }

  private allowedDataPolicies(
    request: OcrRequest
  ): ReadonlySet<NonNullable<OcrProvider['dataPolicy']>> {
    switch (request.training_use || 'local_only') {
      case 'training_eligible':
        return new Set(['local_only', 'zero_retention', 'training_eligible']);
      case 'zero_retention':
        return new Set(['local_only', 'zero_retention']);
      default:
        return new Set(['local_only']);
    }
  }

  private getProviderIds(request: OcrRequest): string[] {
    const preferred =
      request.providerPreference && request.providerPreference.length > 0
        ? request.providerPreference
        : [];
    const mode = request.mode || 'balanced';

    // Ordering preference only. Membership is decided by the egress filter in
    // resolveCandidates(), derived from what each provider declares about itself.
    const defaultChain =
      mode === 'accurate'
        ? ['windows_native', 'llm_api', 'local_vlm', 'apple_vision', 'tesseract']
        : mode === 'privacy_first'
          ? ['windows_native', 'local_vlm', 'apple_vision', 'tesseract']
          : mode === 'local_only'
            ? ['windows_native', 'apple_vision', 'tesseract']
            : ['windows_native', 'apple_vision', 'llm_api', 'tesseract'];

    const merged = [...preferred, ...defaultChain, ...this.providers.keys()];
    const seen = new Set<string>();
    return merged.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /**
   * Hard-eligible providers for `request.mode`: allowed by the egress filter
   * and available right now. This is the same eligibility test resolveCandidates
   * uses by default; purpose-driven selection reuses it instead of a second
   * notion of "can run this task". Public so the 'ocr-provider' seam
   * calibration adapter (scripts/lib/seam-calibration/ocr-provider.ts) can
   * reuse it instead of re-deriving eligibility.
   */
  async eligibleCandidates(request: OcrRequest): Promise<SeamProviderCandidate[]> {
    const mode = request.mode || 'balanced';
    const allowed = this.allowedEgress(mode);
    const allowedPolicies = this.allowedDataPolicies(request);
    const candidates: SeamProviderCandidate[] = [];
    for (const provider of this.providers.values()) {
      if (!allowed.has(provider.dataEgress)) {
        candidates.push({
          id: provider.id,
          eligible: false,
          unmet: [`dataEgress '${provider.dataEgress}' not permitted by mode '${mode}'`],
        });
        continue;
      }
      const dataPolicy = providerDataPolicy(provider);
      if (!allowedPolicies.has(dataPolicy)) {
        candidates.push({
          id: provider.id,
          eligible: false,
          unmet: [
            `dataPolicy '${dataPolicy}' not permitted by training_use '${request.training_use || 'local_only'}'`,
          ],
        });
        continue;
      }
      const available = await provider.isAvailable();
      candidates.push(
        available
          ? { id: provider.id, eligible: true }
          : { id: provider.id, eligible: false, unmet: ['provider not available'] }
      );
    }
    return candidates;
  }

  /**
   * Purpose-driven order: hard mode/availability eligibility (above) filters,
   * then the governed ocr-provider selection policy ranks who runs the task.
   * Used when the caller asked for a purpose, or (with no purpose) when an
   * operator rule matches this request (decisionKey 'default'). Request language,
   * when set, is passed as selection context so a rule can match on it.
   * Only used when the caller did not already pin an explicit
   * providerPreference — an explicit choice always wins.
   */
  private async resolvePurposeChain(
    request: OcrRequest,
    selection: Omit<ResolveSeamProviderOptions, 'candidates'>
  ): Promise<OcrProvider[]> {
    const candidates = await this.eligibleCandidates(request);
    const decision = resolveSeamProviderDecision({ ...selection, candidates });
    if (decision.strategy === 'unresolved') {
      throw new Error(`[OCR_PROVIDER_SELECTION] ${decision.rationale}`);
    }
    logger.info(
      `[ocr_bridge] ${selection.purpose ? `purpose '${selection.purpose}'` : 'rule-driven'} provider chain (${decision.strategy}): ${decision.ranked.join(' > ')} — ${decision.rationale}`
    );
    return decision.ranked
      .map((id) => this.providers.get(id))
      .filter((provider): provider is OcrProvider => Boolean(provider));
  }

  async resolveCandidates(request: OcrRequest): Promise<OcrProvider[]> {
    const hasProviderPreference = Boolean(
      request.providerPreference && request.providerPreference.length > 0
    );
    // Explicit provider chains retain their order. Every other request uses
    // the same normalized selection entry as the other provider seams.
    if (!hasProviderPreference) {
      const entry = resolveSeamSelectionEntry({
        seam: 'ocr-provider',
        purpose: request.purpose,
        ...(request.language ? { context: { language: request.language } } : {}),
      });
      if (entry.kind === 'governed') return this.resolvePurposeChain(request, entry.request);
    }

    // Eligibility is identical for legacy and purpose/rule-driven routing;
    // this path changes order only, never the admitted provider set.
    const eligible = new Set(
      (await this.eligibleCandidates(request))
        .filter((candidate) => candidate.eligible)
        .map((candidate) => candidate.id)
    );
    return this.getProviderIds(request)
      .filter((id) => eligible.has(id))
      .map((id) => this.providers.get(id)!);
  }

  async selectProvider(request: OcrRequest): Promise<OcrProvider> {
    const candidates = await this.resolveCandidates(request);
    if (candidates.length > 0) {
      return candidates[0];
    }

    throw new Error('No available OCR provider could be resolved.');
  }
}

export async function ocrImageWithRouter(
  request: OcrRequest,
  router: AdaptivePolicyRouter
): Promise<OcrResult> {
  const timeout = request.timeout_ms ?? 120000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('OCR timeout_ms must be positive');
  // Authorize before resolving any provider: a native denial must not fall
  // through the router into another process or an external OCR service.
  validateFileSize(resolveOcrImagePath(request.path), 512);
  request.signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    listener = () => {
      controller.abort();
      reject(new Error('OCR cancelled'));
    };
    request.signal?.addEventListener('abort', listener, { once: true });
    if (request.signal?.aborted) listener();
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`OCR deadline exceeded (${timeout}ms)`));
    }, timeout);
  });
  try {
    return await Promise.race([
      interrupted,
      executeOcrWithRouter({ ...request, signal: controller.signal }, router),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (listener) request.signal?.removeEventListener('abort', listener);
  }
}

async function executeOcrWithRouter(
  request: OcrRequest,
  router: AdaptivePolicyRouter
): Promise<OcrResult> {
  request.signal?.throwIfAborted();
  request.onProgress?.({ stage: 'resolving' });
  const candidates = await router.resolveCandidates(request);
  if (candidates.length === 0) {
    throw new Error('No available OCR provider could be resolved.');
  }

  let lastError: Error | null = null;
  for (const provider of candidates) {
    request.signal?.throwIfAborted();
    request.onProgress?.({ stage: 'recognizing', provider: provider.id });
    logger.info(`[ocr_bridge] Routing OCR request for ${request.path} to provider: ${provider.id}`);
    try {
      const result = await withEgressPayloadContext(
        {
          tier: request.tier || 'public',
          ...(request.tenant_slug ? { tenant_slug: request.tenant_slug } : {}),
          purpose: request.purpose || 'ocr',
        },
        () => provider.recognize(request)
      );
      if (result.status === 'succeeded') {
        request.signal?.throwIfAborted();
        request.onProgress?.({ stage: 'completed', provider: provider.id });
        // Stamp the served egress so callers can assert what actually happened
        // instead of trusting the mode they asked for.
        return {
          ...result,
          providerDataEgress: provider.dataEgress,
          dataPolicy: providerDataPolicy(provider),
          tier: request.tier || 'public',
        };
      }
      lastError = new Error(result.error || `${provider.id}_ocr_failed`);
      logger.warn(
        `[ocr_bridge] OCR provider ${provider.id} returned status=${result.status}; trying next provider if available.`
      );
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`[ocr_bridge] OCR provider ${provider.id} failed: ${lastError.message}`);
    }
  }

  throw lastError || new Error('No available OCR provider could be resolved.');
}
