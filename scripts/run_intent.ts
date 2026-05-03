import {
  compileUserIntentFlow,
  createAssistantCompilerRequest,
  createAssistantDelegationRequest,
  formatClarificationPacket,
  logger,
  safeExistsSync,
  resolveIntentResolutionPacket,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { resolveAndExecuteIntent } from '../libs/actuators/orchestrator-actuator/src/super-nerve/resolver.js';
import { readJsonInput, resolveAdfInputPath } from './refactor/adf-input.js';

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

  let context = {};
  if (argv.input && safeExistsSync(resolveAdfInputPath(argv.input as string))) {
    context = readJsonInput(argv.input as string);
  }
  const packet = resolveIntentResolutionPacket(intent);
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
        tier: (context as any)?.tier,
        serviceBindings: Array.isArray((context as any)?.service_bindings)
          ? (context as any).service_bindings
          : [],
        runtimeContext,
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
      tier: (context as any)?.tier,
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
    console.log(
      JSON.stringify(
        {
          delegation_request_path: delegation.requestPath,
          write_back_path: delegation.request.expected_output.write_back_path,
          compiled,
          execution_brief: compiled.executionBrief,
          delegation_request: delegation.request,
        },
        null,
        2
      )
    );
    return;
  }

  try {
    const result = await resolveAndExecuteIntent(intent, runtimeContext);
    console.log(JSON.stringify(result, null, 2));
    logger.success(`✅ [GATEWAY] Goal achieved for intent: ${intent}`);
  } catch (err: any) {
    logger.warn(`⚠️ [GATEWAY] Deterministic intent execution unavailable: ${err.message}`);
    const compiled = await compileFlow();
    if (compiled.clarificationPacket) {
      console.log(formatClarificationPacket(compiled.clarificationPacket));
      console.log(JSON.stringify(compiled, null, 2));
      return;
    }
    console.log(JSON.stringify(compiled, null, 2));
  }
}

main();
