import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from '@agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  compileUserIntentFlow,
  deriveAgentRoutingDecision,
  deriveIntentDeliveryDecision,
  formatClarificationPacket,
  formatClarificationPacketConcise,
  inferGovernedDeliveryMode,
  resolveIntentCompilerTarget,
} from './intent-contract.js';

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('intent-contract compiler', () => {
  it('accepts LLM-produced contract and work loop JSON when valid', async () => {
    const responses = [
      JSON.stringify({
        kind: 'actuator-execution-brief',
        request_text: '提案資料を作って',
        archetype_id: 'generate-presentation',
        confidence: 0.84,
        summary: '提案資料の作成',
        user_facing_summary: '提案用のスライドを作る',
        normalized_scope: ['presentation_deck'],
        target_actuators: ['presentation-outline-compiler', 'pptx-generator'],
        deliverables: ['artifact:pptx'],
        missing_inputs: [],
        assumptions: ['Use standard proposal defaults.'],
        clarification_questions: [],
        readiness: 'fully_automatable',
        readiness_reason: 'No missing inputs.',
        llm_touchpoints: [
          {
            stage: 'execution_brief',
            purpose: 'Extract the request into a governed execution brief',
            output_contract: 'actuator-execution-brief',
          },
        ],
        recommended_next_step: 'Compile the intent contract and work loop.',
      }),
      JSON.stringify({
        kind: 'intent-contract',
        source_text: '提案資料を作って',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Create a presentation deck',
          success_condition: 'A governed PPTX draft is prepared.',
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
        confidence: 0.92,
        why: 'The request is a governed presentation generation task.',
      }),
      JSON.stringify({
        intent: { label: 'generate-presentation' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'presentation_deck',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
          rationale: 'Default workflow for straightforward bounded work.',
        },
        review_design: {
          review_mode: 'standard',
          required_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          all_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          rationale: 'Standard mode requires contract and QA gates.',
        },
        outcome_design: {
          outcome_ids: ['artifact:pptx'],
          labels: ['Presentation artifact'],
        },
        process_design: {
          plan_outline: ['collect inputs', 'draft outline', 'generate artifact'],
          intake_requirements: [],
          operator_checklist: ['confirm the governed output path'],
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
          specialist_id: 'document-specialist',
          specialist_label: 'Document Specialist',
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

    const flow = await compileUserIntentFlow(
      { text: '提案資料を作って', correlationId: 'corr-intent-contract-001' },
      {
        askFn: async () => responses.shift() || '',
      }
    );

    expect(flow.source).toBe('llm');
    expect(flow.executionBrief.kind).toBe('actuator-execution-brief');
    expect(flow.intentContract.intent_id).toBe('generate-presentation');
    expect(flow.intentContract.correlation_id).toBe('corr-intent-contract-001');
    expect(flow.correlationId).toBe('corr-intent-contract-001');
    expect(flow.workLoop.resolution.task_type).toBe('presentation_deck');
    expect(flow.routingDecision?.mode).toBe('subagent');
    expect(flow.routingDecision?.owner).toBe('document-specialist');
    expect(flow.routingDecision?.delegates).toContain('nerve-agent');
    expect(flow.clarificationPacket).toBeUndefined();
  });

  it('attaches capability bundle ids when the resolved intent maps to a governed bundle', async () => {
    const responses = [
      JSON.stringify({
        kind: 'actuator-execution-brief',
        request_text: 'Open OpenAI docs',
        archetype_id: 'open-site',
        confidence: 0.81,
        summary: 'Open a site in the governed browser surface',
        user_facing_summary: 'Open the requested site',
        normalized_scope: ['browser_session'],
        target_actuators: ['browser-actuator'],
        deliverables: ['browser_navigation'],
        missing_inputs: [],
        assumptions: ['Use the requested browser destination.'],
        clarification_questions: [],
        readiness: 'fully_automatable',
        readiness_reason: 'The browser destination is known.',
        llm_touchpoints: [
          {
            stage: 'execution_brief',
            purpose: 'Extract the request into a governed execution brief',
            output_contract: 'actuator-execution-brief',
          },
        ],
        recommended_next_step: 'Compile the intent contract and work loop.',
      }),
      JSON.stringify({
        kind: 'intent-contract',
        source_text: 'Open OpenAI docs',
        intent_id: 'open-site',
        goal: {
          summary: 'Open the requested website',
          success_condition: 'The requested site is opened in the governed browser surface.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'browser_navigation',
        },
        required_inputs: [],
        outcome_ids: ['browser_navigation'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.88,
        why: 'The request is a governed browser navigation task.',
      }),
      JSON.stringify({
        intent: { label: 'open-site' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'browser_navigation',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
          rationale: 'Default workflow for straightforward bounded work.',
        },
        review_design: {
          review_mode: 'standard',
          required_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          all_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          rationale: 'Standard mode requires contract and QA gates.',
        },
        outcome_design: {
          outcome_ids: ['browser_navigation'],
          labels: ['Browser navigation'],
        },
        process_design: {
          plan_outline: ['resolve destination', 'open browser', 'confirm page'],
          intake_requirements: [],
          operator_checklist: ['confirm the governed browser path'],
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
          specialist_id: 'browser-operator',
          specialist_label: 'Browser Operator',
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

    const flow = await compileUserIntentFlow(
      { text: 'Open OpenAI docs' },
      {
        askFn: async () => responses.shift() || '',
      }
    );

    expect(flow.intentContract.intent_id).toBe('open-site');
    expect(flow.intentContract.capability_bundle_id).toBe('browser-exploration-governed');
    expect(flow.routingDecision?.mode).toBe('prompt');
    expect(flow.routingDecision?.fanout).toBe('none');
  });

  it('attaches execution profile ids when the resolved intent declares a governed profile', async () => {
    const responses = [
      JSON.stringify({
        kind: 'actuator-execution-brief',
        request_text: 'このテキストを私の声で読んで',
        archetype_id: 'speak-with-my-voice',
        confidence: 0.86,
        summary: 'Generate speech in the operator voice',
        user_facing_summary: 'Read the text in the cloned voice',
        normalized_scope: ['voice_artifact'],
        target_actuators: ['voice-actuator'],
        deliverables: ['artifact:audio'],
        missing_inputs: [],
        assumptions: ['Use the local voice engine.'],
        clarification_questions: [],
        readiness: 'fully_automatable',
        readiness_reason: 'The speech request is fully specified.',
        llm_touchpoints: [
          {
            stage: 'execution_brief',
            purpose: 'Extract the request into a governed execution brief',
            output_contract: 'actuator-execution-brief',
          },
        ],
        recommended_next_step: 'Compile the intent contract and work loop.',
      }),
      JSON.stringify({
        kind: 'intent-contract',
        source_text: 'このテキストを私の声で読んで',
        intent_id: 'speak-with-my-voice',
        goal: {
          summary: 'Generate speech in the operator voice',
          success_condition: 'A governed voice artifact is prepared.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'voice_speech',
        },
        required_inputs: [],
        outcome_ids: ['artifact:audio'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.91,
        why: 'The request is a governed voice generation task.',
      }),
      JSON.stringify({
        intent: { label: 'speak-with-my-voice' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'voice_speech',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
          rationale: 'Default workflow for straightforward bounded work.',
        },
        review_design: {
          review_mode: 'standard',
          required_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          all_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          rationale: 'Standard mode requires contract and QA gates.',
        },
        outcome_design: {
          outcome_ids: ['artifact:audio'],
          labels: ['Voice artifact'],
        },
        process_design: {
          plan_outline: ['collect input text', 'synthesize speech', 'publish audio artifact'],
          intake_requirements: [],
          operator_checklist: ['confirm the governed voice path'],
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
          specialist_id: 'document-specialist',
          specialist_label: 'Document Specialist',
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

    const flow = await compileUserIntentFlow(
      { text: 'このテキストを私の声で読んで' },
      {
        askFn: async () => responses.shift() || '',
      }
    );

    expect(flow.source).toBe('llm');
    expect(flow.intentContract.intent_id).toBe('speak-with-my-voice');
    expect(flow.intentContract.execution_profile_id).toBe('voice-speak-with-my-voice-local-say');
    expect(flow.intentContract.capability_bundle_id).toBe('voice-speech-governed');
  });

  it('keeps lightweight browser steps on the prompt path', async () => {
    const flow = await compileUserIntentFlow(
      { text: '左下の承認ボタンを押して' },
      {
        askFn: async () => 'not json',
      }
    );

    expect(flow.intentContract.intent_id).toBe('general-request');
    expect(flow.intentContract.resolution.execution_shape).toBe('task_session');
    expect(flow.routingDecision?.mode).toBe('subagent');
    expect(flow.routingDecision?.boundary_crossing).toBe(false);
  });

  it('falls back to deterministic classification and formats clarification packets', async () => {
    const flow = await compileUserIntentFlow(
      { text: 'Webサービスを作って' },
      {
        askFn: async () => 'not json',
      }
    );

    expect(flow.source).toBe('fallback');
    expect(flow.executionBrief.kind).toBe('actuator-execution-brief');
    expect(flow.intentContract.intent_id).toBe('bootstrap-project');
    expect(flow.clarificationPacket?.interaction_type).toBe('clarification');
    expect(flow.clarificationPacket?.readiness).toBe('needs_clarification');
    expect(formatClarificationPacket(flow.clarificationPacket!)).toContain('project_brief');
  });

  it('falls back to the meeting operations path when the request is clearly about a meeting', async () => {
    const flow = await compileUserIntentFlow(
      { text: 'Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる' },
      {
        askFn: async () => 'not json',
      }
    );

    expect(flow.executionBrief.archetype_id).toBe('meeting-operations');
    expect(flow.executionBrief.missing_inputs).toEqual([
      'meeting_url',
      'meeting_role_boundary',
      'meeting_purpose',
    ]);
    expect(flow.intentContract.resolution.task_type).toBe('meeting_operations');
    expect(flow.intentContract.delivery_mode).toBe('managed_program');
  });

  it('falls back to the schedule coordination path when the request is about general schedule adjustment', async () => {
    const flow = await compileUserIntentFlow(
      { text: 'スケジュールを調整して' },
      {
        askFn: async () => 'not json',
      }
    );

    expect(flow.executionBrief.archetype_id).toBe('schedule-coordination');
    expect(flow.executionBrief.missing_inputs).toEqual([
      'schedule_scope',
      'date_range',
      'fixed_constraints',
      'calendar_action_boundary',
    ]);
    expect(flow.intentContract.intent_id).toBe('schedule-coordination');
    expect(flow.intentContract.resolution.task_type).toBe('service_operation');
    expect(flow.intentContract.delivery_mode).toBe('managed_program');
    expect(flow.routingDecision?.mode).toBe('coordination');
    expect(flow.routingDecision?.boundary_crossing).toBe(true);
  });

  it('treats read-only agenda requests as direct replies with a calendar summary outcome', async () => {
    const flow = await compileUserIntentFlow(
      { text: '来週の予定教えて' },
      {
        askFn: async () => 'not json',
      }
    );

    expect(flow.intentContract.intent_id).toBe('schedule-read-agenda');
    expect(flow.intentContract.resolution.execution_shape).toBe('direct_reply');
    expect(flow.intentContract.outcome_ids).toContain('calendar_agenda_summary');
    expect(flow.intentContract.clarification_needed).toBe(false);
    expect(flow.intentContract.delivery_mode).toBe('one_shot');
  });

  it('marks durable requests as managed programs for dispatcher decisions', async () => {
    const flow = await compileUserIntentFlow(
      { text: 'この要件定義を長期的に継続改善しながら運行管理したい' },
      {
        askFn: async () => 'not json',
      }
    );

    const decision = deriveIntentDeliveryDecision(flow.intentContract);
    expect(flow.intentContract.delivery_mode).toBe('managed_program');
    expect(decision.shouldStartMission).toBe(true);
  });

  it('derives a routing decision from a governed intent contract and work loop', () => {
    const decision = deriveAgentRoutingDecision(
      {
        kind: 'intent-contract',
        source_text: '今週の進捗レポートを作って',
        intent_id: 'generate-report',
        goal: {
          summary: 'Create a report',
          success_condition: 'A governed report draft is prepared.',
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'report_document',
        },
        required_inputs: [],
        outcome_ids: ['artifact:docx'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.88,
        why: 'Governed report request.',
      },
      {
        intent: {
          label: 'generate-report',
        },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'report_document',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution'],
          rationale: 'Default workflow.',
        },
        review_design: {
          review_mode: 'standard',
          required_gate_ids: ['CONTRACT_VALID'],
          all_gate_ids: ['CONTRACT_VALID'],
          rationale: 'Standard review path.',
        },
        outcome_design: {
          outcome_ids: ['artifact:docx'],
          labels: ['Report'],
        },
        process_design: {
          plan_outline: ['collect context', 'draft report', 'review report'],
          intake_requirements: [],
          operator_checklist: [],
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
            allowed: [],
            forbidden: [],
          },
          knowledge_zone: {
            owns: [],
          },
          compiler_zone: {
            responsibilities: [],
          },
          executor_zone: {
            responsibilities: [],
          },
          rule: 'bounded',
        },
        teaming: {
          specialist_id: 'document-specialist',
          specialist_label: 'Document Specialist',
          conversation_agent: 'nerve-agent',
          team_roles: ['planner'],
        },
        authority: {
          requires_approval: false,
        },
        learning: {
          reusable_refs: [],
        },
      }
    );

    expect(decision.mode).toBe('subagent');
    expect(decision.scope).toBe('single_artifact');
    expect(decision.fanout).toBe('review');
    expect(decision.owner).toBe('document-specialist');
  });

  it('asks for human confirmation when managed delivery is inferred on a task session', () => {
    const decision = deriveIntentDeliveryDecision({
      kind: 'intent-contract',
      source_text: 'この定義書を継続改善しながら進めたい',
      intent_id: 'refine-definition',
      goal: {
        summary: 'Refine the definition document',
        success_condition: 'The document is maintained over time.',
      },
      resolution: {
        execution_shape: 'task_session',
        task_type: 'document_work',
      },
      required_inputs: [],
      outcome_ids: ['artifact:doc'],
      approval: {
        requires_approval: false,
      },
      delivery_mode: 'managed_program',
      clarification_needed: false,
      confidence: 0.8,
      why: 'Durable improvement is requested.',
    });

    expect(decision.askHumanToConfirm).toBe(true);
    expect(decision.shouldBootstrapProject).toBe(true);
    expect(decision.shouldStartMission).toBe(true);
    expect(decision.shouldDeliverDirectOutcome).toBe(false);
  });

  it('resolves generic provider and model hints without codex-only defaults', () => {
    const target = resolveIntentCompilerTarget({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    });

    expect(target).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
    });
  });

  it('selects the policy-routed compiler model for the intent when no override is provided', () => {
    const target = resolveIntentCompilerTarget({
      selectedIntent: {
        id: 'review-analysis-report',
        category: 'analysis',
        description: 'Review and compare the analysis report for correctness',
        execution_shape: 'task_session',
        risk_profile: 'high_stakes',
        resolution: { shape: 'task_session', task_kind: 'analysis' },
      } as any,
      discoveredProviders: [
        { provider: 'codex', installed: true, healthy: true },
        { provider: 'claude', installed: true, healthy: true },
        { provider: 'gemini', installed: false, healthy: false },
      ] as any,
      modelRegistry: {
        version: '1.0.0',
        default_model_id: 'openai:gpt-5.5',
        models: [
          {
            model_id: 'openai:gpt-5.5',
            provider: 'openai',
            family: 'gpt-5',
            status: 'approved',
            tier: 'large',
            execution_tier: 'deep',
            reasoning_confidence: 'high',
            role_fit: {
              intent_compiler: 'primary',
              surface_agent: 'primary',
              analysis: 'primary',
              coding: 'primary',
            },
            capability_tags: ['multi_step_reasoning'],
            cost_band: 'high',
            latency_band: 'medium',
          },
          {
            model_id: 'anthropic:claude-sonnet-4.5',
            provider: 'anthropic',
            family: 'claude-sonnet',
            status: 'candidate',
            tier: 'large',
            execution_tier: 'deep',
            reasoning_confidence: 'high',
            role_fit: {
              intent_compiler: 'secondary',
              surface_agent: 'secondary',
              analysis: 'primary',
              coding: 'secondary',
            },
            capability_tags: ['strategy_review', 'long_context_analysis'],
            cost_band: 'high',
            latency_band: 'medium',
          },
        ],
      } as any,
    });

    expect(target).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    });
  });

  it('infers delivery mode from governed rules', () => {
    expect(
      inferGovernedDeliveryMode('この要件定義を長期的に継続改善したい', 'task_session', [])
    ).toBe('managed_program');
    expect(
      inferGovernedDeliveryMode('6/6-6/8で沖縄のホテルを探して', 'task_session', [
        'booking_path_preference',
      ])
    ).toBe('managed_program');
    expect(
      inferGovernedDeliveryMode('今夜のレストランを予約したい', 'task_session', [
        'booking_path_preference',
      ])
    ).toBe('managed_program');
    expect(
      inferGovernedDeliveryMode('歯医者の予約を取りたい', 'task_session', [
        'booking_path_preference',
      ])
    ).toBe('managed_program');
    expect(inferGovernedDeliveryMode('提案資料を作って', 'task_session', [])).toBe('one_shot');
  });

  it('emits intent-contract payloads that satisfy the schema', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/intent-contract.schema.json')
    );

    expect(
      validate({
        kind: 'intent-contract',
        source_text: '提案資料を作って',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Create a presentation deck',
          success_condition: 'A governed PPTX draft is prepared.',
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
        confidence: 0.92,
        why: 'The request is a governed presentation generation task.',
      })
    ).toBe(true);
  });

  it('rejects invalid intent-contract payloads', () => {
    const root = process.cwd();
    const ajv = new AjvCtor({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/intent-contract.schema.json')
    );

    expect(
      validate({
        kind: 'intent-contract',
        source_text: '提案資料を作って',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Create a presentation deck',
          success_condition: 'A governed PPTX draft is prepared.',
        },
        resolution: {
          execution_shape: 'invalid_shape',
        },
        required_inputs: [],
        outcome_ids: ['artifact:pptx'],
        approval: {
          requires_approval: false,
        },
        delivery_mode: 'one_shot',
        clarification_needed: false,
        confidence: 0.92,
        why: 'The request is a governed presentation generation task.',
      })
    ).toBe(false);
  });

  it('emits trace metadata for successful llm compilation and fallback paths', async () => {
    const events: Array<{ name: string; attributes?: Record<string, string | number | boolean> }> =
      [];
    const trace = {
      addEvent(name: string, attributes?: Record<string, string | number | boolean>) {
        events.push({ name, attributes });
      },
    };
    const responses = [
      JSON.stringify({
        kind: 'actuator-execution-brief',
        request_text: '提案資料を作って',
        archetype_id: 'generate-presentation',
        confidence: 0.84,
        summary: '提案資料の作成',
        user_facing_summary: '提案用のスライドを作る',
        normalized_scope: ['presentation_deck'],
        target_actuators: ['presentation-outline-compiler', 'pptx-generator'],
        deliverables: ['artifact:pptx'],
        missing_inputs: [],
        assumptions: ['Use standard proposal defaults.'],
        clarification_questions: [],
        readiness: 'fully_automatable',
        readiness_reason: 'No missing inputs.',
        llm_touchpoints: [
          {
            stage: 'execution_brief',
            purpose: 'Extract the request into a governed execution brief',
            output_contract: 'actuator-execution-brief',
          },
        ],
        recommended_next_step: 'Compile the intent contract and work loop.',
      }),
      JSON.stringify({
        kind: 'intent-contract',
        source_text: '提案資料を作って',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Create a presentation deck',
          success_condition: 'A governed PPTX draft is prepared.',
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
        confidence: 0.92,
        why: 'The request is a governed presentation generation task.',
      }),
      JSON.stringify({
        intent: { label: 'generate-presentation' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'presentation_deck',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
          rationale: 'Default workflow for straightforward bounded work.',
        },
        review_design: {
          review_mode: 'standard',
          required_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          all_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          rationale: 'Standard mode requires contract and QA gates.',
        },
        outcome_design: {
          outcome_ids: ['artifact:pptx'],
          labels: ['Presentation artifact'],
        },
        process_design: {
          plan_outline: ['collect inputs', 'draft outline', 'generate artifact'],
          intake_requirements: [],
          operator_checklist: ['confirm the governed output path'],
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
          specialist_id: 'document-specialist',
          specialist_label: 'Document Specialist',
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

    const llmFlow = await compileUserIntentFlow(
      { text: '提案資料を作って' },
      {
        askFn: async () => responses.shift() || '',
        trace,
      }
    );

    expect(llmFlow.source).toBe('llm');
    expect(events[0]?.name).toBe('intent_compilation.completed');
    expect(events[0]?.attributes?.source).toBe('llm');
    expect(events[0]?.attributes?.fallback_reason).toBe('none');
    expect(events[0]?.attributes?.reasoning_level).toBe(llmFlow.reasoningDecision?.level);
    expect(events[0]?.attributes?.recommended_model_id).toBe('openai:gpt-5.6-sol');
    expect(events[0]?.attributes?.model_route_status).toBe('shadow');

    events.length = 0;

    const mismatchFlow = await compileUserIntentFlow(
      {
        text: '提案資料を作って',
        resolutionPacket: {
          kind: 'intent_resolution_packet',
          utterance: '提案資料を作って',
          selected_intent_id: 'generate-presentation',
          selected_confidence: 0.91,
          selected_resolution: {
            shape: 'direct_reply',
            task_kind: 'presentation_deck',
          },
          candidates: [],
        },
      },
      {
        askFn: async () => responses.shift() || '',
        trace,
      }
    );

    expect(mismatchFlow.intentContract.resolution.execution_shape).toBe('project_bootstrap');
    expect(events[0]?.attributes?.shape_disagreement).toBe(true);
    expect(events[0]?.attributes?.selected_resolution_shape).toBe('direct_reply');
    expect(events[0]?.attributes?.contract_execution_shape).toBe('project_bootstrap');

    events.length = 0;

    const greetingFlow = await compileUserIntentFlow(
      { text: 'こんにちは' },
      {
        askFn: async () => {
          throw new Error('should not be called');
        },
        trace,
      }
    );

    expect(greetingFlow.source).toBe('fallback');
    expect(events[0]?.attributes?.fallback_reason).toBe('simple_greeting');
    expect(events[0]?.attributes?.source).toBe('fallback');

    events.length = 0;

    const invalidJsonFlow = await compileUserIntentFlow(
      { text: '提案資料を作って' },
      {
        askFn: async () => 'not json',
        trace,
      }
    );

    expect(invalidJsonFlow.source).toBe('fallback');
    expect(events[0]?.attributes?.fallback_reason).toBe('execution_brief_invalid');
    expect(events[0]?.attributes?.source).toBe('fallback');

    events.length = 0;

    const backendErrorFlow = await compileUserIntentFlow(
      { text: '提案資料を作って' },
      {
        askFn: async () => {
          throw new Error('backend unavailable');
        },
        trace,
      }
    );

    expect(backendErrorFlow.source).toBe('fallback');
    expect(events[0]?.attributes?.fallback_reason).toBe('backend_error');
    expect(events[0]?.attributes?.source).toBe('fallback');
  });

  it('keeps askFn call count and order unchanged', async () => {
    const responses = [
      JSON.stringify({
        kind: 'actuator-execution-brief',
        request_text: '提案資料を作って',
        archetype_id: 'generate-presentation',
        confidence: 0.84,
        summary: '提案資料の作成',
        user_facing_summary: '提案用のスライドを作る',
        normalized_scope: ['presentation_deck'],
        target_actuators: ['presentation-outline-compiler', 'pptx-generator'],
        deliverables: ['artifact:pptx'],
        missing_inputs: [],
        assumptions: ['Use standard proposal defaults.'],
        clarification_questions: [],
        readiness: 'fully_automatable',
        readiness_reason: 'No missing inputs.',
        llm_touchpoints: [],
        recommended_next_step: 'Compile the intent contract and work loop.',
      }),
      JSON.stringify({
        kind: 'intent-contract',
        source_text: '提案資料を作って',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Create a presentation deck',
          success_condition: 'A governed PPTX draft is prepared.',
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
        confidence: 0.92,
        why: 'The request is a governed presentation generation task.',
      }),
      JSON.stringify({
        intent: { label: 'generate-presentation' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'presentation_deck',
        },
        workflow_design: {
          workflow_id: 'single-track-default',
          pattern: 'single_track_execution',
          stage: 'planning',
          phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
          rationale: 'Default workflow for straightforward bounded work.',
        },
        review_design: {
          review_mode: 'standard',
          required_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          all_gate_ids: ['CONTRACT_VALID', 'QA_READY'],
          rationale: 'Standard mode requires contract and QA gates.',
        },
        outcome_design: {
          outcome_ids: ['artifact:pptx'],
          labels: ['Presentation artifact'],
        },
        process_design: {
          plan_outline: ['collect inputs', 'draft outline', 'generate artifact'],
          intake_requirements: [],
          operator_checklist: ['confirm the governed output path'],
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
          specialist_id: 'document-specialist',
          specialist_label: 'Document Specialist',
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
    const askFn = vi.fn(async () => responses.shift() || '');

    await compileUserIntentFlow({ text: '提案資料を作って' }, { askFn });

    expect(askFn).toHaveBeenCalledTimes(3);
    expect(askFn.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('Execution Brief Compiler'),
      expect.stringContaining('Intent Contract Compiler'),
      expect.stringContaining('Work Loop Compiler'),
    ]);
  });
});

describe('formatClarificationPacketConcise', () => {
  const packet: any = {
    kind: 'operator-interaction-packet',
    interaction_type: 'clarification',
    headline: 'More context required',
    summary: 'Join a meeting as proxy',
    questions: [
      { id: 'meeting_url', question: 'What is the meeting URL?', reason: 'Needed to join.' },
      { id: 'meeting_purpose', question: 'What is the meeting purpose?', reason: 'Sets role.' },
    ],
    suggested_response_style: 'clarify-first',
  };

  it('shows only the first question in English', () => {
    const out = formatClarificationPacketConcise(packet, { locale: 'en' });
    expect(out).toContain('meeting_url');
    expect(out).toContain('What is the meeting URL?');
    expect(out).toContain('(+ 1 more)');
    expect(out).not.toContain('meeting_purpose');
  });

  it('shows the first question in Japanese', () => {
    const out = formatClarificationPacketConcise(packet, { locale: 'ja' });
    expect(out).toContain('meeting_url');
    expect(out).toContain('次に必要な情報');
    expect(out).toContain('（他 1 件）');
    expect(out).not.toContain('meeting_purpose');
  });

  it('shows no-more-inputs message when questions list is empty', () => {
    const emptyPacket = { ...packet, questions: [] };
    const en = formatClarificationPacketConcise(emptyPacket, { locale: 'en' });
    const ja = formatClarificationPacketConcise(emptyPacket, { locale: 'ja' });
    expect(en).toContain('Ready to proceed');
    expect(ja).toContain('不足している情報はありません');
  });

  it('shows no "(+ N more)" hint when there is only one question', () => {
    const singlePacket = { ...packet, questions: [packet.questions[0]] };
    const out = formatClarificationPacketConcise(singlePacket, { locale: 'en' });
    expect(out).not.toContain('more');
    expect(out).toContain('meeting_url');
  });

  it('includes reason when present', () => {
    const out = formatClarificationPacketConcise(packet, { locale: 'en' });
    expect(out).toContain('Needed to join.');
  });
});
