import type { NarratedVideoPublishPlan } from './src/types/narrated-video-publish-plan.js';
import type { NarratedVideoUploadPackage } from './src/types/narrated-video-upload-package.js';

export function buildNarratedVideoUploadPackage(
  publishPlan: NarratedVideoPublishPlan,
  publishPlanRef: string = 'narrated-video-publish-plan'
): NarratedVideoUploadPackage {
  return {
    kind: 'narrated-video-upload-package',
    version: '1.0.0',
    publish_plan_ref: publishPlanRef,
    target_url: 'https://studio.youtube.com',
    video_artifact_ref: publishPlan.video_artifact_ref,
    thumbnail_ref: publishPlan.thumbnail_ref,
    caption_ref: publishPlan.caption_ref,
    title: publishPlan.title,
    description: publishPlan.description,
    visibility: publishPlan.visibility,
    approval_boundary: publishPlan.approval_boundary,
    checklist: [
      'Open YouTube Studio upload page',
      'Select the rendered video artifact',
      'Attach thumbnail and captions',
      'Confirm title, description, and tags',
      'Stop before public release unless approval is granted',
    ],
    tags: publishPlan.tags,
    scheduled_publish_at: publishPlan.scheduled_publish_at,
    notes: publishPlan.notes,
  };
}
