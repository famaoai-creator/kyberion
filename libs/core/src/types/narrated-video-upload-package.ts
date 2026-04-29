export interface NarratedVideoUploadPackage {
  kind: 'narrated-video-upload-package';
  version: string;
  publish_plan_ref: string;
  target_url: string;
  video_artifact_ref: string;
  thumbnail_ref?: string;
  caption_ref?: string;
  title?: string;
  description?: string;
  visibility: 'private' | 'unlisted' | 'public';
  approval_boundary: 'before_upload' | 'before_public_release';
  checklist: string[];
  tags?: string[];
  scheduled_publish_at?: string;
  notes?: string;
}
