export interface NarratedVideoPreferenceProfile {
  kind: 'narrated-video-preference-profile';
  profile_id: string;
  brief_question_sets: Array<{
    label: string;
    video_purposes?: Array<
      'tutorial' | 'announcement' | 'product_demo' | 'marketing' | 'onboarding' | 'default'
    >;
    questions: string[];
    notes?: string;
  }>;
  theme_sets: Array<{
    label: string;
    video_purposes?: Array<
      'tutorial' | 'announcement' | 'product_demo' | 'marketing' | 'onboarding' | 'default'
    >;
    theme_hint: string;
    visual_traits?: string[];
    notes?: string;
  }>;
  publish_policy: {
    default_target: 'youtube' | 'draft_only';
    default_visibility: 'private' | 'unlisted' | 'public';
    require_human_approval_before_publish: boolean;
    allow_auto_upload?: boolean;
    require_thumbnail?: boolean;
    require_description?: boolean;
    require_tags?: boolean;
    require_caption?: boolean;
  };
  asset_policy?: {
    prefer_first_party_assets?: boolean;
    require_licensed_assets?: boolean;
    allow_generated_thumbnails?: boolean;
  };
}
