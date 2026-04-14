import { describe, expect, it } from 'vitest';
import { createAssistantDelegationRequest, validateAssistantDelegationRequest } from './delegation-request.js';

describe('assistant delegation request', () => {
  it('creates a governed delegation artifact with provider preferences', () => {
    const { request, requestPath } = createAssistantDelegationRequest({
      source: { origin: 'cli', channel: 'run_intent' },
      sourceText: '提案資料を作って',
      intentContract: {
        kind: 'intent-contract',
        source_text: '提案資料を作って',
        intent_id: 'generate-presentation',
        goal: {
          summary: 'Create a presentation deck',
          success_condition: 'A governed draft deck is prepared.',
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
        confidence: 0.91,
        why: 'The request maps to a governed presentation workflow.',
      },
      workLoop: {
        intent: { label: 'generate-presentation' },
        context: {
          tier: 'confidential',
          service_bindings: [],
        },
        resolution: {
          execution_shape: 'task_session',
          task_type: 'presentation_deck',
        },
        outcome_design: {
          outcome_ids: ['artifact:pptx'],
          labels: ['Presentation artifact'],
        },
        process_design: {
          plan_outline: ['collect inputs', 'draft outline', 'generate artifact'],
          intake_requirements: [],
          operator_checklist: ['confirm output destination'],
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
          rule: 'LLM drafts within governed slots.',
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
      },
      preferredProvider: 'claude',
      preferredModel: 'sonnet',
      allowedProviders: ['claude', 'codex', 'gemini'],
    });

    const validation = validateAssistantDelegationRequest(request);
    expect(validation.valid).toBe(true);
    expect(request.delegation.preferred_provider).toBe('claude');
    expect(request.delegation.allowed_providers).toEqual(['claude', 'codex', 'gemini']);
    expect(requestPath).toContain('/active/shared/tmp/delegation-requests/');
    expect(request.expected_output.write_back_path).toContain('/active/shared/tmp/delegation-results/');
  });
});
