import { beforeEach, describe, expect, it, vi } from 'vitest';

// SO-05: unlike intent-contract.test.ts (which always supplies an explicit
// `askFn` and therefore never exercises `defaultAsk`), this file isolates
// the no-askFn path — the one real callers (including the surface
// conversation front) actually take — to prove `model_tier` reaches
// `getReasoningBackend().prompt()`.
const promptMock = vi.fn();

vi.mock('./reasoning-backend.js', () => ({
  getReasoningBackend: () => ({ prompt: promptMock }),
}));

import { compileUserIntentFlow } from './intent-contract.js';

const EXECUTION_BRIEF_JSON = JSON.stringify({
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
});

const INTENT_CONTRACT_JSON = JSON.stringify({
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
});

const WORK_LOOP_JSON = JSON.stringify({
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
    coordination: { bus: 'none', channels: [] },
    memory: { store: 'none', scope: 'none', purpose: [] },
  },
  execution_boundary: {
    llm_zone: {
      allowed: ['draft_content_within_governed_slots'],
      forbidden: ['override_governed_structure'],
    },
    knowledge_zone: { owns: ['intent definitions'] },
    compiler_zone: { responsibilities: ['map_intent_to_governed_execution_shape'] },
    executor_zone: { responsibilities: ['perform_governed_execution'] },
    rule: 'LLM drafts within governed slots; compiler and executor remain deterministic',
  },
  teaming: {
    specialist_id: 'document-specialist',
    specialist_label: 'Document Specialist',
    conversation_agent: 'nerve-agent',
    team_roles: ['planner'],
  },
  authority: { requires_approval: false },
  learning: { reusable_refs: [] },
});

describe('intent-contract defaultAsk model_tier threading (SO-05)', () => {
  beforeEach(() => {
    promptMock.mockReset();
  });

  it('threads options.model_tier into every getReasoningBackend().prompt() call when no askFn is supplied', async () => {
    const responses = [EXECUTION_BRIEF_JSON, INTENT_CONTRACT_JSON, WORK_LOOP_JSON];
    promptMock.mockImplementation(async () => responses.shift() || '');

    const flow = await compileUserIntentFlow(
      { text: '提案資料を作って', correlationId: 'corr-model-tier-001' },
      { model_tier: 'fast' }
    );

    expect(flow.source).toBe('llm');
    expect(promptMock).toHaveBeenCalledTimes(3);
    for (const call of promptMock.mock.calls) {
      expect(call[1]).toEqual({ model_tier: 'fast' });
    }
  });

  it('does not pass a model_tier option when none is declared (backend default, unchanged behavior)', async () => {
    const responses = [EXECUTION_BRIEF_JSON, INTENT_CONTRACT_JSON, WORK_LOOP_JSON];
    promptMock.mockImplementation(async () => responses.shift() || '');

    await compileUserIntentFlow(
      { text: '見積もりを作成して', correlationId: 'corr-model-tier-002' },
      {}
    );

    expect(promptMock).toHaveBeenCalledTimes(3);
    for (const call of promptMock.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });
});
