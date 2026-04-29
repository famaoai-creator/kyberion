import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  assertValidOperatorProfile,
  assertValidOperatorRequestLog,
  buildOperatorLearningProposal,
  buildOperatorRequestLogFromIntentResolution,
  promoteOperatorLearningProposal,
  simulateOperatorLearningFromUtterances,
  type OperatorProfile,
  type OperatorRequestLog,
} from './operator-learning.js';
import { resolveIntentResolutionPacket, type IntentResolutionPacket } from './intent-resolution.js';
import { safeReadFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('operator learning schemas', () => {
  const profile: OperatorProfile = {
    kind: 'operator-profile',
    profile_id: 'ceo-cto-hybrid',
    scope: 'personal',
    subject: {
      display_name: 'Operator',
      roles: ['ceo', 'cto'],
      locale: 'ja-JP',
      timezone: 'Asia/Tokyo',
    },
    communication: {
      preferred_language: 'ja',
      response_style: 'brief_direct',
      preferred_detail_level: 'compact',
      question_budget_default: 1,
      default_structure: ['result', 'reason', 'next'],
    },
    decision_style: {
      ambiguity_tolerance: 'medium',
      prefers_options_over_open_ended: true,
      default_assumption_policy: 'reasonable_and_explicit',
      tie_break_style: 'recommend_then_wait',
      ask_before_action_if: [
        'irreversible_action',
        'high_risk_action',
        'financial_commitment',
        'external_side_effect',
        'authority_unclear',
      ],
    },
    terminology: {
      canonical_terms: [{ term: 'mission', aliases: ['task', '案件'] }],
    },
    recurring_tasks: [
      {
        family: 'decision_support',
        trigger_phrases: ['比較して', '論点整理'],
        default_route: 'direct_reply',
        default_outputs: ['comparison', 'recommendation'],
      },
    ],
    approval_policy: {
      requires_confirmation_if: ['credential_use', 'customer_facing_commitment'],
    },
    learning: {
      update_policy: 'incremental',
      min_samples_to_promote: 5,
      retain_counterexamples: true,
      drift_detection: true,
    },
  };

  const requestLog: OperatorRequestLog = {
    kind: 'operator-request-log',
    request_id: 'req_2026_04_29_0001',
    profile_id: 'ceo-cto-hybrid',
    received_at: '2026-04-29T09:44:22.000Z',
    surface: 'terminal',
    raw_request: '今期の成長戦略を3案で比較して',
    normalized_intent: {
      intent_id: 'executive-strategy-brief',
      task_family: 'decision_support',
    },
    context: {
      locale: 'ja-JP',
      active_mission_ref: null,
      project_ref: null,
    },
    route: {
      shape: 'direct_reply',
      reason: 'strategy comparison can start as a decision brief',
      confidence: 0.91,
    },
    signals: {
      decision_style_observed: 'options_with_recommendation',
      terminology_observed: ['成長戦略', '比較'],
      recurring_task_candidate: ['executive_strategy'],
    },
    clarification: {
      asked: true,
      questions: ['対象期間と制約は何ですか？'],
    },
    execution: {
      started: false,
      artifact_refs: [],
    },
    verification: {
      result: 'unverified',
      mismatch_notes: [],
      operator_correction_count: 0,
    },
    learning_update: {
      candidate_created: true,
      candidate_kind: 'operator-preference-card',
      promote_eligible: false,
      sample_count_after_update: 1,
    },
    privacy: {
      tier: 'personal',
      contains_sensitive_info: false,
      exportable_publicly: false,
    },
  };

  it('validates a CEO/CTO hybrid operator profile', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('public/schemas/operator-profile.schema.json')
    );

    const valid = validate(profile);

    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('validates an operator request log with learning signals', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('public/schemas/operator-request-log.schema.json')
    );

    const valid = validate(requestLog);

    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('builds an operator request log from an intent resolution packet', () => {
    const packet = resolveIntentResolutionPacket(
      'OpenAI / Anthropic / Gemini のどれを使うべきか、コストと品質で比較して'
    );

    const log = buildOperatorRequestLogFromIntentResolution({
      packet,
      profileId: 'ceo-cto-hybrid',
      surface: 'terminal',
      receivedAt: '2026-04-29T10:10:00.000Z',
    });

    expect(log.kind).toBe('operator-request-log');
    expect(log.request_id).toMatch(/^opreq_[0-9a-f]{12}$/);
    expect(log.normalized_intent.intent_id).toBe('llm-provider-selection');
    expect(log.normalized_intent.task_family).toBe('environment_and_recovery');
    expect(log.route.shape).toBe('direct_reply');
    expect(log.route.confidence).toBeGreaterThanOrEqual(0.8);
    expect(log.signals.decision_style_observed).toBe('technical_evaluation');
    expect(log.signals.recurring_task_candidate).toEqual(['provider_selection']);
    expect(log.context?.locale).toBe('ja-JP');
    assertValidOperatorRequestLog(log);
  });

  it('builds a valid unresolved operator request log for later correction learning', () => {
    const packet: IntentResolutionPacket = {
      kind: 'intent_resolution_packet',
      utterance: 'あとで例のやつをいい感じにして',
      candidates: [],
    };

    const log = buildOperatorRequestLogFromIntentResolution({
      packet,
      profileId: 'ceo-cto-hybrid',
      surface: 'terminal',
      receivedAt: '2026-04-29T10:11:00.000Z',
      clarificationQuestions: ['対象と期待する成果物は何ですか？'],
    });

    expect(log.normalized_intent.intent_id).toBe('unresolved_intent');
    expect(log.normalized_intent.task_family).toBe('unresolved');
    expect(log.route.confidence).toBe(0);
    expect(log.clarification?.asked).toBe(true);
    expect(log.signals.recurring_task_candidate).toEqual([]);
    expect(log.learning_update.candidate_created).toBe(false);
    assertValidOperatorRequestLog(log);
  });

  it('builds an approval-gated learning proposal from request logs', () => {
    assertValidOperatorProfile(profile);
    assertValidOperatorRequestLog(requestLog);

    const proposal = buildOperatorLearningProposal({
      profile,
      requestLogs: [requestLog],
      now: '2026-04-29T10:00:00.000Z',
    });

    expect(proposal.kind).toBe('operator-learning-proposal');
    expect(proposal.profile_id).toBe('ceo-cto-hybrid');
    expect(proposal.recommended_tier).toBe('personal');
    expect(proposal.requires_approval).toBe(true);
    expect(proposal.promotion_decision.eligible).toBe(false);
    expect(proposal.candidate_updates.terminology?.observed_terms).toEqual([
      '成長戦略',
      '比較',
    ]);
    expect(proposal.candidate_updates.recurring_tasks).toEqual([
      { family: 'executive_strategy', sample_count: 1 },
    ]);
  });

  it('simulates repeated operator utterances into an eligible learning proposal', () => {
    const simulation = simulateOperatorLearningFromUtterances({
      profile: {
        ...profile,
        learning: {
          ...profile.learning,
          min_samples_to_promote: 3,
        },
      },
      surface: 'terminal',
      startAt: '2026-04-29T10:20:00.000Z',
      utterances: [
        'OpenAI / Anthropic / Gemini のどれを使うべきか、コストと品質で比較して',
        'この用途に合うLLM providerを選んで',
        'モデル選定をコストと品質で比較して',
      ],
    });

    expect(simulation.kind).toBe('operator-learning-simulation');
    expect(simulation.profile_id).toBe('ceo-cto-hybrid');
    expect(simulation.request_logs).toHaveLength(3);
    expect(simulation.request_logs.map((log) => log.normalized_intent.intent_id)).toEqual([
      'llm-provider-selection',
      'llm-provider-selection',
      'llm-provider-selection',
    ]);
    expect(simulation.proposal.promotion_decision.eligible).toBe(true);
    expect(simulation.proposal.candidate_updates.recurring_tasks).toEqual([
      { family: 'provider_selection', sample_count: 3 },
    ]);
  });

  it('blocks promotion below threshold unless explicitly allowed', () => {
    const proposal = buildOperatorLearningProposal({
      profile,
      requestLogs: [requestLog],
      now: '2026-04-29T10:00:00.000Z',
    });

    expect(() =>
      promoteOperatorLearningProposal({
        proposal,
        approvedBy: 'operator',
        approvedAt: '2026-04-29T10:05:00.000Z',
        dryRun: true,
      })
    ).toThrow(/not eligible for promotion/);
  });

  it('writes an approved promotion record to an explicit governed path', () => {
    const proposal = buildOperatorLearningProposal({
      profile: {
        ...profile,
        learning: {
          ...profile.learning,
          min_samples_to_promote: 1,
        },
      },
      requestLogs: [
        {
          ...requestLog,
          verification: {
            ...requestLog.verification,
            result: 'satisfied',
          },
        },
      ],
      now: '2026-04-29T10:00:00.000Z',
    });
    const outputPath = pathResolver.sharedTmp(
      'operator-learning-tests/approved-promotion-record.json'
    );

    const record = promoteOperatorLearningProposal({
      proposal,
      approvedBy: 'operator',
      approvedAt: '2026-04-29T10:05:00.000Z',
      outputPath,
    });
    const stored = JSON.parse(safeReadFile(outputPath, { encoding: 'utf8' }) as string);

    expect(record.target_path).toBe(outputPath);
    expect(stored.kind).toBe('operator-learning-promotion-record');
    expect(stored.approved_by).toBe('operator');
    expect(stored.profile_id).toBe('ceo-cto-hybrid');
    expect(stored.candidate_updates.recurring_tasks).toEqual([
      { family: 'executive_strategy', sample_count: 1 },
    ]);
  });
});
