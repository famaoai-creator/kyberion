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
  isAvailable(): Promise<boolean>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
