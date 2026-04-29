import { describe, expect, it } from 'vitest';
import { buildNarratedVideoUploadPackage } from './narrated-video-upload-package.js';
import type { NarratedVideoPublishPlan } from './src/types/narrated-video-publish-plan.js';

const publishPlan: NarratedVideoPublishPlan = {
  kind: 'narrated-video-publish-plan',
  version: '1.0.0',
  target: 'youtube',
  title: 'Kyberionの使い方',
  description: 'Kyberionの基本的な頼み方を紹介します。',
  visibility: 'unlisted',
  approval_boundary: 'before_public_release',
  video_artifact_ref: 'active/shared/exports/kyberion-intro.mp4',
};

describe('narrated video upload package', () => {
  it('builds a staged upload package from the publish plan', () => {
    const pkg = buildNarratedVideoUploadPackage(
      publishPlan,
      'knowledge/public/schemas/narrated-video-publish-plan.example.json'
    );
    expect(pkg.kind).toBe('narrated-video-upload-package');
    expect(pkg.publish_plan_ref).toContain('narrated-video-publish-plan.example.json');
    expect(pkg.target_url).toBe('https://studio.youtube.com');
    expect(pkg.visibility).toBe('unlisted');
  });
});
