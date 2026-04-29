export interface NarratedVideoPublishPlan {
  kind: 'narrated-video-publish-plan';
  version: string;
  target: 'youtube' | 'draft_only';
  title: string;
  description?: string;
  visibility: 'private' | 'unlisted' | 'public';
  approval_boundary: 'before_upload' | 'before_public_release';
  video_artifact_ref: string;
  thumbnail_ref?: string;
  caption_ref?: string;
  tags?: string[];
  scheduled_publish_at?: string;
  notes?: string;
}
