import {
  compileUserIntentFlow,
  logger,
  safeUnlinkSync,
  pathResolver
} from '@agent/core';

const CACHE_FILE = pathResolver.shared('runtime/intent-flow-cache.json');

async function runTrial(trialName: string, inputText: string, clearCacheBefore: boolean) {
  if (clearCacheBefore) {
    logger.info(`[${trialName}] Clearing cache at ${CACHE_FILE}...`);
    try {
      safeUnlinkSync(CACHE_FILE);
      logger.info(`[${trialName}] Cache cleared successfully.`);
    } catch (err: any) {
      logger.warn(`[${trialName}] Failed to clear cache: ${err.message}`);
    }
  }

  let llmCalls = 0;
  const startTime = Date.now();

  const options = {
    tier: 'public' as const,
    askFn: async (prompt: string): Promise<string> => {
      llmCalls++;
      logger.info(`  -> [${trialName}] Intercepted LLM call #${llmCalls} in compiler...`);
      
      const promptLower = prompt.toLowerCase();
      
      // Mock Stage 1: ActuatorExecutionBrief
      if (promptLower.includes('execution brief compiler')) {
        logger.info(`  -> [${trialName}] Mocking ActuatorExecutionBrief Response...`);
        return JSON.stringify({
          kind: 'actuator-execution-brief',
          request_text: inputText,
          archetype_id: 'inspect-workspace-surfaces',
          confidence: 0.9,
          summary: 'Inspect visual display settings',
          user_facing_summary: 'Identify displays and visual arrangements',
          normalized_scope: ['surface_report'],
          target_actuators: ['service-actuator'],
          deliverables: ['surface_report'],
          missing_inputs: [],
          assumptions: ['Use the current thread context.'],
          clarification_questions: [],
          readiness: 'fully_automatable',
          readiness_reason: 'No missing inputs.',
          llm_touchpoints: [],
          recommended_next_step: 'Compile the intent contract and work loop.',
        });
      }
      
      // Mock Stage 2: IntentContract
      if (promptLower.includes('intent contract compiler')) {
        logger.info(`  -> [${trialName}] Mocking IntentContract Response...`);
        return JSON.stringify({
          kind: 'intent-contract',
          source_text: inputText,
          intent_id: 'inspect-workspace-surfaces',
          goal: {
            summary: 'Inspect connected displays and active visual surfaces',
            success_condition: 'DisplaysArrangementAndSurfacesAreReported',
          },
          resolution: {
            execution_shape: 'task_session',
            task_type: 'system_observability',
          },
          required_inputs: [],
          outcome_ids: ['surface_report'],
          approval: {
            requires_approval: false,
          },
          delivery_mode: 'one_shot',
          clarification_needed: false,
          confidence: 0.95,
          why: 'Explicit request for display surface inspection.',
        });
      }
      
      // Mock Stage 3: OrganizationWorkLoopSummary
      if (promptLower.includes('work loop compiler')) {
        logger.info(`  -> [${trialName}] Mocking OrganizationWorkLoopSummary Response...`);
        return JSON.stringify({
          intent: { label: 'inspect-workspace-surfaces' },
          context: {
            tier: 'public',
            service_bindings: [],
          },
          resolution: {
            execution_shape: 'task_session',
            task_type: 'system_observability',
          },
          workflow_design: {
            workflow_id: 'single-track-default',
            pattern: 'single_track_execution',
            stage: 'planning',
            phases: ['intake', 'planning', 'execution', 'verification', 'delivery'],
            rationale: 'Straightforward visual display surface check.',
          },
          review_design: {
            review_mode: 'lean',
            required_gate_ids: [],
            all_gate_ids: [],
            rationale: 'Low-risk inspection task.',
          },
          outcome_design: {
            outcome_ids: ['surface_report'],
            labels: ['Workspace surface report'],
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
            specialist_id: 'service-operator',
            specialist_label: 'Service Operator',
            conversation_agent: 'nerve-agent',
            team_roles: ['planner'],
          },
          authority: {
            requires_approval: false,
          },
          learning: {
            reusable_refs: [],
          },
        });
      }

      logger.warn(`  -> [${trialName}] Unhandled prompt schema, returning generic stub.`);
      return JSON.stringify({});
    }
  };

  logger.info(`[${trialName}] Running compilation for: "${inputText}"`);
  
  const result = await compileUserIntentFlow({
    text: inputText,
    locale: 'ja',
    tier: 'public',
  }, options);

  const duration = Date.now() - startTime;
  
  logger.success(`[${trialName}] Finished in ${duration}ms.`);
  logger.info(`[${trialName}] LLM Call Count: ${llmCalls}`);
  logger.info(`[${trialName}] Cache Status: ${result.source === 'fallback' ? 'Fallback' : (llmCalls === 0 ? 'Cache HIT' : 'Cache MISS')}`);
  logger.info(`[${trialName}] Resolved Intent: ${result.intentContract.intent_id}`);
  console.log('--------------------------------------------------');

  return {
    trialName,
    inputText,
    llmCalls,
    duration,
    intentId: result.intentContract.intent_id,
    cacheStatus: llmCalls === 0 ? 'HIT' : 'MISS',
  };
}

async function main() {
  logger.info('=== STARTING LEARNING & CACHING EFFICIENCY BENCHMARK ===');

  const results = [];

  // Trial 1: Cold Run
  results.push(await runTrial(
    'Trial 1: Cold Run (Unlearned)',
    'inspect-workspace-surfaces',
    true // Clear cache before
  ));

  // Trial 2: Warm Run (Same Prompt)
  results.push(await runTrial(
    'Trial 2: Warm Run (Same Intent - Learned)',
    'inspect-workspace-surfaces',
    false // Keep cache
  ));

  // Trial 3: Warm Run 2 (Same Intent - Verification)
  results.push(await runTrial(
    'Trial 3: Warm Run 2 (Same Intent - Verification)',
    'inspect-workspace-surfaces',
    false // Keep cache
  ));

  logger.info('=== BENCHMARK RESULTS ===');
  console.table(results.map(r => ({
    'Trial': r.trialName,
    'Input': r.inputText,
    'LLM Calls': r.llmCalls,
    'Latency (ms)': r.duration,
    'Resolved Intent': r.intentId,
    'Cache Status': r.cacheStatus,
  })));
  
  logger.success('=== BENCHMARK COMPLETED SUCCESSFULLY ===');
}

main().catch(err => {
  logger.error(`Benchmark failed: ${err.message}`);
  process.exit(1);
});
