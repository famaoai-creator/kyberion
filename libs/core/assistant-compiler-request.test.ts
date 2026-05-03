import { describe, expect, it } from 'vitest';
import {
  createAssistantCompilerRequest,
  normalizeAssistantCompilerResult,
  validateAssistantCompilerRequest,
} from './assistant-compiler-request.js';

describe('assistant compiler request', () => {
  it('creates a raw compiler request without local contract generation', () => {
    const { request, requestPath } = createAssistantCompilerRequest({
      source: { origin: 'cli', channel: 'run_intent' },
      sourceText: '勘定系システムの非機能要件定義書をパワーポイントで出力して',
      preferredProvider: 'gemini',
      preferredModel: 'gemini-2.5-pro',
      runtimeContext: { platform_id: 'imessage' },
    });

    const validation = validateAssistantCompilerRequest(request);
    expect(validation.valid).toBe(true);
    expect(request.delegation.mode).toBe('compile_intent');
    expect(request.delegation.preferred_provider).toBe('gemini');
    expect(request.expected_output.contract).toBe('intent-bundle');
    expect(request.context.runtime_context?.platform_id).toBe('imessage');
    expect(requestPath).toContain('/active/shared/tmp/assistant-compiler-requests/');
    expect(request.expected_output.write_back_path).toContain(
      '/active/shared/tmp/assistant-compiler-results/'
    );
  });

  it('normalizes loose sub-agent output into a governed compiler result', () => {
    const { request } = createAssistantCompilerRequest({
      source: { origin: 'cli', channel: 'run_intent' },
      sourceText: '勘定系システムの非機能要件定義書をパワーポイントで出力して',
    });

    const result = normalizeAssistantCompilerResult(request, {
      execution_brief: {
        kind: 'actuator-execution-brief',
        request_text: request.source_text,
        archetype_id: 'generate-presentation',
        confidence: 0.71,
        summary: '勘定系システム向けの非機能要件定義を整理する',
        user_facing_summary: '非機能要件定義をスライド化する',
        normalized_scope: ['presentation_deck'],
        target_actuators: ['presentation-outline-compiler', 'pptx-generator'],
        deliverables: ['artifact:pptx'],
        missing_inputs: ['source_material', 'audience', 'deck_size'],
        assumptions: ['Use governed defaults until clarified.'],
        clarification_questions: [
          {
            id: 'source_material',
            question: '参照すべき元資料はありますか?',
            reason: 'The request cannot be executed safely without this input.',
          },
        ],
        readiness: 'needs_clarification',
        readiness_reason: 'Missing inputs: source_material, audience, deck_size.',
        llm_touchpoints: [
          {
            stage: 'execution_brief',
            purpose: 'Extract the request into a governed execution brief',
            output_contract: 'actuator-execution-brief',
          },
        ],
        recommended_next_step: 'Collect the missing inputs before compiling the intent contract.',
      },
      intent_contract: {
        kind: 'assistant-compiler-request',
        source_text: request.source_text,
        intent_id: request.request_id,
        goal: '勘定系システム向けの非機能要件定義をPowerPoint形式の資料として出力する',
        resolution: 'generate-presentation / presentation_deck を優先',
        required_inputs: ['source_material', 'audience', 'deck_size'],
        outcome_ids: ['presentation_deck'],
        approval: 'required',
        clarification_needed: true,
        confidence: 0.64,
        why: 'Missing source material and audience.',
      },
      work_loop: [
        '確認: 参照資料、想定読者、枚数、制約を収集する',
        '構成: 非機能要件をカテゴリ別に整理してスライド骨子を作る',
      ],
      clarification_packet: {
        questions: ['参照すべき元資料はありますか?', '想定読者は誰ですか?'],
      },
      source: {
        compiler: 'assistant-subagent',
      },
    });

    expect(result.kind).toBe('assistant-compiler-result');
    expect(result.execution_brief.kind).toBe('actuator-execution-brief');
    expect(result.execution_brief.target_actuators).toContain('pptx-generator');
    expect(result.intent_contract.kind).toBe('intent-contract');
    expect(result.intent_contract.intent_id).toBe(request.request_id);
    expect(result.intent_contract.resolution.execution_shape).toBe('task_session');
    expect(result.intent_contract.resolution.task_type).toBe('presentation_deck');
    expect(result.intent_contract.delivery_mode).toBe('managed_program');
    expect(result.intent_contract.outcome_ids).toEqual(['artifact:pptx']);
    expect(result.work_loop.process_design.plan_outline[0]).toContain('確認');
    expect(result.clarification_packet?.interaction_type).toBe('clarification');
  });
});
