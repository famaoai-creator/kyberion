import { describe, expect, it } from 'vitest';
import {
  getNarratedVideoBriefQuestions,
  getNarratedVideoPublishPolicy,
  getNarratedVideoThemeHint,
} from './narrated-video-preference-profile.js';
import type { NarratedVideoPreferenceProfile } from './src/types/narrated-video-preference-profile.js';

const profile: NarratedVideoPreferenceProfile = {
  kind: 'narrated-video-preference-profile',
  profile_id: 'kyberion-youtube-default',
  brief_question_sets: [
    {
      label: 'Tutorial',
      video_purposes: ['tutorial', 'onboarding', 'default'],
      questions: ['Who is it for?', 'What should they learn?'],
    },
    {
      label: 'Marketing',
      video_purposes: ['marketing', 'announcement'],
      questions: ['What is the promise?', 'What is the CTA?'],
    },
  ],
  theme_sets: [
    {
      label: 'Tutorial clean',
      video_purposes: ['tutorial', 'onboarding', 'default'],
      theme_hint: 'tutorial_clean',
    },
    {
      label: 'Marketing launch',
      video_purposes: ['marketing', 'announcement'],
      theme_hint: 'marketing_launch',
    },
  ],
  publish_policy: {
    default_target: 'youtube',
    default_visibility: 'unlisted',
    require_human_approval_before_publish: true,
    allow_auto_upload: false,
    require_thumbnail: true,
    require_description: true,
    require_tags: false,
    require_caption: true,
  },
};

describe('narrated video preference profile', () => {
  it('selects brief questions and theme hints by purpose', () => {
    expect(getNarratedVideoBriefQuestions(profile, 'tutorial')).toEqual([
      'Who is it for?',
      'What should they learn?',
    ]);
    expect(getNarratedVideoThemeHint(profile, 'marketing')).toBe('marketing_launch');
  });

  it('returns the publish policy', () => {
    expect(getNarratedVideoPublishPolicy(profile)).toEqual(profile.publish_policy);
  });
});
