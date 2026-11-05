import { logger } from '../core.js';
import { validateFileSize } from '../secure-io.js';
import { OcrRequest, OcrResult, OcrProvider, OcrDataEgress, OcrRoutingMode } from '../ocr-types.js';
import { ProviderChainRouter } from '../provider-chain-router.js';
import { type SeamProviderCandidate } from '../seam-provider-selection.js';
import { withEgressPayloadContext } from '../egress-policy.js';
import { providerDataPolicy, resolveOcrImagePath } from './provider-support.js';
import { OCR_PROVIDER_SEAM } from './provider-registry.js';

/**
 * Hermetic fallback for `default_chains` in the ocr-provider selection
 * policy — used only when the policy directory is unavailable (isolated
 * unit-test environments). The policy file is the source of truth.
 */
const OCR_BUILTIN_DEFAULT_CHAINS: Record<string, readonly string[]> = {
  accurate: ['windows_native', 'llm_api', 'local_vlm', 'apple_vision', 'tesseract'],
  privacy_first: ['windows_native', 'local_vlm', 'apple_vision', 'tesseract'],
  local_only: ['windows_native', 'apple_vision', 'tesseract'],
  balanced: ['windows_native', 'apple_vision', 'llm_api', 'tesseract'],
};

/** Explicitly public material may be used for training; otherwise local_only. */
export function ocrTrainingUse(request: Pick<OcrRequest, 'tier' | 'training_use'>) {
  return request.training_use || (request.tier === 'public' ? 'training_eligible' : 'local_only');
}

export class AdaptivePolicyRouter extends ProviderChainRouter<OcrProvider, OcrRequest> {
  constructor(providers: OcrProvider[]) {
    super(providers, {
      seam: OCR_PROVIDER_SEAM,
      label: '[ocr_bridge]',
      errorTag: '[OCR_PROVIDER_SELECTION]',
      eligibility: (request) => this.eligibleCandidates(request),
      explicitPreference: (request) => request.providerPreference,
      purpose: (request) => request.purpose,
      context: (request) => (request.language ? { language: request.language } : undefined),
      defaultOrderKey: (request) => `mode:${request.mode || 'balanced'}`,
      builtinDefaultOrder: (request) =>
        OCR_BUILTIN_DEFAULT_CHAINS[request.mode || 'balanced'] ??
        OCR_BUILTIN_DEFAULT_CHAINS.balanced,
    });
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
    switch (ocrTrainingUse(request)) {
      case 'training_eligible':
        return new Set(['local_only', 'zero_retention', 'training_eligible']);
      case 'zero_retention':
        return new Set(['local_only', 'zero_retention']);
      default:
        return new Set(['local_only']);
    }
  }

  /**
   * Hard-eligible providers for `request.mode`: allowed by the egress filter
   * and available right now. This is the same eligibility test the chain
   * router applies to every candidate; purpose-driven selection reuses it
   * instead of a second notion of "can run this task". Public so the
   * 'ocr-provider' seam calibration adapter
   * (scripts/lib/seam-calibration/ocr-provider.ts) can reuse it instead of
   * re-deriving eligibility.
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
            `dataPolicy '${dataPolicy}' not permitted by training_use '${ocrTrainingUse(request)}'`,
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
   * Providers to try, in order. Explicit provider chains retain their order;
   * purpose/rule-driven requests use the governed seam selection; the rest
   * follow the mode's `default_chains` entry in the seam selection policy.
   */
  async resolveCandidates(request: OcrRequest): Promise<OcrProvider[]> {
    return this.resolveProviderChain(request);
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
