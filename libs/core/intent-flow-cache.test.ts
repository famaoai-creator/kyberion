import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { compileUserIntentFlow } from './intent-contract.js';
import {
  buildIntentFlowCacheEligibility,
  getDefaultIntentFlowCacheTtlMs,
  intentFlowCachePath,
  lookupIntentFlowCache,
  refreshIntentFlowCacheSnapshot,
  storeIntentFlowCache,
} from './intent-flow-cache.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import {
  loadModelRegistry,
  resetReasoningModelRoutingCache,
  resolveReasoningModelRoute,
} from './reasoning-model-routing.js';
import { loadStandardIntentCatalog } from './intent-resolution.js';
import { loadReasoningLevelPolicy, resetReasoningLevelPolicyCache } from './reasoning-level-policy.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('intent-flow-cache', () => {
  const cachePath = intentFlowCachePath();
  let originalCacheRaw: string | null = null;
  let originalCacheExists = false;

  beforeAll(() => {
    originalCacheExists = safeExistsSync(cachePath);
    originalCacheRaw = originalCacheExists ? (safeReadFile(cachePath, { encoding: 'utf8' }) as string) : null;
  });

  beforeEach(() => {
    if (originalCacheExists && originalCacheRaw !== null) {
      safeWriteFile(cachePath, originalCacheRaw);
    } else if (safeExistsSync(cachePath)) {
      safeRmSync(cachePath);
    }
    refreshIntentFlowCacheSnapshot();
    resetReasoningLevelPolicyCache();
    resetReasoningModelRoutingCache();
  });

  afterAll(() => {
    if (originalCacheExists && originalCacheRaw !== null) {
      safeWriteFile(cachePath, originalCacheRaw);
    } else if (safeExistsSync(cachePath)) {
      safeRmSync(cachePath);
    }
    refreshIntentFlowCacheSnapshot();
  });

  function buildEligibleContext() {
    const text = 'ここまでを要約して';
    const resolutionPacket = resolveIntentResolutionPacket(text);
    const policy = loadReasoningLevelPolicy();
    const registry = loadModelRegistry();
    const selectedIntent = resolutionPacket.selected_intent_id
      ? loadStandardIntentCatalog().find((entry) => entry.id === resolutionPacket.selected_intent_id)
      : undefined;
    const reasoningDecision = {
      level: 'REACTION_FAST' as const,
      rule_id: 'known-low-risk-fast',
      reasons: ['test'],
      policy_version: policy.version,
      advisory: true as const,
    };
    const shadowModelRoute = resolveReasoningModelRoute(reasoningDecision, { policy, registry });
    const eligibility = buildIntentFlowCacheEligibility({
      text,
      locale: 'ja',
      tier: 'confidential',
      channel: 'cli',
      serviceBindings: ['calendar'],
      runtimeContext: { surface: 'cli', platform_id: 'local' },
      resolutionPacket,
      selectedIntent: selectedIntent as any,
      reasoningDecision,
      shadowModelRoute,
    });
    return { text, eligibility, reasoningDecision, shadowModelRoute, resolutionPacket };
  }

  function buildResponses() {
    return [
      JSON.stringify({
        kind: 'actuator-execution-brief',
        request_text: 'ここまでを要約して',
        archetype_id: 'summarize-conversation',
        confidence: 0.9,
        summary: '会話を短く要約する',
        user_facing_summary: '会話の要点をまとめる',
        normalized_scope: ['conversation_summary'],
        target_actuators: ['knowledge-specialist'],
        deliverables: ['conversation_summary'],
        missing_inputs: [],
        assumptions: ['Use the current thread context.'],
        clarification_questions: [],
        readiness: 'fully_automatable',
        readiness_reason: 'No missing inputs.',
        llm_touchpoints: [],
        recommended_next_step: 'Compile the intent contract and work loop.',
      }),
      JSON.stringify({
        kind: 'intent-contract',
        source_text: 'ここまでを要約して',
        intent_id: 'summarize-conversation',
        goal: {
          summary: 'Summarize the conversation',
          success_condition: 'A concise summary is prepared.',
        },
        resolution: {
          execution_shape: 'direct_reply',
          task_type: 'conversation_summary',
        },
        required_inputs: [],
        outcome_ids: ['conversation_summary'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.93,
        why: 'The request is a governed conversation summary task.',
      }),
      JSON.stringify({
        intent: { label: 'summarize-conversation' },
        context: {
          tier: 'confidential',
          service_bindings: ['calendar'],
        },
        resolution: {
          execution_shape: 'direct_reply',
          task_type: 'conversation_summary',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
          rationale: 'Default workflow for straightforward bounded work.',
        },
        review_design: {
          review_mode: 'lean',
          required_gate_ids: [],
          all_gate_ids: [],
          rationale: 'Lean direct-reply path.',
        },
        outcome_design: {
          outcome_ids: ['conversation_summary'],
          labels: ['Conversation summary'],
        },
        process_design: {
          plan_outline: ['collect context', 'summarize', 'return answer'],
          intake_requirements: [],
          operator_checklist: ['confirm the governed summary path'],
        },
        runtime_design: {
          owner_model: 'single_actor',
          assignment_policy: 'direct_specialist',
          coordination: {
            bus: 'none',
            channels: [],
          },
          memory: {
            store: 'none',
            scope: 'none',
            purpose: [],
          },
        },
        execution_boundary: {
          llm_zone: {
            allowed: ['draft_content_within_governed_slots'],
            forbidden: ['override_governed_structure'],
          },
          knowledge_zone: {
            owns: ['intent definitions'],
          },
          compiler_zone: {
            responsibilities: ['map_intent_to_governed_execution_shape'],
          },
          executor_zone: {
            responsibilities: ['perform_governed_execution'],
          },
          rule: 'LLM drafts within governed slots; compiler and executor remain deterministic',
        },
        teaming: {
          specialist_id: 'knowledge-specialist',
          specialist_label: 'Knowledge Specialist',
          conversation_agent: 'nerve-agent',
          team_roles: ['planner'],
        },
        authority: {
          requires_approval: false,
        },
        learning: {
          reusable_refs: [],
        },
      }),
    ];
  }

  it('caches eligible fast-lane flows and hits on the second call', async () => {
    const { text } = buildEligibleContext();
    const responses = buildResponses();
    const askFn = vi.fn(async () => responses.shift() || '');

    const first = await compileUserIntentFlow(
      {
        text,
        locale: 'ja',
        tier: 'confidential',
        channel: 'cli',
        serviceBindings: ['calendar'],
        runtimeContext: { surface: 'cli', platform_id: 'local' },
      },
      { askFn },
    );
    expect(first.reasoningDecision.level).toBe('REACTION_FAST');
    expect(askFn).toHaveBeenCalledTimes(3);
    const hit = lookupIntentFlowCache({
      eligibility: buildEligibleContext().eligibility,
      inputText: text,
    });
    expect(hit.status).toBe('hit');

    const second = await compileUserIntentFlow(
      {
        text,
        locale: 'ja',
        tier: 'confidential',
        channel: 'cli',
        serviceBindings: ['calendar'],
        runtimeContext: { surface: 'cli', platform_id: 'local' },
      },
      { askFn },
    );

    expect(second.source).toBe('llm');
    expect(askFn).toHaveBeenCalledTimes(3);
    expect(second.reasoningDecision.level).toBe('REACTION_FAST');
  });

  it('misses when the cache key drifts or the entry expires', async () => {
    const base = buildEligibleContext();
    const responses = buildResponses();
    const askFn = vi.fn(async () => responses.shift() || '');

    await compileUserIntentFlow(
      {
        text: base.text,
        locale: 'ja',
        tier: 'confidential',
        channel: 'cli',
        serviceBindings: ['calendar'],
        runtimeContext: { surface: 'cli', platform_id: 'local' },
      },
      { askFn },
    );
    expect(askFn).toHaveBeenCalledTimes(3);

    await compileUserIntentFlow(
      {
        text: base.text,
        locale: 'en',
        tier: 'confidential',
        channel: 'cli',
        serviceBindings: ['calendar'],
        runtimeContext: { surface: 'cli', platform_id: 'local' },
      },
      { askFn },
    );
    expect(askFn).toHaveBeenCalledTimes(5);

    const store = JSON.parse(safeReadFile(cachePath, { encoding: 'utf8' }) as string);
    const matchingEntry = store.entries.find(
      (entry: { cache_key_hash?: string }) => entry.cache_key_hash === base.eligibility.cacheKeyHash,
    );
    if (!matchingEntry) {
      throw new Error('expected a matching cache entry to expire');
    }
    matchingEntry.expires_at = new Date(Date.now() - 60_000).toISOString();
    safeWriteFile(cachePath, JSON.stringify(store, null, 2));
    refreshIntentFlowCacheSnapshot();

    responses.push(...buildResponses());

    await compileUserIntentFlow(
      {
        text: base.text,
        locale: 'ja',
        tier: 'confidential',
        channel: 'cli',
        serviceBindings: ['calendar'],
        runtimeContext: { surface: 'cli', platform_id: 'local' },
      },
      { askFn },
    );
    expect(askFn).toHaveBeenCalledTimes(8);
  });

  it('fails open when the cache json is invalid', async () => {
    safeWriteFile(cachePath, 'not json');

    const responses = buildResponses();
    const askFn = vi.fn(async () => responses.shift() || '');
    const result = await compileUserIntentFlow(
      {
        text: 'ここまでを要約して',
        locale: 'ja',
        tier: 'confidential',
        channel: 'cli',
        serviceBindings: ['calendar'],
        runtimeContext: { surface: 'cli', platform_id: 'local' },
      },
      { askFn },
    );

    expect(result.source).toBe('llm');
    expect(askFn).toHaveBeenCalledTimes(3);
  });

  it('does not write exploratory, standard, reflex, approval-required, clarification-required, or personal-tier flows', () => {
    const policy = loadReasoningLevelPolicy();
    const cacheableRoute = resolveReasoningModelRoute(
      {
        level: 'REACTION_FAST',
        rule_id: 'known-low-risk-fast',
        reasons: [],
        policy_version: policy.version,
        advisory: true,
      },
      { policy, registry: loadModelRegistry() },
    );

    const cases = [
      {
        label: 'exploratory',
        eligibility: buildIntentFlowCacheEligibility({
          text: 'explore this',
          locale: 'ja',
          tier: 'confidential',
          channel: 'cli',
          serviceBindings: [],
          runtimeContext: { surface: 'cli' },
          resolutionPacket: {
            kind: 'intent_resolution_packet',
            utterance: 'explore this',
            selected_confidence: 0.9,
            candidates: [],
          },
          selectedIntent: {
            id: 'generate-report',
            risk_profile: 'review_required',
            resolution: { shape: 'task_session' },
          } as any,
          reasoningDecision: {
            level: 'COGNITIVE_EXPLORATORY',
            rule_id: 'high-risk-exploratory',
            reasons: [],
            policy_version: policy.version,
            advisory: true,
          },
          shadowModelRoute: cacheableRoute,
        }),
      },
      {
        label: 'standard',
        eligibility: buildIntentFlowCacheEligibility({
          text: 'plan this',
          locale: 'ja',
          tier: 'confidential',
          channel: 'cli',
          serviceBindings: [],
          runtimeContext: { surface: 'cli' },
          resolutionPacket: {
            kind: 'intent_resolution_packet',
            utterance: 'plan this',
            selected_confidence: 0.8,
            candidates: [],
          },
          selectedIntent: {
            id: 'generate-report',
            risk_profile: 'review_required',
            resolution: { shape: 'task_session' },
          } as any,
          reasoningDecision: {
            level: 'COGNITIVE_STANDARD',
            rule_id: 'default-standard',
            reasons: [],
            policy_version: policy.version,
            advisory: true,
          },
          shadowModelRoute: cacheableRoute,
        }),
      },
      {
        label: 'reflex',
        eligibility: buildIntentFlowCacheEligibility({
          text: 'こんにちは',
          locale: 'ja',
          tier: 'confidential',
          channel: 'cli',
          serviceBindings: [],
          runtimeContext: { surface: 'cli' },
          resolutionPacket: {
            kind: 'intent_resolution_packet',
            utterance: 'こんにちは',
            candidates: [],
          },
          selectedIntent: undefined,
          reasoningDecision: {
            level: 'REFLEX_DETERMINISTIC',
            rule_id: 'simple-greeting-reflex',
            reasons: [],
            policy_version: policy.version,
            advisory: true,
          },
          shadowModelRoute: {
            recommended_model_id: null,
            model_route_status: 'shadow',
            route_reason: 'Reflex lane bypasses model dispatch.',
            route_kind: 'none',
            policy_version: policy.version,
          },
        }),
      },
      {
        label: 'approval',
        eligibility: buildIntentFlowCacheEligibility({
          text: 'approve this',
          locale: 'ja',
          tier: 'confidential',
          channel: 'cli',
          serviceBindings: [],
          runtimeContext: { surface: 'cli' },
          resolutionPacket: {
            kind: 'intent_resolution_packet',
            utterance: 'approve this',
            selected_confidence: 0.9,
            candidates: [],
          },
          selectedIntent: {
            id: 'request-approval',
            risk_profile: 'approval_required',
            resolution: { shape: 'task_session' },
          } as any,
          reasoningDecision: {
            level: 'COGNITIVE_EXPLORATORY',
            rule_id: 'high-risk-exploratory',
            reasons: [],
            policy_version: policy.version,
            advisory: true,
          },
          shadowModelRoute: cacheableRoute,
        }),
      },
      {
        label: 'clarification',
        eligibility: buildIntentFlowCacheEligibility({
          text: 'maybe this',
          locale: 'ja',
          tier: 'confidential',
          channel: 'cli',
          serviceBindings: [],
          runtimeContext: { surface: 'cli' },
          resolutionPacket: {
            kind: 'intent_resolution_packet',
            utterance: 'maybe this',
            selected_confidence: 0.5,
            candidates: [],
          },
          selectedIntent: undefined,
          reasoningDecision: {
            level: 'COGNITIVE_EXPLORATORY',
            rule_id: 'ambiguous-exploratory',
            reasons: [],
            policy_version: policy.version,
            advisory: true,
          },
          shadowModelRoute: cacheableRoute,
        }),
      },
      {
        label: 'personal',
        eligibility: buildIntentFlowCacheEligibility({
          text: 'ここまでを要約して',
          locale: 'ja',
          tier: 'personal',
          channel: 'cli',
          serviceBindings: [],
          runtimeContext: { surface: 'cli' },
          resolutionPacket: {
            kind: 'intent_resolution_packet',
            utterance: 'ここまでを要約して',
            selected_confidence: 0.9,
            candidates: [],
          },
          selectedIntent: {
            id: 'summarize-conversation',
            risk_profile: 'low',
            resolution: { shape: 'direct_reply' },
          } as any,
          reasoningDecision: {
            level: 'REACTION_FAST',
            rule_id: 'known-low-risk-fast',
            reasons: [],
            policy_version: policy.version,
            advisory: true,
          },
          shadowModelRoute: cacheableRoute,
        }),
      },
    ];

    for (const testCase of cases) {
      expect(testCase.eligibility.eligible).toBe(false);
      expect(
        storeIntentFlowCache({
          eligibility: testCase.eligibility,
          flow: {} as any,
        }).status,
      ).toBe('disabled');
    }
  });

  it('reports the default ttl policy in milliseconds', () => {
    expect(getDefaultIntentFlowCacheTtlMs()).toBe(24 * 60 * 60 * 1000);
    expect(loadReasoningLevelPolicy().cache_ttl_hours).toBe(24);
  });
});
