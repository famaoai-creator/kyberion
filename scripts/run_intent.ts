import {
  compileUserIntentFlow,
  createAssistantCompilerRequest,
  createAssistantDelegationRequest,
  createTaskSession,
  executeApprovedClaudeTaskSession,
  formatClarificationPacket,
  getTaskIntentBuilder,
  installReasoningBackends,
  logger,
  safeExistsSync,
  saveTaskSession,
  resolveIntentResolutionPacket,
  chooseExecutionIntent,
  gatherImprovementHints,
  issueMissionFromProposal,
  validateTaskSession,
} from '@agent/core';
import type { IntentResolutionPacket } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { resolveAndExecuteIntent } from '../libs/actuators/orchestrator-actuator/src/super-nerve/resolver.js';
import { readJsonInput, resolveAdfInputPath } from './refactor/adf-input.js';

// Task types executeApprovedClaudeTaskSession can run; others stop at session creation.
const CLAUDE_TASK_SESSION_TYPES = new Set(['browser', 'report_document', 'document_generation']);

/**
 * Dispatch a catalog intent whose resolution shape is `task_session` to the
 * governed task-session route (same one the surface orchestrator uses).
 * Returns true when the intent was handled here; false hands control back to
 * the LLM-compile fallback.
 */
async function tryTaskSessionDispatch(
  packet: IntentResolutionPacket,
  utterance: string
): Promise<boolean> {
  if (packet.selected_resolution?.shape !== 'task_session' || !packet.selected_intent_id) {
    return false;
  }
  const builder = getTaskIntentBuilder(packet.selected_intent_id);
  if (!builder) return false;

  const sessionIntent = builder(utterance.trim());
  const missing = sessionIntent.requirements?.missing || [];
  const session = createTaskSession({
    surface: 'terminal',
    taskType: sessionIntent.taskType,
    status: missing.length ? 'collecting_requirements' : 'planning',
    intentId: sessionIntent.intentId || packet.selected_intent_id,
    goal: sessionIntent.goal,
    projectContext: sessionIntent.projectContext,
    requirements: sessionIntent.requirements,
    payload: sessionIntent.payload,
  });
  const validation = validateTaskSession(session);
  if (!validation.valid) {
    throw new Error(`generated task session is invalid: ${validation.errors.join('; ')}`);
  }
  const sessionPath = saveTaskSession(session);

  if (missing.length || !CLAUDE_TASK_SESSION_TYPES.has(session.task_type)) {
    console.log(
      JSON.stringify(
        {
          status: missing.length ? 'collecting_requirements' : 'task_session_created',
          session_id: session.session_id,
          session_path: sessionPath,
          intent_id: packet.selected_intent_id,
          task_type: session.task_type,
          missing_inputs: missing,
        },
        null,
        2
      )
    );
    logger.info(
      missing.length
        ? `📝 [GATEWAY] Task session ${session.session_id} needs ${missing.length} input(s) before execution: ${missing.join(', ')}`
        : `📝 [GATEWAY] Task session ${session.session_id} created; continue it on a surface to execute.`
    );
    return true;
  }

  logger.info(
    `🚚 [GATEWAY] Dispatching ${packet.selected_intent_id} to the governed task-session executor (session ${session.session_id}).`
  );
  const result = await executeApprovedClaudeTaskSession({
    session,
    queryText: utterance,
    agentId: 'run-intent-gateway',
    channel: 'terminal',
  });
  console.log(
    JSON.stringify(
      {
        status: 'completed',
        session_id: result.session.session_id,
        kind: result.kind,
        output_path: result.outputPath,
        output_preview: result.output.slice(0, 500),
      },
      null,
      2
    )
  );
  return true;
}

