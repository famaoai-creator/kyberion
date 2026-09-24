export type ImageGenerationMode = 'fast' | 'artistic' | 'balanced' | 'local_only' | 'privacy_first';

/**
 * A reference image the provider must condition on (PA-10). `subject` = the
 * person / object to depict (e.g. the user's photo), `style` = look to copy,
 * `consistency` = an earlier generated frame the new one must stay coherent
 * with (e.g. the neutral expression when generating joy).
 */
export interface ImageReference {
  /** Absolute or repo-relative path inside the repository. */
  path: string;
  mimeType: string;
  role?: 'subject' | 'style' | 'consistency';
}

/** Where a provider sends request data: stays on this machine, or leaves it. */
export type ImageDataEgress = 'local' | 'cloud';

/**
 * Per-run consent to send a user photo to one named cloud provider (PA-10).
 * Required by the router and by every cloud provider for any request that
 * carries reference images; it is valid only for `provider_id`, and only for a
 * bounded time after `granted_at` (see image-reference-consent.ts).
 */
export interface ImageEgressConsent {
  subject: 'user_photo';
  provider_id: string;
  provider_class: 'cloud';
  granted_at: string;
  granted_by: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  width?: number;
  height?: number;
  aspectRatio?: string; // '1:1', '16:9', '3:2', etc.
  /** Native backend style identifier, such as an Image Playground style. */
  style?: string;
  mode?: ImageGenerationMode;
  providerPreference?: string[];
  /**
   * Purpose-driven provider choice (seam `image-generation-provider`, e.g.
   * `quality`, `speed`, `privacy`, `cost`). Only used when no
   * providerPreference is given; the mode's hard filters (local_only,
   * privacy_first) still apply, its soft ordering is replaced by the ranking.
   */
  purpose?: string;
  /**
   * Allow providers that hand the request to a host agent and ask for a
   * rerun (requiresInteractiveHandoff). Only consulted with a purpose;
   * default false, so purpose-selected runs stay unattended.
   */
  allowHostHandoff?: boolean;
  outputDir?: string;
  targetPath?: string;
  awaitCompletion?: boolean;
  /**
   * Images the output must be conditioned on. Only providers with
   * `supportsReferenceImages` are eligible when present; cloud providers
   * additionally need a valid `egressConsent` naming them.
   */
  referenceImages?: ImageReference[];
  /** Explicit per-run consent for sending reference images to a cloud provider. */
  egressConsent?: ImageEgressConsent;
}

export interface ImageGenerationResult {
  status: 'succeeded' | 'failed' | 'submitted';
  path?: string; // Saved path for the generated image
  provider: string; // E.g., 'comfyui', 'gemini_imagen', 'dalle_3'
  elapsedMs: number;
  promptId?: string; // Async prompt ID if submitted but not awaited
  error?: string;
}

export interface ImageGenerationProvider {
  readonly id: string;
  readonly costTier?: 'free' | 'paid' | 'self_hosted' | 'environment';
  readonly dataPolicy?: 'training_eligible' | 'zero_retention' | 'local_only';
  readonly executionLocality?: 'local' | 'remote' | 'hybrid';
  /** Needs a person/host agent to act and a rerun; cannot finish unattended. */
  readonly requiresInteractiveHandoff?: boolean;
  /** Can condition generation on `referenceImages` (img2img / multimodal input). */
  readonly supportsReferenceImages?: boolean;
  /**
   * Where request data (incl. reference images) goes. Defaults from
   * executionLocality: `local` → local, anything else → cloud. Host bridges
   * are cloud: the host agent forwards the request to its own model.
   */
  readonly dataEgress?: ImageDataEgress;
  /** Human-readable provider name shown in consent prompts. */
  readonly displayName?: string;
  isAvailable(): Promise<boolean>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
