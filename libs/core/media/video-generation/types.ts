/** Public contracts and seam keys for direct-API video generation. */
export const VIDEO_GENERATION_PROVIDER_SEAM = 'video-generation-provider';
export const VIDEO_GENERATION_ADAPTER_SEAM = 'video-generation-provider-adapter';

export type VideoProviderStatus = 'submitted' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface VideoGenerationRequest {
  prompt: string;
  model: string;
  duration_seconds?: number;
  resolution?: string;
  aspect_ratio?: string;
  first_frame_image?: string;
  last_frame_image?: string;
  reference_images?: string[];
  input_video?: string;
  generate_audio?: boolean;
  target_path?: string;
  egress_tier?: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
}

export interface VideoGenerationSubmission {
  provider_job_id: string;
  status: VideoProviderStatus;
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationStatus {
  provider_job_id: string;
  status: VideoProviderStatus;
  provider: string;
  output_url?: string;
  file_id?: string;
  inline_video_base64?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationArtifact {
  kind: 'video';
  filename: string;
  type: 'output';
  path: string;
}

export interface VideoGenerationProvider {
  readonly provider: string;
  submit(request: VideoGenerationRequest): Promise<VideoGenerationSubmission>;
  status(providerJobId: string, request?: VideoGenerationRequest): Promise<VideoGenerationStatus>;
  download(status: VideoGenerationStatus, request?: VideoGenerationRequest): Promise<Buffer>;
  cancel?(providerJobId: string): Promise<void>;
}

/** What the adapter actually sends to its API; used for request eligibility. */
export interface DirectVideoFeatures {
  /** How a first / last frame can be passed: any URI, only a data: URI, or not at all. */
  first_frame_image: 'any' | 'data_uri' | false;
  last_frame_image: 'any' | 'data_uri' | false;
  /** Aspect ratios the adapter sends; false = it sends resolution (size) only. */
  aspect_ratios: readonly string[] | false;
  /** Set when the adapter cannot run without a first frame. */
  requires_first_frame?: string;
}

export interface DirectVideoProviderAdapter {
  create: () => VideoGenerationProvider;
  features: DirectVideoFeatures;
}

export type JsonRecord = Record<string, unknown>;

export type VideoGenerationParams = JsonRecord & {
  video_adf?: {
    prompt?: unknown;
    engine?: { backend_id?: unknown };
    output?: { duration_seconds?: unknown };
  };
  egress_tier?: VideoGenerationRequest['egress_tier'];
};
