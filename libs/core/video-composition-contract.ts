export type VideoCompositionSceneRole = 'hook' | 'feature' | 'proof' | 'cta' | 'outro' | 'generic';
export type VideoCompositionOutputFormat = 'mp4' | 'mov' | 'webm';
export type VideoTemplateStatus = 'active' | 'shadow' | 'disabled';
export type VideoRenderBackend = 'none' | 'hyperframes_cli';
export type VideoRenderJobStatus =
  | 'queued'
  | 'validating_contract'
  | 'resolving_templates'
  | 'staging_assets'
  | 'assembling_bundle'
  | 'rendering'
  | 'encoding'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VideoCompositionADF {
  kind: 'video-composition-adf';
  version: string;
  intent?: string;
  title?: string;
  composition: {
    duration_sec: number;
    fps: number;
    width: number;
    height: number;
    background_color?: string;
    aspect_ratio?: string;
  };
  audio?: {
    narration_ref?: string;
    music_ref?: string;
    captions_ref?: string;
  };
  scenes: VideoCompositionScene[];
  output: {
    format: VideoCompositionOutputFormat;
    target_path?: string;
    bundle_dir?: string;
    emit_progress_packets?: boolean;
    await_completion?: boolean;
  };
}

export interface VideoCompositionScene {
  scene_id: string;
  role?: VideoCompositionSceneRole;
  start_sec: number;
  duration_sec: number;
  template_ref: {
    template_id: string;
    variant_id?: string;
  };
  content: Record<string, unknown>;
  asset_refs?: VideoCompositionAssetRef[];
  transition?: {
    enter?: string;
    exit?: string;
  };
}

export interface VideoCompositionAssetRef {
  asset_id: string;
  path: string;
  role?: 'background' | 'hero' | 'logo' | 'overlay' | 'supporting';
}

export interface VideoCompositionTemplateRecord {
  template_id: string;
  display_name: string;
  status: VideoTemplateStatus;
  renderer: 'builtin_html';
  supported_roles: VideoCompositionSceneRole[];
  required_content_fields: string[];
  supported_output_formats: VideoCompositionOutputFormat[];
  notes?: string;
}

export interface VideoCompositionTemplateRegistry {
  version: string;
  default_template_id: string;
  templates: VideoCompositionTemplateRecord[];
}

export interface VideoRenderRuntimePolicy {
  version: string;
  queue: {
    concurrency: number;
    cancellation: 'queued_only' | 'queued_or_running';
  };
  progress: {
    throttle_ms: number;
    min_percent_delta: number;
    emit_heartbeat: boolean;
  };
  bundle: {
    default_bundle_root: string;
    copy_declared_assets: boolean;
  };
  render: {
    allowed_output_formats: VideoCompositionOutputFormat[];
    enable_backend_rendering: boolean;
    backend: VideoRenderBackend;
    quality: 'draft' | 'standard' | 'high';
    command_timeout_ms: number;
  };
}

export interface VideoRenderProgressPacket {
  kind: 'video_render_progress_packet';
  job_id: string;
  status: VideoRenderJobStatus;
  progress: {
    current: number;
    total: number;
    percent: number;
    unit: 'steps' | 'scenes' | 'artifacts' | 'percent';
  };
  message?: string;
  artifact_refs?: string[];
  queue?: {
    position: number;
    queued_ahead: number;
    queued_total: number;
    running: number;
    concurrency: number;
  };
  updated_at: string;
}

export interface CompiledVideoCompositionScene {
  scene_id: string;
  role: VideoCompositionSceneRole;
  start_sec: number;
  duration_sec: number;
  template_id: string;
  template_display_name: string;
  output_html: string;
  required_content_fields: string[];
  content: Record<string, unknown>;
  asset_refs: VideoCompositionAssetRef[];
}

export interface VideoCompositionRenderPlan {
  kind: 'video-composition-render-plan';
  version: string;
  composition_id: string;
  source_kind: 'video-composition-adf';
  title: string;
  narration_ref?: string;
  duration_sec: number;
  fps: number;
  width: number;
  height: number;
  background_color: string;
  output_format: VideoCompositionOutputFormat;
  output_target_path?: string;
  bundle_dir: string;
  index_html: string;
  scenes: CompiledVideoCompositionScene[];
  artifact_refs: string[];
}
