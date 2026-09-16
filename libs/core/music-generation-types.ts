export interface MusicGenerationRequest {
  prompt: string;
  durationSec?: number;
  model?: string;
  seed?: string;
  providerPreference?: string[];
  outputDir?: string;
  targetPath?: string;
}

export interface MusicGenerationResult {
  status: 'succeeded' | 'failed' | 'submitted';
  path?: string;
  provider: string;
  elapsedMs: number;
  error?: string;
}

export interface MusicGenerationProvider {
  readonly id: string;
  readonly costTier?: 'free' | 'paid' | 'self_hosted' | 'environment';
  readonly dataPolicy?: 'training_eligible' | 'zero_retention' | 'local_only';
  readonly executionLocality?: 'local' | 'remote' | 'hybrid';
  isAvailable(): Promise<boolean>;
  generate(request: MusicGenerationRequest): Promise<MusicGenerationResult>;
}
