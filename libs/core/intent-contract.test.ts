import { describe, expect, it } from 'vitest';
import { compileUserIntentFlow, deriveIntentDeliveryDecision, formatClarificationPacket, inferGovernedDeliveryMode, resolveIntentCompilerTarget } from './intent-contract.js';

describe('intent-contract compiler', () => {
  it('accepts LLM-produced contract and work loop JSON when valid', async () => {
    const responses = [
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
      { text: '提案資料を作って' },
      {
        askFn: async () => responses.shift() || '',
      },
    );

    expect(flow.source).toBe('llm');
    expect(flow.intentContract.intent_id).toBe('generate-presentation');
    expect(flow.workLoop.resolution.task_type).toBe('presentation_deck');
    expect(flow.clarificationPacket).toBeUndefined();
  });

  it('falls back to deterministic classification and formats clarification packets', async () => {
    const flow = await compileUserIntentFlow(
      { text: 'Webサービスを作って' },
      {
        askFn: async () => 'not json',
      },
    );

    expect(flow.source).toBe('fallback');
    expect(flow.intentContract.intent_id).toBe('bootstrap-project');
    expect(flow.clarificationPacket?.interaction_type).toBe('clarification');
    expect(formatClarificationPacket(flow.clarificationPacket!)).toContain('project brief');
  });

  it('marks durable requests as managed programs for dispatcher decisions', async () => {
    const flow = await compileUserIntentFlow(
      { text: 'この要件定義を長期的に継続改善しながら運行管理したい' },
      {
        askFn: async () => 'not json',
      },
    );

    const decision = deriveIntentDeliveryDecision(flow.intentContract);
    expect(flow.intentContract.delivery_mode).toBe('managed_program');
    expect(decision.shouldStartMission).toBe(true);
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

  it('infers delivery mode from governed rules', () => {
    expect(inferGovernedDeliveryMode('この要件定義を長期的に継続改善したい', 'task_session', [])).toBe('managed_program');
    expect(inferGovernedDeliveryMode('提案資料を作って', 'task_session', [])).toBe('one_shot');
  });
});
