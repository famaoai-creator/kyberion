import path from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';

const rootDir = path.resolve(__dirname, '..');

function loadJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    safeReadFile(path.join(rootDir, relativePath), {
      encoding: 'utf8',
    }) as string
  );
}

function loadSchema(name: string): Record<string, unknown> {
  return loadJson(path.join('knowledge/public/schemas', `${name}.schema.json`));
}

function compileSchema(name: string) {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(loadSchema(name));
}

function collectOps(value: unknown, ops: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectOps(item, ops);
    }
    return ops;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.op === 'string') {
      ops.push(record.op);
    }
    for (const item of Object.values(record)) {
      collectOps(item, ops);
    }
  }

  return ops;
}

describe('travel planning contracts', () => {
  it('accepts a governed anniversary travel-planning brief', () => {
    const validate = compileSchema('travel-planning-brief');

    const brief = {
      kind: 'travel-planning-brief',
      destination: '札幌',
      dates: {
        start: '2026-04-18',
        end: '2026-04-19',
      },
      travelers: [
        { role: 'user', sensitivity: 'personal' },
        { role: 'spouse', birthday: '2026-04-19', sensitivity: 'personal' },
      ],
      occasion: 'wife_birthday',
      planning_goal: '天候リスクを避けつつ誕生日感のある1泊2日行程を作る',
      preferences: {
        pace: 'relaxed',
        mood: ['seasonal', 'romantic', 'not_too_busy'],
        food: ['seafood', 'soup_curry', 'jingisukan'],
        weather_risk_tolerance: 'low',
      },
      constraints: {
        no_booking_without_approval: true,
        no_payment_without_approval: true,
        avoid_closed_facilities: true,
        include_weather_backup: true,
        require_evidence_for_dynamic_facts: true,
      },
      booking_profile_ref: 'personal/booking/default-travel',
      approval_required_for: ['login', 'points_portal_redirect', 'booking_confirmation', 'payment'],
      source_policy: {
        freshness: 'within_24h',
        evidence_required: true,
        preferred_source_types: ['official', 'primary'],
      },
      desired_output: [
        'recommended_itinerary',
        'backup_plan',
        'booking_priority',
        'birthday_touchpoints',
      ],
    };

    expect(validate(brief), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('accepts booking preferences with points portal routing and secret references', () => {
    const validate = compileSchema('booking-preference-profile');

    const profile = {
      kind: 'booking-preference-profile',
      profile_id: 'personal-travel-default',
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
          reason: 'ポイントサイト経由で宿泊候補を予約する',
        },
        {
          site: 'official_hotel_site',
          priority: 2,
          categories: ['hotel'],
          reason: '公式限定プランとキャンセル条件を確認する',
          prefer_official_when_equal: true,
        },
        {
          site: 'ikyu',
          priority: 3,
          categories: ['hotel', 'restaurant'],
          reason: '記念日向け比較に使う',
        },
      ],
      login_methods: [
        {
          site: 'rakuten_travel',
          preferred_method: 'rakuten_id',
          credential_ref: 'browser://profile/rakuten-travel',
          approval_required: true,
        },
        {
          site: 'ikyu',
          preferred_method: 'email',
          credential_ref: 'browser://profile/ikyu',
          approval_required: true,
        },
      ],
      payment_policy: {
        prefer: ['free_cancellation', 'points_earning', 'onsite_payment'],
        allow_prepaid: true,
        payment_method_refs: ['secret://wallet/main-card'],
        require_confirmation_if: ['nonrefundable', 'total_amount_over_budget', 'payment_execution'],
      },
      points_portal_policy: {
        enabled: true,
        preferred_portals: [
          { portal: 'moppy', priority: 1 },
          { portal: 'hapitas', priority: 2 },
        ],
        routing_rules: [
          {
            merchant: 'rakuten_travel',
            use_points_portal: true,
            clickout_usecase_ref:
              'knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json',
            preferred_execution_mode: 'simulation',
          },
          { merchant: 'ikyu', use_points_portal: true, min_expected_reward: '1.0%' },
          { merchant: 'official_hotel_site', use_points_portal: false, reason: '公式特典を優先' },
        ],
        require_confirmation_if: [
          'reward_rate_unknown',
          'tracking_cookie_blocked',
          'coupon_conflict',
          'payment_execution',
        ],
        evidence_required: [
          'portal_name',
          'merchant_page',
          'reward_rate',
          'terms_snapshot',
          'timestamp',
          'final_booking_site',
        ],
        fallback_rule: 'manual_review',
      },
    };

    expect(validate(profile), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('rejects inline login secrets in booking profiles', () => {
    const validate = compileSchema('booking-preference-profile');

    const profileWithPassword = {
      kind: 'booking-preference-profile',
      profile_id: 'unsafe-profile',
      security_boundaries: {
        forbid_inline_secrets: true,
        approval_required_for: ['payment_execution'],
      },
      preferred_booking_sites: [{ site: 'ikyu', priority: 1 }],
      login_methods: [
        {
          site: 'ikyu',
          preferred_method: 'email',
          password: 'do-not-store-this',
        },
      ],
      payment_policy: {
        prefer: ['points_earning'],
        allow_prepaid: true,
        require_confirmation_if: ['payment_execution'],
      },
    };

    expect(validate(profileWithPassword)).toBe(false);
  });

  it('rejects booking profiles that do not gate payment execution', () => {
    const validate = compileSchema('booking-preference-profile');

    const profileWithoutPaymentGate = {
      kind: 'booking-preference-profile',
      profile_id: 'missing-payment-gate',
      security_boundaries: {
        forbid_inline_secrets: true,
        approval_required_for: ['credential_use'],
      },
      preferred_booking_sites: [{ site: 'official_hotel_site', priority: 1 }],
      payment_policy: {
        prefer: ['free_cancellation'],
        allow_prepaid: false,
        require_confirmation_if: ['payment_execution'],
      },
    };

    expect(validate(profileWithoutPaymentGate)).toBe(false);
  });

  it('accepts a governed points portal clickout use case', () => {
    const validate = compileSchema('points-portal-clickout-usecase');
    const usecase = loadJson(
      'knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json'
    );

    expect(validate(usecase), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('rejects points portal clickout use cases that allow session handoff export', () => {
    const validate = compileSchema('points-portal-clickout-usecase');
    const unsafeUsecase = loadJson(
      'knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json'
    );
    const artifactPolicy = unsafeUsecase.artifact_policy as Record<string, unknown>;

    artifactPolicy.forbid_session_handoff_export = false;

    expect(validate(unsafeUsecase)).toBe(false);
  });

  it('keeps the Moppy to Rakuten browser ADF inside the clickout guardrails', () => {
    const adf = loadJson(
      'libs/actuators/browser-actuator/examples/moppy-rakuten-travel-simulation.json'
    );
    const context = adf.context as Record<string, unknown>;
    const bookingRoute = context.booking_route as Record<string, unknown>;
    const successCriteria = bookingRoute.success_criteria as Record<string, unknown>;
    const artifactPolicy = bookingRoute.artifact_policy as Record<string, unknown>;
    const preflight = bookingRoute.preflight as Record<string, unknown>;
    const steps = adf.steps as Record<string, unknown>[];
    const ops = collectOps(steps);

    expect(bookingRoute.usecase_ref).toBe(
      'knowledge/public/schemas/points-portal-clickout-usecase.moppy-rakuten-travel.example.json'
    );
    expect(successCriteria.landing_url_includes).toBe('travel.rakuten.co.jp');
    expect(successCriteria.handoff_export_absent).toBe(true);
    expect(successCriteria.blocked_actions_not_executed).toBe(true);
    expect(artifactPolicy.forbid_session_handoff_export).toBe(true);
    expect(preflight.deny_ops).toContain('export_session_handoff');
    expect(ops).toContain('select_tab_matching');
    expect(ops).not.toContain('export_session_handoff');
  });
});
