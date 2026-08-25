import {
  createNextActionContract,
  createOutcomeContract,
  createTaskSession,
  resolveIntentResolutionContract,
} from '@agent/core';
import { readGovernanceJson, type ContractCheck } from './check_contract_schemas_shared.js';
import { createServiceChecks } from './check_contract_schemas_service_checks.js';

export function createContractSchemaChecksPart3(): ContractCheck[] {
  return [
    {
      id: 'proposal-storyline-adf',
      schemaPath: 'knowledge/product/schemas/proposal-storyline-adf.schema.json',
      validPayloads: [
        {
          kind: 'proposal-storyline-adf',
          title: 'Digital Onboarding Transformation Proposal',
          client: 'Aster Bank',
          core_message: 'A lighter, guided onboarding experience reduces drop-off.',
          slides: [
            {
              id: 'why-change',
              title: 'Why change now',
              objective: 'Explain the business case',
              body: ['Current onboarding creates avoidable abandonment.'],
            },
            {
              id: 'decision',
              title: 'Decision',
              objective: 'Invite approval',
              visual: 'decision-cta',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'proposal-storyline-adf',
          client: 'Aster Bank',
          slides: [],
        },
      ],
    },
    {
      id: 'webview-session-handoff',
      schemaPath: 'knowledge/product/schemas/webview-session-handoff.schema.json',
      validPayloads: [
        {
          kind: 'webview-session-handoff',
          target_url: 'http://127.0.0.1:4173/app/home',
          origin: 'app://com.example.mobile',
          browser_session_id: 'session-1',
          prefer_persistent_context: true,
          source: {
            platform: 'android',
            app_id: 'example-mobile-login-passkey',
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'webview-session-handoff',
          target_url: '',
          source: {
            platform: 'desktop',
          },
        },
      ],
    },
    {
      id: 'mobile-app-profile',
      schemaPath: 'knowledge/product/schemas/mobile-app-profile.schema.json',
      validPayloads: [
        {
          app_id: 'example-mobile-login-passkey',
          platform: 'android',
          title: 'Example Mobile Login + Passkey',
          package_name: 'com.example.mobile',
          launch: {
            component: 'com.example.mobile/.MainActivity',
          },
          selectors: {
            login: {
              email: {
                resource_id: 'email',
                class_name: 'EditText',
              },
              password: {
                resource_id: 'password',
                class_name: 'EditText',
              },
              submit: {
                text: 'sign in',
                resource_id: 'sign_in',
                class_name: 'Button',
              },
            },
            passkey: {
              trigger: {
                text: 'passkey',
                resource_id: 'passkey',
                class_name: 'Button',
              },
            },
          },
          webview: {
            entry_url: 'https://example.mobile.app/webview/login',
            allowed_origins: ['https://example.mobile.app'],
            session_handoff: {
              target_url: 'https://example.mobile.app/webview/login',
              browser_session_id: 'android-webview-example',
              prefer_persistent_context: true,
            },
            runtime_export: {
              format: 'json',
              android_device_path: '/sdcard/kyberion/example-mobile-webview-session.json',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          app_id: '',
          platform: 'android',
          package_name: '',
          selectors: {
            login: {
              email: {},
            },
          },
        },
      ],
    },
    {
      id: 'web-app-profile',
      schemaPath: 'knowledge/product/schemas/web-app-profile.schema.json',
      validPayloads: [
        {
          app_id: 'example-web-login-guarded',
          title: 'Example Web Login + Guarded Routes',
          base_url: 'http://127.0.0.1:4173',
          execution_preset: 'standard-web-auth',
          login_route: '/login',
          logout_route: '/logout',
          guarded_routes: ['/app/home', '/app/settings'],
          selectors: {
            login: {
              email: "[data-testid='email']",
              password: "[data-testid='password']",
              submit: "[data-testid='sign-in']",
            },
            navigation: {
              home: "[data-testid='nav-home']",
              settings: "[data-testid='nav-settings']",
              logout: "[data-testid='nav-logout']",
            },
          },
          session_handoff: {
            kind: 'webview-session-handoff',
            target_url: 'http://127.0.0.1:4173/app/home',
            origin: 'http://127.0.0.1:4173',
            browser_session_id: 'example-web-login-guarded',
            prefer_persistent_context: true,
          },
          debug_routes: {
            session_export: '/__kyberion/session-export',
          },
        },
      ],
      invalidPayloads: [
        {
          app_id: '',
          title: '',
          base_url: '',
          guarded_routes: ['/app/home', 1],
          debug_routes: {
            session_export: '',
          },
        },
      ],
    },
    {
      id: 'ui-flow-adf',
      schemaPath: 'knowledge/product/schemas/ui-flow-adf.schema.json',
      validPayloads: [
        {
          kind: 'ui-flow-adf',
          app_id: 'sample-web-app',
          platform: 'browser',
          entry_state: 'login',
          states: [
            {
              id: 'login',
              kind: 'route',
              path: '/login',
              selectors: {
                email: '[name=email]',
                password: '[name=password]',
                submit: 'button[type=submit]',
              },
            },
            {
              id: 'dashboard',
              kind: 'route',
              path: '/dashboard',
              guard: 'authenticated',
            },
            {
              id: 'session_export',
              kind: 'debug',
              path: '/__kyberion/session-export',
              guard: 'debug_only',
            },
          ],
          transitions: [
            {
              id: 'login_success',
              from: 'login',
              to: 'dashboard',
              action: 'submit_login',
              expected: 'authenticated route is reachable',
            },
            {
              id: 'session_export_transition',
              from: 'dashboard',
              to: 'session_export',
              action: 'open_debug_session_export',
              guard: 'debug_only',
              expected: 'session handoff artifact is returned',
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          kind: 'ui-flow-adf',
          app_id: 'sample-web-app',
          platform: 'desktop',
          states: [
            {
              id: 'login',
              kind: 'route',
              path: '/login',
            },
          ],
          transitions: [],
        },
      ],
    },
    {
      id: 'mission-seed-record',
      schemaPath: 'knowledge/product/schemas/mission-seed-record.schema.json',
      validPayloads: [
        {
          seed_id: 'MSD-schema-1',
          project_id: 'PRJ-schema-1',
          title: 'Design architecture',
          summary: 'Design the first architecture slice.',
          status: 'ready',
          specialist_id: 'document-specialist',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
      invalidPayloads: [
        {
          seed_id: 'MSD-invalid-1',
          title: 'Missing project id',
          summary: 'This should fail',
          status: 'ready',
          specialist_id: 'document-specialist',
          created_at: new Date('2026-04-26T00:00:00.000Z').toISOString(),
        },
      ],
    },
    {
      id: 'booking-preference-profile',
      schemaPath: 'knowledge/product/schemas/booking-preference-profile.schema.json',
      validPayloads: [
        {
          kind: 'booking-preference-profile',
          profile_id: 'travel-points-routing-example',
          scope: 'personal_travel',
          security_boundaries: {
            forbid_inline_secrets: true,
            approval_required_for: [
              'credential_use',
              'points_portal_redirect',
              'booking_confirmation',
              'payment_execution',
            ],
          },
          preferred_booking_sites: [
            {
              site: 'rakuten_travel',
              priority: 1,
              categories: ['hotel', 'package'],
              reason:
                'Use Rakuten Travel for travel booking while preserving points-portal routing evidence.',
            },
          ],
          login_methods: [
            {
              site: 'rakuten_travel',
              preferred_method: 'rakuten_id',
              credential_ref: 'browser://profile/rakuten-travel',
              approval_required: true,
            },
          ],
          payment_policy: {
            prefer: ['points_earning', 'free_cancellation', 'onsite_payment'],
            allow_prepaid: true,
            payment_method_refs: ['secret://wallet/main-card'],
            require_confirmation_if: [
              'nonrefundable',
              'total_amount_over_budget',
              'points_terms_unclear',
              'payment_execution',
            ],
          },
          site_selection_policy: {
            decision_mode: 'ask_when_uncertain',
            compare_dimensions: [
              'price',
              'points',
              'coupon',
              'login_friction',
              'cancellation',
              'familiarity',
              'privacy',
            ],
            ask_user_when: [
              'sale_possible',
              'price_gap_unclear',
              'points_advantage_unclear',
              'multiple_top_candidates',
              'login_friction_tradeoff',
              'new_service_category',
              'user_requested_precheck',
            ],
            max_questions_per_turn: 2,
            preflight_question_sets: [
              {
                label: 'Restaurant preflight',
                categories: ['restaurant'],
                questions: ['人数と希望時間はいつですか?', '苦手食材や個室の要否はありますか?'],
              },
            ],
            favorite_site_groups: [
              {
                label: 'Travel default',
                categories: ['hotel', 'package'],
                preferred_sites: ['rakuten_travel', 'jalan', 'booking_com'],
                backup_sites: ['official_site'],
                notes:
                  'Check sales and points first, then ask before switching away from the usual favorites.',
              },
              {
                label: 'Restaurant default',
                categories: ['restaurant'],
                preferred_sites: ['tabelog', 'yoyaku', 'gurunavi'],
                backup_sites: ['official_site'],
                notes:
                  'Prefer the lowest-friction reservation path unless a campaign changes the decision.',
              },
              {
                label: 'Shopping default',
                categories: ['shopping'],
                preferred_sites: ['official_site', 'rakuten', 'amazon'],
                backup_sites: ['kakaku', 'yodobashi'],
                notes:
                  'Prefer official campaigns or familiar shopping portals unless the sale gap is material.',
              },
              {
                label: 'Medical scheduling default',
                categories: ['medical'],
                preferred_sites: ['official_site', 'clinic_portal', 'line'],
                backup_sites: ['phone', 'web_form'],
                notes:
                  'Use the most privacy-preserving appointment path and ask before sharing any sensitive details.',
              },
              {
                label: 'Subscription default',
                categories: ['subscription'],
                preferred_sites: ['official_site', 'app_store', 'member_portal'],
                backup_sites: ['phone', 'support_chat'],
                notes:
                  'Prefer the official account center and ask before cancellation, downgrade, or payment changes.',
              },
              {
                label: 'Home service default',
                categories: ['home_service'],
                preferred_sites: ['official_site', 'local_booking', 'support_chat'],
                backup_sites: ['phone', 'web_form'],
                notes:
                  'Use the clearest scheduling path and compare availability, estimate terms, and access constraints.',
              },
              {
                label: 'Family scheduling default',
                categories: ['family'],
                preferred_sites: ['official_site', 'calendar_app', 'support_chat'],
                backup_sites: ['phone', 'web_form'],
                notes:
                  'Use the simplest scheduling path when coordinating family timing, pickups, or school deadlines.',
              },
              {
                label: 'Gifts default',
                categories: ['gifts'],
                preferred_sites: ['official_site', 'marketplace', 'local_shop'],
                backup_sites: ['phone', 'chat'],
                notes:
                  'Compare delivery date, wrapping, and message-card options before switching away from the normal favorites.',
              },
            ],
            sale_signal_policy: {
              check_sales_before_decision: true,
              recheck_if_material: true,
              material_threshold: '10%',
              preferred_sale_sources: ['official_site', 'points_portal', 'site_campaign_page'],
            },
          },
          points_portal_policy: {
            enabled: true,
            preferred_portals: [
              {
                portal: 'moppy',
                priority: 1,
              },
            ],
            routing_rules: [
              {
                merchant: 'rakuten_travel',
                use_points_portal: true,
                clickout_usecase_ref:
                  'knowledge/product/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json',
                preferred_execution_mode: 'simulation',
              },
            ],
            require_confirmation_if: [
              'reward_rate_unknown',
              'tracking_cookie_blocked',
              'terms_changed',
              'coupon_conflict',
              'app_transition_required',
              'payment_execution',
            ],
            evidence_required: [
              'portal_name',
              'merchant_page',
              'reward_rate',
              'terms_snapshot',
              'timestamp',
              'final_booking_site',
              'clickout_confirmation',
              'tracking_warning',
            ],
            fallback_rule: 'manual_review',
          },
        },
      ],
      invalidPayloads: [
        {
          kind: 'booking-preference-profile',
          profile_id: 'travel-points-routing-example',
          preferred_booking_sites: [],
          payment_policy: {
            prefer: ['free_cancellation'],
            allow_prepaid: true,
            require_confirmation_if: ['payment_execution'],
          },
        },
      ],
    },
    {
      id: 'presentation-preference-profile',
      schemaPath: 'knowledge/product/schemas/presentation-preference-profile.schema.json',
      validPayloads: [
        readGovernanceJson(
          'knowledge/product/schemas/presentation-preference-profile.example.json'
        ),
      ],
      invalidPayloads: [
        {
          kind: 'presentation-preference-profile',
          profile_id: 'business-deck-default',
          brief_question_sets: [],
          theme_sets: [],
        },
      ],
    },
    {
      id: 'narrated-video-preference-profile',
      schemaPath: 'knowledge/product/schemas/narrated-video-preference-profile.schema.json',
      validPayloads: [
        readGovernanceJson(
          'knowledge/product/schemas/narrated-video-preference-profile.example.json'
        ),
      ],
      invalidPayloads: [
        {
          kind: 'narrated-video-preference-profile',
          profile_id: 'video-default',
          brief_question_sets: [],
          theme_sets: [],
          publish_policy: {
            default_target: 'youtube',
            default_visibility: 'unlisted',
            require_human_approval_before_publish: true,
          },
        },
      ],
    },
    {
      id: 'narrated-video-publish-plan',
      schemaPath: 'knowledge/product/schemas/narrated-video-publish-plan.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/schemas/narrated-video-publish-plan.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'narrated-video-publish-plan',
          version: '1.0.0',
          target: 'youtube',
          title: '',
          visibility: 'unlisted',
          approval_boundary: 'before_public_release',
          video_artifact_ref: '',
        },
      ],
    },
    {
      id: 'narrated-video-upload-package',
      schemaPath: 'knowledge/product/schemas/narrated-video-upload-package.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/schemas/narrated-video-upload-package.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'narrated-video-upload-package',
          version: '1.0.0',
          publish_plan_ref: '',
          target_url: 'https://studio.youtube.com',
          video_artifact_ref: '',
          visibility: 'unlisted',
          approval_boundary: 'before_public_release',
          checklist: [],
        },
      ],
    },
    {
      id: 'meeting-operations-profile',
      schemaPath: 'knowledge/product/schemas/meeting-operations-profile.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/schemas/meeting-operations-profile.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'meeting-operations-profile',
          profile_id: 'meeting-default',
          brief_question_sets: [],
          role_sets: [],
          facilitation_policy: {
            ask_before_join: true,
            ask_before_speaking: true,
            ask_before_shared_decision: true,
          },
          tracking_policy: {
            default_follow_up_channel: 'task_session',
            default_tracking_cadence: 'daily',
          },
          exit_policy: {
            stop_after_agenda_complete: true,
            stop_on_missing_authority: true,
          },
        },
      ],
    },
    {
      id: 'meeting-environment-policy',
      schemaPath: 'knowledge/product/schemas/meeting-environment-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/schemas/meeting-environment-policy.example.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          transport_modes: {
            speaking_allowed: 'realtime_voice',
            speaking_blocked: 'transcribe_first',
          },
          base_items: [],
          speaking: {
            explicit_patterns: [],
            allowed_items: [],
            blocked_items: [],
          },
          camera: {
            explicit_patterns: [],
            recommended_roles: [],
            recommended_purposes: [],
            required_item: {
              kind: 'camera',
              state: 'required',
              reason: 'x',
            },
            recommended_item: {
              kind: 'camera',
              state: 'recommended',
              reason: 'x',
            },
            not_needed_item: {
              kind: 'camera',
              state: 'not_needed',
              reason: 'x',
            },
          },
          screen_share: {
            explicit_patterns: [],
            recommended_roles: [],
            recommended_purposes: [],
            required_item: {
              kind: 'screen_share',
              state: 'required',
              reason: 'x',
            },
            recommended_item: {
              kind: 'screen_share',
              state: 'recommended',
              reason: 'x',
            },
            not_needed_item: {
              kind: 'screen_share',
              state: 'not_needed',
              reason: 'x',
            },
          },
          questions: {
            camera_recommended: 'x',
            screen_share_recommended: 'x',
            speaking_blocked: 'x',
          },
        },
      ],
    },
    {
      id: 'meeting-operations-brief',
      schemaPath: 'knowledge/product/schemas/meeting-operations-brief.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/schemas/meeting-operations-brief.example.json'),
      ],
      invalidPayloads: [
        {
          kind: 'meeting-operations-brief',
          version: '1.0.0',
          intent: 'meeting_operations',
          meeting_title: '',
          meeting_url: '',
          platform: 'teams',
          purpose: 'planning',
          primary_role: 'facilitator',
          desired_outcomes: [],
          exit_conditions: [],
        },
      ],
    },
    {
      id: 'mobile-app-profile-index',
      schemaPath: 'knowledge/product/schemas/mobile-app-profile-index.schema.json',
      validPayloads: [
        {
          version: '1.0.0',
          profiles: [
            {
              id: 'example-mobile-login-passkey',
              platform: 'android',
              title: 'Example Mobile Login + Passkey',
              path: 'knowledge/product/orchestration/mobile-app-profiles/example-mobile-login-passkey.json',
              description:
                'Example Android app profile covering launch, login form selectors, and passkey trigger selectors.',
              tags: ['android', 'login', 'passkey', 'example'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          profiles: [
            {
              id: '',
              platform: 'desktop',
              title: '',
              path: 'missing.json',
              description: '',
              tags: ['ok', 1],
            },
          ],
        },
      ],
    },
    {
      id: 'web-app-profile-index',
      schemaPath: 'knowledge/product/schemas/web-app-profile-index.schema.json',
      validPayloads: [
        {
          profiles: [
            {
              id: 'example-web-login-guarded',
              platform: 'browser',
              title: 'Example Web Login + Guarded Routes',
              path: 'knowledge/product/orchestration/web-app-profiles/example-web-login-guarded.json',
              description:
                'Shared profile for a Web app with login, guarded routes, and a debug-only session export route.',
              tags: ['browser', 'session-handoff', 'login', 'guarded-routes', 'example'],
            },
          ],
        },
      ],
      invalidPayloads: [
        {
          profiles: [
            {
              id: '',
              platform: 'desktop',
              title: '',
              path: 'missing-web.json',
              description: '',
              tags: ['ok', 1],
            },
          ],
        },
      ],
    },
    {
      id: 'browser-passkey-providers',
      schemaPath: 'knowledge/product/schemas/browser-passkey-providers.schema.json',
      validPayloads: [
        {
          default_provider: 'webauthn.io',
          providers: {
            'webauthn.io': {
              baseUrl: 'https://webauthn.io/',
              usernameSelector: '#input-email',
              registerSelector: '#register-button',
              authenticateSelector: '#login-button',
              postAuthUrlIncludes: '/profile',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          default_provider: 'webauthn.io',
          providers: {
            'webauthn.io': {
              baseUrl: 'https://webauthn.io/',
              usernameSelector: '#input-email',
            },
          },
        },
      ],
    },
    {
      id: 'browser-execution-presets',
      schemaPath: 'knowledge/product/schemas/browser-execution-presets.schema.json',
      validPayloads: [
        {
          default_preset: 'standard-web-auth',
          presets: {
            'standard-web-auth': {
              default_email: 'tester@example.com',
              default_password: 'debug-password',
              handoff_output_path: 'active/shared/tmp/browser/generated-web-session-handoff.json',
            },
          },
        },
      ],
      invalidPayloads: [
        {
          default_preset: 42,
          presets: {
            'standard-web-auth': {
              default_email: 'tester@example.com',
            },
          },
        },
      ],
    },
    {
      id: 'browser-recording',
      schemaPath: 'knowledge/product/schemas/browser-recording.schema.json',
      validPayloads: [
        {
          schema_version: 'browser-recording.v1',
          recording_id: 'REC-1',
          source: 'chrome-extension',
          created_at: '2026-06-23T00:00:00.000Z',
          tab: {
            origin: 'https://example.com',
            origin_hash: 'a'.repeat(64),
            title: 'Example',
          },
          extension: { version: '0.1.0' },
          actions: [
            {
              action_id: 'step-1',
              op: 'fill_ref',
              summary: '会社名を入力（値は保存しない）',
              risk: 'low',
              captured_at: '2026-06-23T00:00:01.000Z',
              target: {
                ref: '@e1',
                role: 'textbox',
                name: 'Company name',
                snapshot_hash: 'b'.repeat(64),
              },
              variable: { name: 'company_name', classification: 'user_input' },
            },
          ],
          risk_summary: {
            requires_manual_review: true,
            sensitive_input_omitted: 0,
            approval_required_count: 0,
          },
        },
      ],
      invalidPayloads: [
        {
          schema_version: 'browser-recording.v1',
          recording_id: 'REC-1',
          source: 'chrome-extension',
          created_at: '2026-06-23T00:00:00.000Z',
          tab: { origin: 'https://example.com', origin_hash: 'a'.repeat(64), title: 'Example' },
          extension: { version: '0.1.0' },
          actions: [
            {
              action_id: 'step-1',
              op: 'fill_ref',
              summary: '入力',
              risk: 'low',
              captured_at: '2026-06-23T00:00:01.000Z',
              value: 'must-not-be-recorded',
            },
          ],
          risk_summary: {
            requires_manual_review: true,
            sensitive_input_omitted: 0,
            approval_required_count: 0,
          },
        },
      ],
    },
    {
      id: 'browser-extension-session',
      schemaPath: 'knowledge/product/schemas/browser-extension-session.schema.json',
      validPayloads: [
        {
          kind: 'browser-extension-session.v1',
          mission_id: 'MSN-1',
          pipeline_id: 'browser-candidate-1',
          tab_id: '42',
          origin: 'https://example.com',
          mode: 'record',
          recording_id: 'REC-1',
          requested_operations: ['click_ref'],
        },
      ],
      invalidPayloads: [
        {
          kind: 'browser-extension-session.v1',
          mission_id: 'MSN-1',
          pipeline_id: 'browser-candidate-1',
          tab_id: '42',
          origin: 'https://example.com',
          mode: 'execute',
          recording_id: 'REC-1',
          requested_operations: ['evaluate'],
        },
      ],
    },
    {
      id: 'browser-extension-receipt',
      schemaPath: 'knowledge/product/schemas/browser-extension-receipt.schema.json',
      validPayloads: [
        {
          kind: 'browser-extension-receipt.v1',
          receipt_id: 'RCP-1',
          mission_id: 'MSN-1',
          pipeline_id: 'browser-candidate-1',
          recording_id: 'REC-1',
          tab_id: '42',
          origin: 'https://example.com',
          status: 'blocked',
          created_at: '2026-06-23T00:00:00.000Z',
        },
      ],
      invalidPayloads: [
        {
          kind: 'browser-extension-receipt.v1',
          receipt_id: 'RCP-1',
          mission_id: 'MSN-1',
          pipeline_id: 'browser-candidate-1',
          recording_id: 'REC-1',
          tab_id: '42',
          origin: 'chrome://extensions',
          status: 'completed',
          created_at: '2026-06-23T00:00:00.000Z',
        },
      ],
    },
    ...createServiceChecks(),
    {
      id: 'work-coordination-import-catalog',
      schemaPath: 'knowledge/product/schemas/work-coordination-import-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/work-coordination-import-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          imports: [{ id: 'broken', command: 'import-github-issue-file' }],
        },
      ],
    },
    {
      id: 'service-authority-map',
      schemaPath: 'knowledge/product/schemas/service-authority-map.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/service-authority-map.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          services: [{ id: 'broken', service_id: 'github' }],
        },
      ],
    },
    {
      id: 'actuator-dependency-bundles',
      schemaPath: 'knowledge/product/schemas/actuator-dependency-bundles.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/actuator-dependency-bundles.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          bundles: [{ id: 'broken', actuator: 'voice' }],
        },
      ],
    },
    {
      id: 'skill-install-package-map',
      schemaPath: 'knowledge/product/schemas/skill-install-package-map.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/skill-install-package-map.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          entries: [{ id: 'broken', patterns: ['whisper'] }],
        },
      ],
    },
    {
      id: 'surface-coordination-role-map',
      schemaPath: 'knowledge/product/schemas/surface-coordination-role-map.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/surface-coordination-role-map.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          entries: [{ surface: 'slack' }],
        },
      ],
    },
    {
      id: 'voice-task-profile-catalog',
      schemaPath: 'knowledge/product/schemas/voice-task-profile-catalog.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/voice-task-profile-catalog.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          profiles: [{ id: 'broken', task_type: 'presentation_deck' }],
        },
      ],
    },
    {
      id: 'media-tone-style-map',
      schemaPath: 'knowledge/product/schemas/media-tone-style-map.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/media-tone-style-map.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          tones: [{ tone: 'success' }],
        },
      ],
    },
    {
      id: 'media-drawio-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-policy.schema.json',
      validPayloads: [readGovernanceJson('knowledge/product/governance/media-drawio-policy.json')],
      invalidPayloads: [
        {
          version: '1.0.0',
          boundary_palettes: [{ boundary: 'account', fill: '#fff' }],
        },
      ],
    },
    {
      id: 'media-drawio-boundary-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-boundary-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-drawio-boundary-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          palette_overrides: [{ boundary: 'lane', tier: 'web', fill: '#fff' }],
        },
      ],
    },
    {
      id: 'media-drawio-tier-order',
      schemaPath: 'knowledge/product/schemas/media-drawio-tier-order.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-drawio-tier-order.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          tier_order: [],
        },
      ],
    },
    {
      id: 'media-drawio-sort-policy',
      schemaPath: 'knowledge/product/schemas/media-drawio-sort-policy.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-drawio-sort-policy.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          group_order: [],
          type_order: ['aws_provider'],
        },
      ],
    },
    {
      id: 'media-drawio-security-group-order',
      schemaPath: 'knowledge/product/schemas/media-drawio-security-group-order.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/media-drawio-security-group-order.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          relation_prefix: '',
        },
      ],
    },
  ];
}