async function main() {
  const argv = await createStandardYargs()
    .option('intent', { alias: 'n', type: 'string', description: 'Semantic intent ID or keyword' })
    .option('input', { alias: 'i', type: 'string', description: 'Context ADF path' })
    .option('compiler-provider', {
      type: 'string',
      choices: ['codex', 'gemini', 'claude'],
      description: 'LLM provider for intent/work-loop compilation',
    })
    .option('compiler-model', {
      type: 'string',
      description: 'LLM model for intent/work-loop compilation',
    })
    .option('compiler-model-provider', {
      type: 'string',
      description: 'Provider-specific model backend identifier',
    })
    .option('delegate-via-assistant', {
      type: 'boolean',
      default: false,
      description:
        'Emit an assistant delegation request artifact instead of running deterministically',
    })
    .option('compile-via-assistant', {
      type: 'boolean',
      default: false,
      description:
        'Emit an assistant compiler request artifact without running the local LLM compiler',
    })
    .option('delegate-mode', {
      type: 'string',
      choices: ['plan_only', 'investigate', 'implement'],
      default: 'plan_only',
      description: 'Delegation mode for the assistant request',
    })
    .option('delegate-provider', {
      type: 'string',
      choices: ['codex', 'gemini', 'claude'],
      description: 'Preferred provider for assistant-side delegation',
    })
    .option('delegate-model', {
      type: 'string',
      description: 'Preferred model for assistant-side delegation',
    })
    .option('delegate-model-provider', {
      type: 'string',
      description: 'Preferred backend/provider hint for assistant-side delegation',
    })
    .parseSync();

  const intent = argv.intent || (argv._[0] as string);
  if (!intent) {
    logger.error('Usage: node dist/scripts/run_intent.js <intent_id> [--input context.json]');
    process.exit(1);
  }

  // Bootstrap the reasoning backend before any compile/clarification step, so
  // the gateway degrades loudly (LC-08) instead of silently serving stub output.
  installReasoningBackends();

  let context = {};
  if (argv.input && safeExistsSync(resolveAdfInputPath(argv.input as string))) {
    context = readJsonInput(argv.input as string);
  }
  const tier = (context as any)?.tier as 'personal' | 'confidential' | 'public' | undefined;
  const tenantId =
    (context as any)?.tenant_id ||
    (context as any)?.tenantId ||
    (context as any)?.tenant_slug ||
    (context as any)?.tenantSlug ||
    process.env.KYBERION_TENANT ||
    process.env.KYBERION_CUSTOMER;
  const packet = resolveIntentResolutionPacket(intent, {
    tier,
    tenantId: typeof tenantId === 'string' ? tenantId : undefined,
  });
  const runtimeContext = {
    ...(packet.selected_parameters || {}),
    ...(context as Record<string, unknown>),
  };

  logger.info(`🚀 [GATEWAY] Processing high-level intent: ${intent}`);
  const compilerOptions = {
    provider: argv.compilerProvider as 'codex' | 'gemini' | 'claude' | undefined,
    model: argv.compilerModel as string | undefined,
    modelProvider: argv.compilerModelProvider as string | undefined,
  };

  const compileFlow = async () =>
    compileUserIntentFlow(
      {
        text: intent,
        locale: String((context as any)?.locale || ''),
        projectId: (context as any)?.project_id,
        projectName: (context as any)?.project_name,
        trackId: (context as any)?.track_id,
        trackName: (context as any)?.track_name,
        tier,
        tenantId: typeof tenantId === 'string' ? tenantId : undefined,
        serviceBindings: Array.isArray((context as any)?.service_bindings)
          ? (context as any).service_bindings
          : [],
        runtimeContext,
        resolutionPacket: packet,
      },
      compilerOptions
    );

  if (argv.compileViaAssistant) {
    const compilerRequest = createAssistantCompilerRequest({
      source: { origin: 'cli', channel: 'run_intent' },
      sourceText: intent,
      locale: String((context as any)?.locale || ''),
      projectId: (context as any)?.project_id,
      projectName: (context as any)?.project_name,
      trackId: (context as any)?.track_id,
      trackName: (context as any)?.track_name,
      tier,
      serviceBindings: Array.isArray((context as any)?.service_bindings)
        ? (context as any).service_bindings
        : [],
      runtimeContext,
      preferredProvider:
        (argv.delegateProvider as 'codex' | 'gemini' | 'claude' | undefined) ||
        compilerOptions.provider,
      preferredModel: (argv.delegateModel as string | undefined) || compilerOptions.model,
      preferredModelProvider:
        (argv.delegateModelProvider as string | undefined) || compilerOptions.modelProvider,
    });
    console.log(
      JSON.stringify(
        {
          compiler_request_path: compilerRequest.requestPath,
          write_back_path: compilerRequest.request.expected_output.write_back_path,
          compiler_request: compilerRequest.request,
        },
        null,
        2
      )
    );
    return;
  }

  if (argv.delegateViaAssistant) {
    const compiled = await compileFlow();
    const delegation = createAssistantDelegationRequest({
      source: { origin: 'cli', channel: 'run_intent' },
      sourceText: intent,
      intentContract: compiled.intentContract,
      workLoop: compiled.workLoop,
      clarificationPacket: compiled.clarificationPacket,
      locale: String((context as any)?.locale || ''),
      projectId: (context as any)?.project_id,
      projectName: (context as any)?.project_name,
      trackId: (context as any)?.track_id,
      trackName: (context as any)?.track_name,
      tier: (context as any)?.tier,
      serviceBindings: Array.isArray((context as any)?.service_bindings)
        ? (context as any).service_bindings
        : [],
      mode: argv.delegateMode as 'plan_only' | 'investigate' | 'implement',
      preferredProvider:
        (argv.delegateProvider as 'codex' | 'gemini' | 'claude' | undefined) ||
        compilerOptions.provider,
      preferredModel: (argv.delegateModel as string | undefined) || compilerOptions.model,
      preferredModelProvider:
        (argv.delegateModelProvider as string | undefined) || compilerOptions.modelProvider,
    });
    if (compiled.clarificationPacket) {
      console.log(formatClarificationPacket(compiled.clarificationPacket));
    }
    if (compiled.routingDecision) {
      logger.info(
        `[GATEWAY] Routing decision: ${compiled.routingDecision.mode} (${compiled.routingDecision.rationale})`
      );
    }
    console.log(
      JSON.stringify(
        {
          delegation_request_path: delegation.requestPath,
          write_back_path: delegation.request.expected_output.write_back_path,
          compiled,
          execution_brief: compiled.executionBrief,
          routing_decision: compiled.routingDecision,
          delegation_request: delegation.request,
        },
        null,
        2
      )
    );
    return;
  }

  try {
    // GAP1 convergence: drive execution off the canonical resolver's confident
    // selection (packet) rather than re-resolving the raw utterance separately.
    const executionIntent = chooseExecutionIntent(packet, intent);
    // Improvement loop (④→①): surface accumulated lessons (feedback-loop hints +
    // promoted memory, ingested into the knowledge index) into the execution
    // context so past learning biases this run. Best-effort; never blocks.
    const improvementHints = await gatherImprovementHints(executionIntent);
    const executionContext = improvementHints.length
      ? { ...runtimeContext, knowledge_hints: improvementHints }
      : runtimeContext;
    if (improvementHints.length) {
      logger.info(
        `🧠 [GATEWAY] Applied ${improvementHints.length} learned hint(s) from the knowledge base to the execution context.`
      );
    }
    const result = await resolveAndExecuteIntent(executionIntent, executionContext);
    console.log(JSON.stringify(result, null, 2));
    logger.success(`✅ [GATEWAY] Goal achieved for intent: ${intent}`);
  } catch (err: any) {
    logger.warn(`⚠️ [GATEWAY] Deterministic intent execution unavailable: ${err.message}`);
    // Catalog intents shaped `task_session` (e.g. generate-report) have no
    // pipeline steps by design — run them through the governed task-session
    // route instead of degrading to a compile-only contract.
    if (await tryTaskSessionDispatch(packet, intent)) {
      logger.success(`✅ [GATEWAY] Goal routed via task session for intent: ${intent}`);
      return;
    }
    const compiled = await compileFlow();
    if (compiled.clarificationPacket) {
      console.log(formatClarificationPacket(compiled.clarificationPacket));
      console.log(JSON.stringify(compiled, null, 2));
      return;
    }
    if (compiled.routingDecision) {
      logger.info(
        `[GATEWAY] Routing decision: ${compiled.routingDecision.mode} (${compiled.routingDecision.rationale})`
      );
    }
    // SN-01: mission-shaped requests from the CLI ride the same orchestration
    // chain as Slack/Chronos instead of stopping at a compile-only contract.
    const executionShape =
      compiled.workLoop?.work_scope_decision?.execution_shape ||
      compiled.workLoop?.resolution?.execution_shape;
    if (executionShape === 'mission') {
      const issued = await issueMissionFromProposal({
        surface: 'terminal',
        channel: 'terminal',
        thread: Date.now().toString(),
        proposal: {
          intent: 'create_mission',
          summary: compiled.intentContract?.goal?.summary || intent,
          mission_type: 'development',
          tier,
          why: 'CLI request classified as mission-shaped by the intent compiler.',
        },
        sourceText: intent,
        routingDecision: compiled.routingDecision,
        requestedBy: 'mission_controller',
      });
      console.log(
        JSON.stringify(
          {
            status: 'mission_issued',
            mission_id: issued.missionId,
            orchestration_status: issued.orchestrationStatus,
            orchestration_job_path: issued.orchestrationJobPath,
            follow: `node dist/scripts/mission_controller.js status ${issued.missionId}`,
          },
          null,
          2
        )
      );
      logger.success(
        `🚀 [GATEWAY] Mission ${issued.missionId} issued via the surface-neutral orchestration chain.`
      );
      return;
    }
    console.log(JSON.stringify(compiled, null, 2));
  }
}

main();
