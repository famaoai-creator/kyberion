import { describe, expect, it } from 'vitest';
import { deriveSlackExecutionMode, deriveSlackIntentLabel, deriveSurfaceDelegationReceiver, resolveSurfaceConversationReceiver, shouldForceSlackDelegation } from './channel-surface.js';
import { surfaceChannelFromAgentId } from './surface-runtime-router.js';

describe('channel-surface routing helpers', () => {
  it('routes mission and system queries to chronos-mirror', () => {
    expect(deriveSurfaceDelegationReceiver('ミッション一覧を教えて', 'slack')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiver('システム状態を教えて', 'presence')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiver('runtime status please', 'presence')).toBe('chronos-mirror');
  });

  it('routes deeper reasoning requests to nerve-agent', () => {
    expect(deriveSurfaceDelegationReceiver('この設計をレビューして', 'slack')).toBe('nerve-agent');
    expect(deriveSurfaceDelegationReceiver('この設計をレビューして', 'chronos')).toBe('nerve-agent');
  });

  it('keeps lightweight greetings local', () => {
    expect(deriveSurfaceDelegationReceiver('こんにちは', 'slack')).toBeUndefined();
    expect(deriveSurfaceDelegationReceiver('thanks', 'slack')).toBeUndefined();
  });

  it('keeps casual informational questions local unless they match heavy-work routing', () => {
    expect(deriveSurfaceDelegationReceiver('今日の天気おしえて', 'slack')).toBeUndefined();
    expect(deriveSurfaceDelegationReceiver('What is the weather today?', 'presence')).toBeUndefined();
    expect(deriveSurfaceDelegationReceiver('このsurfaceでは何ができるの？', 'chronos')).toBeUndefined();
  });

  it('resolves compiled heavy-work flows to nerve-agent via receiver rules', () => {
    const receiver = resolveSurfaceConversationReceiver(undefined, {
      intentContract: {
        kind: 'intent-contract',
        source_text: '非機能要件定義書を作る',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Generate a governed deliverable',
          success_condition: 'A governed artifact is produced.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'presentation_deck',
        },
        required_inputs: [],
        outcome_ids: ['artifact:pptx'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.9,
        why: 'Heavy document work should route to the reasoning agent.',
      },
      workLoop: {
        intent: { label: 'generate-presentation' },
        context: { tier: 'confidential', service_bindings: [] },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'presentation_deck',
        },
        outcome_design: { outcome_ids: ['artifact:pptx'], labels: [] },
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
          specialist_id: 'document-specialist',
          specialist_label: 'Document Specialist',
          conversation_agent: 'nerve-agent',
          team_roles: [],
        },
        authority: { requires_approval: false },
        learning: { reusable_refs: [] },
      },
      source: 'llm',
    }, 'slack');

    expect(receiver).toBe('nerve-agent');
  });

  it('derives slack intent labels through governed rules', () => {
    expect(deriveSlackIntentLabel('この設計をレビューして')).toBe('request_review');
    expect(deriveSlackIntentLabel('voice-hub の進捗どうなった？')).toBe('request_mission_work');
    expect(deriveSlackIntentLabel('ざっくり考えて')).toBe('request_deeper_reasoning');
  });

  it('derives slack execution mode through governed rules', () => {
    expect(deriveSlackExecutionMode('お願いできますか？')).toBe('conversation');
    expect(deriveSlackExecutionMode('このファイルを作成して')).toBe('task');
  });

  it('forces slack delegation unless the message matches lightweight rules', () => {
    expect(shouldForceSlackDelegation('thanks')).toBe(false);
    expect(shouldForceSlackDelegation('この設計をレビューして')).toBe(true);
  });

  it('infers surface ids from manifest-backed agent ids', () => {
    expect(surfaceChannelFromAgentId('kyberion:slack-bridge')).toBe('slack');
    expect(surfaceChannelFromAgentId('kyberion:imessage-bridge')).toBe('imessage');
    expect(surfaceChannelFromAgentId('kyberion:discord-bridge')).toBe('discord');
    expect(surfaceChannelFromAgentId('kyberion:telegram-bridge')).toBe('telegram');
    expect(surfaceChannelFromAgentId('imessage-surface-agent')).toBe('imessage');
  });
});
