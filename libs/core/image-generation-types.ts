export type ImageGenerationMode = 'fast' | 'artistic' | 'balanced' | 'local_only' | 'privacy_first';

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
  isAvailable(): Promise<boolean>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
