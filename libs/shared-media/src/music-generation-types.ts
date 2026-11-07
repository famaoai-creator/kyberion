export interface MusicGenerationRequest {
  prompt: string;
  durationSec?: number;
  model?: string;
  seed?: string;
  providerPreference?: string[];
  /**
   * Purpose-driven provider choice (seam `music-generation-provider`, e.g.
   * `quality`, `speed`). Only used when no providerPreference is given.
   */
  purpose?: string;
  /**
   * Requested output format. Without an explicit provider it is a hard
   * requirement (providers declare `outputFormats`); with one it is ignored
   * and the provider writes its own format, as before.
   */
  format?: string;
  /**
   * Vocal (sung/lyrics) request. Providers that cannot synthesize vocals
   * declare `supportsVocals !== true` and are excluded from selection when
   * this is true. Lyrics text goes in `lyrics`.
   */
  vocals?: boolean;
  /** Lyrics for vocal requests (used by vocal-capable providers). */
  lyrics?: string;
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
  /** Formats the provider writes (e.g. ['wav']); undefined = not declared. */
  readonly outputFormats?: readonly string[];
  /**
   * Whether the provider can synthesize vocals (sung voice). Providers that
   * only render instrumental audio leave this unset/false and are excluded
   * from selection when the request asks for vocals.
   */
  readonly supportsVocals?: boolean;
  /** Longest clip the provider generates; longer requests are clamped when it is named explicitly. */
  maxDurationSec?(): number;
  isAvailable(): Promise<boolean>;
  generate(request: MusicGenerationRequest): Promise<MusicGenerationResult>;
}
