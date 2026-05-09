import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
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
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('surface-provider-policy', () => {
  it('loads all provider manifest records from governed knowledge', () => {
    const ids = listSurfaceProviderManifestRecords().map((entry) => entry.id).sort();
    expect(ids).toEqual(['chronos', 'discord', 'imessage', 'presence', 'slack', 'telegram']);
  });

  it('derives delegation receivers per provider policy', () => {
    expect(deriveSurfaceDelegationReceiverForProvider('slack', 'ミッション一覧を教えて')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiverForProvider('presence', 'システム状態を教えて')).toBe('chronos-mirror');
    expect(deriveSurfaceDelegationReceiverForProvider('imessage', '設計をレビューして')).toBe('nerve-agent');
    expect(deriveSurfaceDelegationReceiverForProvider('chronos', '設計をレビューして')).toBe('nerve-agent');
    expect(deriveSurfaceDelegationReceiverForProvider('discord', '設計をレビューして')).toBe('nerve-agent');
    expect(deriveSurfaceDelegationReceiverForProvider('telegram', '設計をレビューして')).toBe('nerve-agent');
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
    expect(getSurfaceProviderManifestRecord('imessage').displayName).toBe('iMessage');
    expect(getSurfaceProviderManifestRecord('discord').displayName).toBe('Discord');
    expect(getSurfaceProviderManifestRecord('telegram').displayName).toBe('Telegram');
  });

  it('keeps prompt-mode compiled flows on the direct reply path', () => {
    const receiver = resolveSurfaceConversationReceiverForProvider('slack', {
      intentContract: {
        kind: 'intent-contract',
        source_text: '左下の承認ボタンを押して',
        intent_id: 'browser-step',
        goal: {
          summary: 'Click the requested button',
          success_condition: 'The requested browser step is completed.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'browser_step',
        },
        required_inputs: [],
        outcome_ids: ['browser_step'],
        approval: { requires_approval: false },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.9,
        why: 'Lightweight browser step',
      },
      workLoop: {
        intent: { label: 'browser-step' },
        context: { tier: 'confidential', service_bindings: [] },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'browser_step',
        },
        outcome_design: { outcome_ids: ['browser_step'], labels: [] },
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
          specialist_id: 'browser-operator',
          specialist_label: 'Browser Operator',
          conversation_agent: 'nerve-agent',
          team_roles: [],
        },
        authority: { requires_approval: false },
        learning: { reusable_refs: [] },
      },
      routingDecision: {
        kind: 'agent-routing-decision',
        source_text: '左下の承認ボタンを押して',
        intent_id: 'browser-step',
        mode: 'prompt',
        scope: 'single_artifact',
        autonomy: 'low',
        boundary_crossing: false,
        fanout: 'none',
        owner: 'browser-operator',
        artifact_count: 1,
        stop_condition: 'The response is ready as a single governed reply or artifact.',
        rationale: 'Lightweight browser step',
      },
      source: 'llm',
    } as any);

    expect(receiver).toBeUndefined();
  });

  it('keeps the governed provider manifests schema-valid', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/public/schemas/surface-provider-manifests.schema.json'),
    );
    const manifests = JSON.parse(
      safeReadFile(path.resolve(root, 'knowledge/public/governance/surface-provider-manifests.json'), {
        encoding: 'utf8',
      }) as string,
    );

    expect(validate(manifests)).toBe(true);
    expect(
      validate({
        version: '1.0.0',
        providers: {
          slack: manifests.providers.slack,
        },
      }),
    ).toBe(false);
  });
});
