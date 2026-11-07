/** Stable image facade: compose builtin providers and a revision-bound router. */
import type {
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from './image-generation-types.js';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { imageProviderDataEgress, hasReferenceImages } from './image-reference-consent.js';
import { AdaptivePolicyRouter } from './image-generation/router.js';
import {
  listImageGenerationProviders,
  imageGenerationProviderRevision,
} from './image-generation/provider-registry.js';
import { ensureBuiltinImageGenerationProviders } from './image-generation/builtin-providers.js';
let cachedRouter: { revision: number; router: AdaptivePolicyRouter } | undefined;
function getRouter(): AdaptivePolicyRouter {
  ensureBuiltinImageGenerationProviders();
  const revision = imageGenerationProviderRevision();
  if (!cachedRouter || cachedRouter.revision !== revision)
    cachedRouter = { revision, router: new AdaptivePolicyRouter(listImageGenerationProviders()) };
  return cachedRouter.router;
}
export { registerImageGenerationProvider } from './image-generation/provider-registry.js';
export { listImageGenerationProviders } from './image-generation/provider-registry.js';
export { resetImageGenerationProviders } from './image-generation/provider-registry.js';
export { isRateLimitOrQuotaError } from './image-generation/provider-support.js';
export { ComfyUiImageGenerationProvider } from './image-generation/providers/comfyui.js';
export { GeminiFastImageGenerationProvider } from './image-generation/providers/gemini.js';
export { GeminiServiceImageGenerationProvider } from './image-generation/providers/gemini.js';
export { defaultGeminiImageModel } from './image-generation/providers/gemini.js';
export { GEMINI_REFERENCE_MAX_EDGE_PX } from './image-generation/providers/gemini.js';
export { resolveGeminiImageModel } from './image-generation/providers/gemini.js';
export { prepareGeminiReferenceImage } from './image-generation/providers/gemini.js';
export { buildGeminiImageContents } from './image-generation/providers/gemini.js';
export { geminiContentImageBytes } from './image-generation/providers/gemini.js';
export { GeminiImageModelGenerationProvider } from './image-generation/providers/gemini.js';
export { LlmApiImageGenerationProvider } from './image-generation/providers/llm-api.js';
export { LocalDiffusionImageGenerationProvider } from './image-generation/providers/local-flux.js';
export { LocalFluxImageGenerationProvider } from './image-generation/providers/local-flux.js';
export { WindowsNativeImageGenerationProvider } from './image-generation/providers/native.js';
export { ApplePlaygroundImageGenerationProvider } from './image-generation/providers/native.js';
export { hostBridgeReferenceEntries } from './image-generation/providers/host-bridge.js';
export { HostAgentImageGenerationProvider } from './image-generation/providers/host-bridge.js';
export { CodexHostBridgeImageGenerationProvider } from './image-generation/providers/host-bridge.js';
export { AgyHostBridgeImageGenerationProvider } from './image-generation/providers/host-bridge.js';
export { CursorHostBridgeImageGenerationProvider } from './image-generation/providers/host-bridge.js';
/** The media backend registry id of an image provider, or undefined without a registry record. */
export function imageGenerationBackendIdForProvider(providerId: string): string | undefined {
  ensureBuiltinImageGenerationProviders();
  return listImageGenerationProviders().find((provider) => provider.id === providerId)
    ?.backendIds?.[0];
}

export { AdaptivePolicyRouter } from './image-generation/router.js';
/** A registered image provider by id (built-ins included), e.g. to run one provider in isolation. */
export function getImageGenerationProvider(id: string): ImageGenerationProvider | undefined {
  ensureBuiltinImageGenerationProviders();
  return listImageGenerationProviders().find((provider) => provider.id === id);
}

/**
 * Every registered image provider with whether it can run this request
 * unattended here and now (mode filters, availability, hand-off opt-in).
 */
export async function listImageGenerationCandidates(
  request: ImageGenerationRequest
): Promise<SeamProviderCandidate[]> {
  return await getRouter().listCandidates(request);
}

export interface ImageGenerationPlan {
  provider_id: string;
  display_name: string;
  data_egress: 'local' | 'cloud';
  /** A cloud provider with references needs a per-run user_photo consent. */
  requires_consent: boolean;
  /** Host bridges hand the request to the host agent and need a rerun. */
  interactive_handoff: boolean;
}

/** Which provider this request would use (consent not yet given), or null. */
export async function planImageGeneration(
  request: ImageGenerationRequest
): Promise<ImageGenerationPlan | null> {
  const provider = await getRouter().planProvider(request);
  if (!provider) return null;
  const egress = imageProviderDataEgress(provider);
  return {
    provider_id: provider.id,
    display_name: provider.displayName || provider.id,
    data_egress: egress,
    requires_consent: egress === 'cloud' && hasReferenceImages(request),
    interactive_handoff: provider.requiresInteractiveHandoff === true,
  };
}

export async function generateImage(
  request: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const router = getRouter();
  return await router.generateWithFallback(request);
}
