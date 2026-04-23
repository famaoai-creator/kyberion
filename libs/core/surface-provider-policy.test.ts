import { describe, expect, it } from 'vitest';

import {
  deriveSurfaceDelegationReceiverForProvider,
  deriveSlackExecutionModeFromProviderPolicy,
  deriveSlackIntentLabelFromProviderPolicy,
  getSurfaceProviderManifestRecord,
  listSurfaceProviderManifestRecords,
  resolveSurfaceConversationReceiverForProvider,
  shouldForceSlackDelegationFromProviderPolicy,
} from './surface-provider-policy.js';

describe('surface-provider-policy', () => {
  it('loads all provider manifest records from governed knowledge', () => {
    const ids = listSurfaceProviderManifestRecords().map((entry) => entry.id).sort();
    expect(ids).toEqual(['chronos', 'presence', 'slack']);
  });

  it('derives delegation receivers per provider policy', () => {
    expect(deriveSurfaceDelegationReceiverForProvider('slack', 'ミッション一覧を教えて')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiverForProvider('presence', 'システム状態を教えて')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiverForProvider('chronos', '設計をレビューして')).toBe('nerve-agent');
  });

  it('loads slack-specific intent and execution rules from provider policy', () => {
    expect(deriveSlackIntentLabelFromProviderPolicy('この設計をレビューして')).toBe('request_review');
    expect(deriveSlackExecutionModeFromProviderPolicy('お願いできますか？')).toBe('conversation');
    expect(deriveSlackExecutionModeFromProviderPolicy('このファイルを作成して')).toBe('task');
    expect(shouldForceSlackDelegationFromProviderPolicy('thanks')).toBe(false);
    expect(shouldForceSlackDelegationFromProviderPolicy('この設計をレビューして')).toBe(true);
  });

  it('resolves compiled flow receivers per provider policy', () => {
    const receiver = resolveSurfaceConversationReceiverForProvider('presence', {
      intentContract: {
        kind: 'intent-contract',
        source_text: '分析して',
        intent_id: 'analysis',
        goal: {
          summary: 'Analyze',
          success_condition: 'Analysis exists.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'analysis',
        },
        required_inputs: [],
        outcome_ids: ['artifact:report'],
        approval: { requires_approval: false },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.8,
        why: 'analysis should route to the reasoning agent',
      },
      workLoop: {
        intent: { label: 'analysis' },
        context: { tier: 'confidential', service_bindings: [] },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'analysis',
        },
        outcome_design: { outcome_ids: ['artifact:report'], labels: [] },
        process_design: { plan_outline: [], intake_requirements: [], operator_checklist: [] },
        runtime_design: {
          owner_model: 'single_actor',
          assignment_policy: 'direct_specialist',
          coordination: { bus: 'none', channels: [] },
          memory: { store: 'none', scope: 'none', purpose: [] },
        },
        execution_boundary: {
          llm_zone: { allowed: [], forbidden: [] },
          knowledge_zone: { owns: [] },
          compiler_zone: { responsibilities: [] },
          executor_zone: { responsibilities: [] },
          rule: 'test',
        },
        teaming: {
          specialist_id: 'analysis-specialist',
          specialist_label: 'Analysis Specialist',
          conversation_agent: 'nerve-agent',
          team_roles: [],
        },
        authority: { requires_approval: false },
        learning: { reusable_refs: [] },
      },
      source: 'llm',
    });

    expect(receiver).toBe('nerve-agent');
    expect(getSurfaceProviderManifestRecord('slack').displayName).toBe('Slack');
  });
});
