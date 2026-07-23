import { describe, expect, it } from 'vitest';
import {
  buildIntentUseCaseScenario,
  validateIntentUseCaseScenario,
} from './intent-use-case-scenario.js';
import type { IntentUseCaseScenarioInput } from './intent-use-case-scenario.js';

function fixture(overrides: Partial<IntentUseCaseScenarioInput> = {}): IntentUseCaseScenarioInput {
  const input: IntentUseCaseScenarioInput = {
    input: {
      text: '既存の音声チャットを確認して',
      channel: 'terminal',
      locale: 'ja-JP',
      tier: 'confidential',
      serviceBindings: ['voice-runtime'],
    },
    packet: {
      kind: 'intent_resolution_packet',
      utterance: '既存の音声チャットを確認して',
      selected_intent_id: 'live-voice',
      selected_confidence: 0.91,
      selected_resolution: { shape: 'task_session', task_kind: 'voice_conversation' },
      candidates: [
        {
          intent_id: 'live-voice',
          confidence: 0.91,
          source: 'catalog',
          matched_keywords: ['音声チャット'],
          reasons: ['surface example match'],
          resolution: { shape: 'task_session', task_kind: 'voice_conversation' },
        },
      ],
    },
    selectedIntent: {
      id: 'live-voice',
      description: 'Use a governed realtime voice conversation.',
      risk_profile: 'review_required',
    },
    executionBrief: {
      kind: 'actuator-execution-brief',
      request_text: '既存の音声チャットを確認して',
      archetype_id: 'live-voice',
      confidence: 0.88,
      summary: 'Check the realtime voice conversation path.',
      target_actuators: ['voice-actuator'],
      deliverables: ['voice_session_result'],
      missing_inputs: ['audio_device'],
      readiness: 'needs_clarification',
      clarification_questions: [
        {
          id: 'audio_device',
          question: 'どのマイクとスピーカーを使いますか？',
          reason: 'The audio route is not specified.',
        },
      ],
    },
    intentContract: {
      kind: 'intent-contract',
      source_text: '既存の音声チャットを確認して',
      intent_id: 'live-voice',
      goal: {
        summary: 'Check the realtime voice conversation path.',
        success_condition: 'A voice conversation starts with the selected audio route.',
      },
      resolution: { execution_shape: 'task_session', task_type: 'voice_conversation' },
      required_inputs: ['audio_device'],
      outcome_ids: ['voice_session_result'],
      approval: { requires_approval: false },
      delivery_mode: 'one_shot',
      clarification_needed: true,
      confidence: 0.88,
      why: 'The request maps to the live voice intent.',
    },
    workLoop: {
      intent: { label: 'Realtime voice conversation' },
      context: { tier: 'confidential', service_bindings: ['voice-runtime'] },
      resolution: { execution_shape: 'task_session', task_type: 'voice_conversation' },
      workflow_design: {
        workflow_id: 'voice-conversation-default',
        pattern: 'stage_gated_delivery',
        stage: 'planning',
        phases: ['preflight', 'conversation', 'result'],
        rationale: 'Resolve audio readiness before starting the session.',
      },
      review_design: {
        review_mode: 'standard',
        required_gate_ids: ['CONTRACT_VALID'],
        all_gate_ids: ['CONTRACT_VALID'],
        rationale: 'Voice device routing needs an explicit readiness check.',
      },
      outcome_design: { outcome_ids: ['voice_session_result'], labels: ['Voice session result'] },
      process_design: {
        plan_outline: ['Resolve audio devices', 'Start the voice session', 'Report the result'],
        intake_requirements: ['audio_device'],
        operator_checklist: ['Confirm microphone consent'],
      },
      runtime_design: {
        owner_model: 'single_actor',
        assignment_policy: 'direct_specialist',
        coordination: { bus: 'none', channels: [] },
        memory: { store: 'none', scope: 'none', purpose: [] },
      },
      execution_boundary: {
        llm_zone: { allowed: ['interpret'], forbidden: ['execute'] },
        knowledge_zone: { owns: ['voice profile'] },
        compiler_zone: { responsibilities: ['compile scenario'] },
        executor_zone: { responsibilities: ['run voice session'] },
        rule: 'The compiler does not execute side effects.',
      },
      teaming: { team_roles: ['voice-operator'] },
      authority: { requires_approval: false },
      learning: { reusable_refs: [] },
    } as IntentUseCaseScenarioInput['workLoop'],
  };
  return {
    ...input,
    ...overrides,
  };
}

describe('intent use-case scenario', () => {
  it('converges intent resolution, contract, and work loop into a validated scenario', () => {
    const scenario = buildIntentUseCaseScenario(fixture());

    expect(scenario.kind).toBe('intent-use-case-scenario');
    expect(scenario.scenario_id).toBe('use-case-live-voice');
    expect(scenario.confidence).toBe(0.91);
    expect(scenario.resolution.workflow_id).toBe('voice-conversation-default');
    expect(scenario.steps.map((step) => step.action)).toEqual([
      'Resolve audio devices',
      'Start the voice session',
      'Report the result',
    ]);
    expect(scenario.handoff).toMatchObject({
      status: 'needs_clarification',
      next_action: 'clarify_inputs',
      missing_inputs: ['audio_device'],
    });
    expect(validateIntentUseCaseScenario(scenario)).toMatchObject({ valid: true });
  });

  it('selects approval and runtime handoffs before execution', () => {
    const approval = fixture({
      intentContract: {
        ...fixture().intentContract,
        required_inputs: [],
        approval: { requires_approval: true },
        clarification_needed: false,
      },
      executionBrief: {
        ...fixture().executionBrief,
        missing_inputs: [],
        readiness: 'fully_automatable',
      },
    });
    expect(buildIntentUseCaseScenario(approval).handoff.next_action).toBe('request_approval');

    const blocked = fixture({
      executionBrief: {
        ...fixture().executionBrief,
        missing_inputs: [],
        readiness: 'blocked_by_runtime',
      },
      intentContract: {
        ...fixture().intentContract,
        required_inputs: [],
        clarification_needed: false,
      },
    });
    expect(buildIntentUseCaseScenario(blocked).handoff).toMatchObject({
      status: 'blocked',
      next_action: 'resolve_runtime',
    });
  });
});
