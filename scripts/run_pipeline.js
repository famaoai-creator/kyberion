import {
  TraceContext,
  finalizeAndPersist,
  classifyError,
  formatClassification,
  logger,
  safeExec,
  safeReadFile,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  retry,
  resolveVars,
  evaluateCondition,
  capabilityEntry,
  findMissionPath,
  missionEvidenceDir,
  pathResolver,
  installReasoningBackends,
  runFeedbackLoop,
  safeExecResult,
  buildNextActionFromError,
  formatNextAction,
  runJanitor,
  checkActuatorCapabilities,
  killSwitch,
  validateOpInput,
} from '@agent/core';
import { tryRepairJson } from '@agent/core/json-repair';
import { installPythonVoiceBridgeIfAvailable } from '@agent/core/python-voice-bridge';
import {
  markRouterActive,
  markRouterInactive,
  resetRouterSync,
} from '@agent/core/blackhole-routing-guard';
import * as nodePath from 'node:path';
import { derivePipelineStatus } from '@agent/core/pipeline-contract';
import { readValidatedWorkflowAdf } from './refactor/adf-input.js';
function resolveStepType(step) {
  if (step.role) {
    if (step.role === 'source') return 'capture';
    if (step.role === 'transform') return 'transform';
    if (step.role === 'sink') return 'apply';
    if (step.role === 'gate') return 'control';
  }
  return step.type ?? 'apply';
}
function resolveExportKey(step, defaultKey) {
  if (step.produces) {
    return typeof step.produces === 'string' ? step.produces : step.produces.channel;
  }
  return String(step.params?.export_as ?? defaultKey);
}
function runTsFallbackPipeline(fallbackPath) {
  const fallbackEntry = pathResolver.rootResolve('scripts/run_pipeline.ts');
  const tsxAvailable = safeExecResult('node', ['--import', 'tsx', '--eval', 'process.exit(0)'], {
    cwd: pathResolver.rootDir(),
    env: {
      KYBERION_PIPELINE_FALLBACK_ACTIVE: '1',
    },
  });
  if (tsxAvailable.status !== 0) {
    const message =
      'tsx fallback is unavailable. Run `pnpm build` so dist/scripts/run_pipeline.js is available.';
    logger.error(`\u274C [PIPELINE] ${message}`);
    throw new Error(message);
  }
  logger.warn(
    `\u26A0\uFE0F [PIPELINE] Running fallback pipeline from source because dist/scripts/run_pipeline.js was not used: ${fallbackPath}`
  );
  return safeExecResult('node', ['--import', 'tsx', fallbackEntry, '--input', fallbackPath], {
    cwd: pathResolver.rootDir(),
    env: {
      KYBERION_PIPELINE_FALLBACK_ACTIVE: '1',
    },
  });
}
function normalizeStepBudget(raw) {
  if (!raw || typeof raw !== 'object') return void 0;
  const budget = raw;
  const normalized = {};
  const coercePositiveInt2 = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return void 0;
    const rounded = Math.floor(value);
    return rounded > 0 ? rounded : void 0;
  };
  const costCapTokens = coercePositiveInt2(budget.cost_cap_tokens ?? budget.costCapTokens);
  const maxPromptChars = coercePositiveInt2(budget.max_prompt_chars ?? budget.maxPromptChars);
  const maxResponseChars = coercePositiveInt2(budget.max_response_chars ?? budget.maxResponseChars);
  const maxCombinedChars = coercePositiveInt2(budget.max_combined_chars ?? budget.maxCombinedChars);
  if (costCapTokens !== void 0) normalized.cost_cap_tokens = costCapTokens;
  if (maxPromptChars !== void 0) normalized.max_prompt_chars = maxPromptChars;
  if (maxResponseChars !== void 0) normalized.max_response_chars = maxResponseChars;
  if (maxCombinedChars !== void 0) normalized.max_combined_chars = maxCombinedChars;
  if (budget.approval_required === true || budget.approvalRequired === true) {
    normalized.approval_required = true;
  }
  return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function normalizeReasoningPolicy(step) {
  return {
    effort:
      step.effort === 'low' || step.effort === 'medium' || step.effort === 'high'
        ? step.effort
        : void 0,
    budget: normalizeStepBudget(step.budget),
  };
}
function summarizeReasoningPolicy(policy) {
  const summary = {};
  if (policy.effort) summary.step_effort = policy.effort;
  if (policy.budget?.cost_cap_tokens !== void 0)
    summary.budget_cost_cap_tokens = policy.budget.cost_cap_tokens;
  if (policy.budget?.max_prompt_chars !== void 0)
    summary.budget_max_prompt_chars = policy.budget.max_prompt_chars;
  if (policy.budget?.max_response_chars !== void 0)
    summary.budget_max_response_chars = policy.budget.max_response_chars;
  if (policy.budget?.max_combined_chars !== void 0)
    summary.budget_max_combined_chars = policy.budget.max_combined_chars;
  if (policy.budget?.approval_required) summary.budget_approval_required = true;
  return summary;
}
function buildReasoningPolicyNote(policy) {
  const parts = [];
  if (policy.effort) parts.push(`effort=${policy.effort}`);
  if (policy.budget?.cost_cap_tokens !== void 0)
    parts.push(`cost_cap_tokens=${policy.budget.cost_cap_tokens}`);
  if (policy.budget?.max_prompt_chars !== void 0)
    parts.push(`max_prompt_chars=${policy.budget.max_prompt_chars}`);
  if (policy.budget?.max_response_chars !== void 0)
    parts.push(`max_response_chars=${policy.budget.max_response_chars}`);
  if (policy.budget?.max_combined_chars !== void 0)
    parts.push(`max_combined_chars=${policy.budget.max_combined_chars}`);
  if (policy.budget?.approval_required) parts.push('approval_required=true');
  return parts.length > 0
    ? `

[policy ${parts.join(' ')}]`
    : '';
}
function isReasoningBudgetExceeded(policy, prompt, responseText) {
  const promptChars = prompt.length;
  const responseChars = responseText.length;
  const combinedChars = promptChars + responseChars;
  if (policy.budget?.max_prompt_chars !== void 0 && promptChars > policy.budget.max_prompt_chars) {
    return `prompt budget exceeded (${promptChars}/${policy.budget.max_prompt_chars} chars)`;
  }
  if (
    policy.budget?.max_response_chars !== void 0 &&
    responseChars > policy.budget.max_response_chars
  ) {
    return `response budget exceeded (${responseChars}/${policy.budget.max_response_chars} chars)`;
  }
  if (
    policy.budget?.max_combined_chars !== void 0 &&
    combinedChars > policy.budget.max_combined_chars
  ) {
    return `combined budget exceeded (${combinedChars}/${policy.budget.max_combined_chars} chars)`;
  }
  return null;
}
function validateFlow(steps, initialCtx = {}) {
  const available = new Set(Object.keys(initialCtx));
  const errors = [];
  for (const step of steps) {
    const id = step.id ?? step.op;
    const consumed = step.consumes
      ? Array.isArray(step.consumes)
        ? step.consumes
        : [step.consumes]
      : [];
    const missing = consumed.filter((ch) => !available.has(ch));
    if (missing.length > 0) errors.push({ stepId: id, missing });
    if (step.produces) {
      const ch = typeof step.produces === 'string' ? step.produces : step.produces.channel;
      available.add(ch);
    } else if (step.params?.export_as && typeof step.params.export_as === 'string') {
      available.add(step.params.export_as);
    }
  }
  return errors;
}
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runStepHooks } from './refactor/step-hooks.js';
const dispatchCache = {};
const moduleCache = {};
function resolveParamsRecursive(params, ctx) {
  if (Array.isArray(params)) {
    return params.map((item) => resolveParamsRecursive(item, ctx));
  }
  if (params && typeof params === 'object') {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, resolveParamsRecursive(value, ctx)])
    );
  }
  return resolveVars(params, ctx);
}
async function loadActuatorDispatch(domain) {
  if (dispatchCache[domain]) return dispatchCache[domain];
  if (domain === 'reasoning') {
    dispatchCache[domain] = async (op, params, ctx, type, _trace, policy) => {
      const { getReasoningBackend } = await import('@agent/core');
      const backend = getReasoningBackend();
      if (op === 'analyze' || op === 'transform' || op === 'synthesize') {
        const resolvedInstruction =
          typeof params.instruction === 'string'
            ? resolveVars(params.instruction, ctx)
            : params.instruction;
        const resolvedContext = Array.isArray(params.context)
          ? params.context.map((item) => (typeof item === 'string' ? resolveVars(item, ctx) : item))
          : typeof params.context === 'string'
            ? resolveVars(params.context, ctx)
            : params.context || ctx;
        const reasoningPolicy = params._reasoning_policy ?? policy;
        const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}
Context: ${JSON.stringify(resolvedContext)}${buildReasoningPolicyNote(reasoningPolicy || {})}`;
        const reasoningCallOptions = {
          effort: reasoningPolicy?.effort,
          budget: reasoningPolicy?.budget,
        };
        const preCallBudgetError = isReasoningBudgetExceeded(reasoningPolicy || {}, prompt, '');
        if (preCallBudgetError) {
          throw new Error(
            `Reasoning budget exceeded${reasoningPolicy?.budget?.approval_required ? '; approval required' : ''}: ${preCallBudgetError}`
          );
        }
        const rawResponse = shouldUseSubagentForReasoningStep(params)
          ? await backend.delegateTask(
              String(resolvedInstruction || 'Analyze the context.'),
              JSON.stringify(resolvedContext),
              reasoningCallOptions
            )
          : await retry(() => backend.prompt(prompt, reasoningCallOptions), {
              maxRetries: 2,
              initialDelayMs: 3e3,
              maxDelayMs: 15e3,
              factor: 2,
              shouldRetry: (err) =>
                err.message.includes('timed out') ||
                err.message.includes('INVALID_STREAM') ||
                err.message.includes('empty response') ||
                err.message.includes('missing "response"'),
              onRetry: (err, attempt) =>
                logger.warn(
                  `  [REASONING] Retry ${attempt}/2 for reasoning:analyze \u2014 ${err.message.slice(0, 120)}`
                ),
            });
        const postCallBudgetError = isReasoningBudgetExceeded(
          reasoningPolicy || {},
          prompt,
          String(rawResponse || '')
        );
        if (postCallBudgetError) {
          throw new Error(
            `Reasoning budget exceeded${reasoningPolicy?.budget?.approval_required ? '; approval required' : ''}: ${postCallBudgetError}`
          );
        }
        return {
          handled: true,
          ctx: { ...ctx, [params.export_as || 'last_reasoning']: rawResponse },
        };
      }
      return { handled: false, ctx };
    };
    return dispatchCache[domain];
  }
  const { resolveProviderCapabilityId, invokeProviderCapability } =
    await import('@agent/core/provider-bridge');
  dispatchCache[domain] = async (op, params, ctx, type, trace) => {
    const resolvedId = resolveProviderCapabilityId(domain, op);
    if (resolvedId) {
      const result2 = await invokeProviderCapability({
        capabilityId: resolvedId,
        args: params.args,
        payload: params.payload || params.instruction || params.prompt,
        context: ctx,
      });
      let parsed = result2;
      try {
        parsed = JSON.parse(result2);
      } catch {}
      return {
        handled: true,
        ctx: { ...ctx, [params.export_as || 'last_provider_result']: parsed },
      };
    }
    let result = { handled: false, ctx };
    try {
      if (!moduleCache[domain]) {
        let entry = capabilityEntry(`${domain}-actuator`);
        if (!safeExistsSync(entry)) {
          const directEntry = capabilityEntry(domain);
          if (safeExistsSync(directEntry)) {
            entry = directEntry;
          } else {
            logger.info(`  [SYS_PIPELINE] Debug: domain=${domain}, entry=${entry}`);
          }
        }
        moduleCache[domain] = await import(pathToFileURL(entry).href);
      }
      const mod = moduleCache[domain];
      if (typeof mod.dispatchDecisionOp === 'function') {
        result = await mod.dispatchDecisionOp(op, params, ctx);
      }
      if (!result.handled && typeof mod.handleAction === 'function') {
        try {
          const actionResult = await mod.handleAction({
            action: 'pipeline',
            steps: [{ type: type || 'apply', op, params }],
            context: ctx,
            options: ctx.__pipeline_options,
            ...(trace ? { pipelineTrace: trace } : {}),
          });
          result = {
            handled: true,
            ctx:
              actionResult && typeof actionResult === 'object'
                ? { ...ctx, ...actionResult }
                : { ...ctx, [params.export_as || 'last_action_result']: actionResult },
          };
        } catch (err) {
          if (
            !err.message.toLowerCase().includes('unsupported') &&
            !err.message.toLowerCase().includes('not a function')
          ) {
            throw err;
          }
          try {
            const resolvedParams = resolveParamsRecursive(params, ctx);
            const directResult = await mod.handleAction({
              action: op,
              params: { ...resolvedParams, context: ctx },
            });
            result = {
              handled: true,
              ctx: { ...ctx, [params.export_as || 'last_action_result']: directResult },
            };
          } catch (err2) {
            logger.info(
              `  [SYS_PIPELINE] Actuator fallback failed for domain: ${domain}, op: ${op}. Error: ${err2.message}`
            );
            throw err;
          }
        }
      }
    } catch (err) {
      throw err;
    }
    return result;
  };
  return dispatchCache[domain];
}
function normalizePipelineOp(op) {
  if (op.includes(':')) {
    const [domain, action] = op.split(':');
    if (domain === 'mission' && action === 'list') return 'system:list_missions';
    if (domain === 'project' && action === 'list') return 'system:list_projects';
    if (domain === 'knowledge' && action === 'list') return 'system:list_knowledge';
    if (domain === 'capability' && action === 'list') return 'system:list_capabilities';
    if (domain === 'agent' && (action === 'list-manifests' || action === 'list_manifests'))
      return 'agent:list_manifests';
    if (domain === 'agent' && (action === 'list-runtimes' || action === 'list_runtimes'))
      return 'agent:list_runtimes';
    if (domain === 'mission') return `system:${action}`;
    return op;
  }
  if (op === 'if') return 'core:if';
  if (op === 'while' || op === 'loop_until') return 'core:while';
  if (op === 'retry_until_quality') return 'core:retry_until_quality';
  if (op === 'parallel_foreach') return 'core:parallel_foreach';
  if (op === 'accumulate') return 'core:accumulate';
  return `system:${op}`;
}
function validatePipelineOpInput(domain, action, params) {
  if (domain === 'core' || domain === 'reasoning') return;
  const validation = validateOpInput(domain, action, params);
  if (!validation.valid) {
    throw new Error(`[INVALID_OP_INPUT] ${domain}:${action}: ${validation.errors.join('; ')}`);
  }
}
function resolveLogMessage(params, ctx) {
  const template = params.message ?? params.template ?? params.text ?? '';
  return String(resolveVars(template, ctx));
}
function resolveActuatorManifestPath(domain) {
  const candidates = [`${domain}-actuator`, domain];
  for (const actuatorId of candidates) {
    const manifestPath = pathResolver.rootResolve(
      path.join('libs/actuators', actuatorId, 'manifest.json')
    );
    if (safeExistsSync(manifestPath)) return { actuatorId, manifestPath };
  }
  return null;
}
async function assertPipelineStepCapabilityAvailable(domain, action) {
  const manifest = resolveActuatorManifestPath(domain);
  if (!manifest) return;
  const status = await checkActuatorCapabilities(manifest.actuatorId, manifest.manifestPath);
  const capability = status.capabilities.find((entry) => entry.op === action);
  if (!capability || capability.available) return;
  const prereqText = capability.prerequisites?.length
    ? ` Prerequisites: ${capability.prerequisites.join(' | ')}`
    : '';
  throw new Error(
    `capability ${domain}:${action} unavailable: ${capability.reason || 'runtime prerequisite missing'}.${prereqText}`
  );
}
function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}
function matchesArtifactPattern(filePath, pattern) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const basename = path.posix.basename(normalizedPath);
  const matcher = globToRegExp(pattern.replace(/\\/g, '/'));
  return matcher.test(normalizedPath) || matcher.test(basename);
}
function resolveFragmentPath(ref) {
  if (path.isAbsolute(ref)) {
    throw new Error(`core:include: absolute paths are not allowed: ${ref}`);
  }
  const normalized = ref.startsWith('./') ? ref.slice(2) : ref;
  const pipelinesDir = path.join(pathResolver.rootDir(), 'pipelines');
  const relativeRef = normalized.startsWith('pipelines/')
    ? normalized.slice('pipelines/'.length)
    : normalized;
  const resolved = path.resolve(pipelinesDir, relativeRef);
  const rel = path.relative(pipelinesDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`core:include: path must be within pipelines/: ${ref}`);
  }
  return resolved;
}
function shouldUseSubagentForReasoningStep(params) {
  if (params.use_subagent === true) return true;
  const mode = String(params.execution_mode || params.mode || '');
  return mode === 'subagent' || mode === 'delegate';
}
function coercePositiveInt(value, fallback) {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
async function runParallelBatches(items, concurrency, runner) {
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      await runner(items[current], current);
    }
  });
  await Promise.all(workers);
}
function formatPipelineFailure(err) {
  const classification = classifyError(err);
  return {
    classification,
    summary: formatClassification(classification).replace(/\n+/g, ' | '),
  };
}
function logNextActionForPipelineFailure(failure, pipelinePath) {
  const nextAction = buildNextActionFromError(failure.classification, {
    source: 'pipeline',
    pipelinePath,
  });
  for (const line of formatNextAction(nextAction)) {
    logger.error(line);
  }
}
async function runSteps(steps, initialCtx = {}, opts = {}) {
  let ctx = { ...initialCtx };
  const results = [];
  const shellBin = 'bash';
  const rootDir = pathResolver.rootDir();
  for (const step of steps) {
    const stepStartedAtMs = Date.now();
    const stepPolicy = normalizeReasoningPolicy(step);
    const stepTraceBase = {
      step_index: results.length,
      step_id: step.id || step.op,
      op: step.op,
      ...(step.role ? { step_role: step.role } : step.type ? { step_type: step.type } : {}),
      ...summarizeReasoningPolicy(stepPolicy),
    };
    const effectiveType = resolveStepType(step);
    opts.trace?.startSpan(step.op, {
      ...stepTraceBase,
    });
    opts.trace?.addEvent('step.started', stepTraceBase);
    let attempt = 0;
    let stepSucceeded = false;
    let stepSkipped = false;
    let lastError = null;
    let currentNormalizedOp = step.op;
    const finishStepTrace = (eventName, status, attributes = {}) => {
      opts.trace?.addEvent(eventName, {
        ...stepTraceBase,
        op: currentNormalizedOp,
        status,
        duration_ms: Date.now() - stepStartedAtMs,
        ...attributes,
      });
    };
    if (step.hooks?.before?.length) {
      const beforeDecision = await runStepHooks(
        step.hooks.before,
        ctx,
        'before',
        loadActuatorDispatch
      );
      if (beforeDecision === 'abort') {
        results.push({ op: step.op, status: 'failed', error: 'aborted by before hook' });
        finishStepTrace('step.aborted', 'failed');
        opts.trace?.endSpan('error', 'before hook abort');
        return { status: 'failed', results, context: ctx };
      }
      if (beforeDecision === 'skip') {
        results.push({ op: currentNormalizedOp, status: 'skipped' });
        finishStepTrace('step.skipped', 'skipped');
        opts.trace?.endSpan('ok');
        continue;
      }
    }
    while (attempt < 2 && !stepSucceeded) {
      const normalizedOp = normalizePipelineOp(step.op);
      currentNormalizedOp = normalizedOp;
      const [domain, action] = normalizedOp.split(':');
      const rawParams = step.params || {};
      const _producedChannel = step.produces
        ? typeof step.produces === 'string'
          ? step.produces
          : step.produces.channel
        : void 0;
      const params =
        _producedChannel && !rawParams.export_as
          ? { ...rawParams, export_as: _producedChannel }
          : rawParams;
      try {
        if (domain === 'system' && action === 'log') {
          logger.info(resolveLogMessage(params, ctx));
        } else if (domain === 'system' && action === 'write_file') {
          const enrichedCtx = { ...ctx, $now: /* @__PURE__ */ new Date().toISOString() };
          const resolvedParams = resolveParamsRecursive(params, enrichedCtx);
          const writePath = nodePath.resolve(rootDir, String(resolvedParams.path ?? ''));
          const rawContent = resolvedParams.content;
          const contentStr =
            typeof rawContent === 'string'
              ? rawContent
              : rawContent !== void 0
                ? JSON.stringify(rawContent, null, 2)
                : '';
          const dir = nodePath.dirname(writePath);
          if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
          safeWriteFile(writePath, contentStr);
          if (params.export_as && typeof params.export_as === 'string') {
            ctx = { ...ctx, [params.export_as]: contentStr };
          }
        } else if (domain === 'system' && action === 'exec') {
          const resolvedParams = resolveParamsRecursive(params, ctx);
          const command = String(resolvedParams.command ?? resolvedParams.cmd ?? '');
          if (!command) {
            throw new Error('system:exec requires "command" param');
          }
          const args = Array.isArray(resolvedParams.args)
            ? resolvedParams.args.map((value) => String(value))
            : [];
          const env = Object.fromEntries(
            Object.entries(resolvedParams.env || {}).map(([key, value]) => [
              key,
              typeof value === 'string' ? String(value) : String(value),
            ])
          );
          const cwdValue =
            typeof resolvedParams.cwd === 'string' && resolvedParams.cwd.trim().length > 0
              ? String(resolvedParams.cwd)
              : rootDir;
          const timeoutMs =
            typeof resolvedParams.timeout_ms === 'number' ? resolvedParams.timeout_ms : void 0;
          const execResult = safeExecResult(command, args, {
            cwd: path.isAbsolute(cwdValue) ? cwdValue : path.resolve(rootDir, cwdValue),
            env,
            ...(timeoutMs ? { timeoutMs } : {}),
            input:
              typeof resolvedParams.input === 'string'
                ? String(resolveVars(resolvedParams.input, ctx))
                : void 0,
          });
          const exportValue = {
            stdout: execResult.stdout,
            stderr: execResult.stderr,
            status: execResult.status,
          };
          if (resolvedParams.export_as && typeof resolvedParams.export_as === 'string') {
            ctx = { ...ctx, [resolvedParams.export_as]: exportValue };
          }
          const allowError =
            resolvedParams.allow_error === true || resolvedParams.allowError === true;
          if (!allowError && execResult.status !== 0) {
            throw new Error(
              execResult.stderr.trim() ||
                execResult.stdout.trim() ||
                `system:exec exited with status ${execResult.status}`
            );
          }
        } else if (domain === 'system' && action === 'shell') {
          const cmd = String(resolveVars(params.cmd || '', ctx));
          const env = Object.fromEntries(
            Object.entries(params.env || {}).map(([key, value]) => [
              key,
              typeof value === 'string' ? String(resolveVars(value, ctx)) : String(value),
            ])
          );
          const timeoutMs = typeof params.timeout_ms === 'number' ? params.timeout_ms : void 0;
          const output = safeExec(shellBin, ['-c', cmd], {
            cwd: rootDir,
            env,
            ...(timeoutMs ? { timeoutMs } : {}),
          }).trim();
          let parsedOutput = output;
          if (output) {
            try {
              parsedOutput = JSON.parse(output);
            } catch {
              parsedOutput = output;
            }
          }
          if (params.export_as && typeof params.export_as === 'string') {
            ctx = { ...ctx, [params.export_as]: parsedOutput };
          }
          if (cmd.includes('blackhole_audio_router.py')) {
            if (cmd.includes('setup_routing')) {
              const pythonBin = cmd.split(/\s+/)[0];
              const defaultMicDevice = String(ctx.default_mic_device || 'MacBook Pro Microphone');
              markRouterActive(pythonBin, defaultMicDevice, rootDir);
            } else if (cmd.includes('reset_routing')) {
              markRouterInactive();
            }
          }
        } else if (domain === 'core' && action === 'if') {
          const cond = params.condition;
          const conditionResult = evaluateCondition(cond, ctx);
          const branch = conditionResult ? params.then : params.else;
          if (Array.isArray(branch)) {
            const nested = await runSteps(branch, ctx, opts);
            ctx = nested.context;
            results.push(...nested.results);
          } else if (!conditionResult) {
            stepSkipped = true;
            results.push({ op: currentNormalizedOp, status: 'skipped' });
            finishStepTrace('step.skipped', 'skipped', {
              reason: 'core:if condition evaluated to false and no else branch was provided',
            });
            opts.trace?.endSpan('ok');
            stepSucceeded = true;
            continue;
          }
        } else if (
          domain === 'core' &&
          (action === 'while' || action === 'loop_until' || action === 'retry_until_quality')
        ) {
          const body = Array.isArray(params.pipeline) ? params.pipeline : void 0;
          if (!body) {
            throw new Error(`${step.op} requires "pipeline" param`);
          }
          const maxIterations = coercePositiveInt(params.max_iterations ?? params.maxIterations, 1);
          const condition = params.condition ?? params.until ?? params.quality_condition;
          const exportKey = resolveExportKey(step, 'last_loop_result');
          const iterations = [];
          let loopCount = 0;
          while (loopCount < maxIterations) {
            if (condition !== void 0 && action !== 'retry_until_quality') {
              const shouldContinue = Boolean(evaluateCondition(condition, ctx));
              if (!shouldContinue) break;
            }
            const nested = await runSteps(body, ctx, opts);
            ctx = nested.context;
            results.push(...nested.results);
            iterations.push({
              iteration: loopCount + 1,
              context: nested.context,
              results: nested.results,
            });
            loopCount += 1;
            if (action === 'retry_until_quality') {
              const verdict = String(ctx.verdict || ctx.quality || '');
              if (verdict === 'ok' || verdict === 'pass' || verdict === 'passed') {
                break;
              }
            }
            if (condition !== void 0 && action === 'retry_until_quality') {
              const shouldContinue = Boolean(evaluateCondition(condition, ctx));
              if (!shouldContinue) break;
            }
          }
          if (loopCount === 0) {
            stepSkipped = true;
            results.push({ op: currentNormalizedOp, status: 'skipped' });
            finishStepTrace('step.skipped', 'skipped', {
              reason: 'core:while condition evaluated to false before execution',
            });
            opts.trace?.endSpan('ok');
            stepSucceeded = true;
            continue;
          }
          ctx = {
            ...ctx,
            [exportKey]: {
              iterations: loopCount,
              history: iterations,
              final_context: ctx,
            },
          };
        } else if (domain === 'core' && action === 'foreach') {
          const items = resolveVars(params.items, ctx);
          const subSteps = params.do;
          if (Array.isArray(items) && Array.isArray(subSteps)) {
            const itemName = params.as || 'item';
            const originalItemValue = ctx[itemName];
            for (const item of items) {
              const loopCtx = { ...ctx, [itemName]: item };
              const nested = await runSteps(subSteps, loopCtx, opts);
              ctx = { ...nested.context };
              if (originalItemValue === void 0) delete ctx[itemName];
              else ctx[itemName] = originalItemValue;
              results.push(...nested.results);
              if (nested.status === 'failed') break;
            }
          }
        } else if (domain === 'core' && action === 'parallel_foreach') {
          const items = resolveVars(params.items, ctx);
          const subSteps = params.do;
          if (Array.isArray(items) && Array.isArray(subSteps)) {
            const itemName = params.as || 'item';
            const concurrency = coercePositiveInt(params.concurrency ?? params.parallelism, 2);
            const exportKey = resolveExportKey(step, 'last_parallel_foreach');
            const originalItemValue = ctx[itemName];
            const originalSharedCtx = { ...ctx };
            const perItemContexts = [];
            const perItemResults = [];
            const perItemOutputs = [];
            await runParallelBatches(items, concurrency, async (item, index) => {
              const loopCtx = { ...originalSharedCtx, [itemName]: item };
              const nested = await runSteps(subSteps, loopCtx, opts);
              if (nested.status === 'failed') {
                throw new Error(
                  `parallel_foreach item ${index + 1} failed: ${nested.results.find((r) => r.status === 'failed')?.error || 'nested failure'}`
                );
              }
              perItemContexts[index] = nested.context;
              perItemResults[index] = nested.results;
              perItemOutputs[index] = {
                index,
                item,
                context: nested.context,
                results: nested.results,
              };
            });
            ctx = {
              ...ctx,
              [exportKey]: perItemOutputs,
            };
            if (originalItemValue === void 0) delete ctx[itemName];
            else ctx[itemName] = originalItemValue;
            results.push(...perItemResults.flat());
            if (perItemContexts.length > 0) {
              ctx = { ...ctx, ...perItemContexts[perItemContexts.length - 1] };
            }
          }
        } else if (domain === 'core' && action === 'accumulate') {
          const items = resolveVars(params.items, ctx);
          const subSteps = params.do;
          if (!Array.isArray(items)) {
            throw new Error('core:accumulate requires "items" to be an array');
          }
          if (!Array.isArray(subSteps)) {
            throw new Error('core:accumulate requires "do" pipeline steps');
          }
          const itemName = params.as || 'item';
          const collectKey = String(params.collect_as || params.export_as || 'result');
          const exportKey = resolveExportKey(step, 'last_accumulate');
          const originalItemValue = ctx[itemName];
          const originalSharedCtx = { ...ctx };
          const targetCount = coercePositiveInt(
            params.target_count ?? params.targetCount,
            items.length
          );
          const maxIterations = coercePositiveInt(
            params.max_iterations ?? params.maxIterations,
            items.length
          );
          const dryStreakLimit = coercePositiveInt(
            params.dry_streak_limit ?? params.dryStreakLimit,
            2
          );
          const seen = new Set();
          const collected = [];
          let dryStreak = 0;
          let loopCount = 0;
          for (const [index, item] of items.entries()) {
            if (loopCount >= maxIterations) break;
            if (collected.length >= targetCount) break;
            const loopCtx = { ...originalSharedCtx, [itemName]: item };
            const nested = await runSteps(subSteps, loopCtx, opts);
            if (nested.status === 'failed') {
              throw new Error(
                `accumulate item ${index + 1} failed: ${nested.results.find((r) => r.status === 'failed')?.error || 'nested failure'}`
              );
            }
            const candidateValue = nested.context[collectKey] ?? nested.context ?? item;
            const fingerprint = (() => {
              try {
                return JSON.stringify(candidateValue);
              } catch {
                return String(candidateValue);
              }
            })();
            loopCount += 1;
            if (!seen.has(fingerprint)) {
              seen.add(fingerprint);
              collected.push({
                index,
                item,
                value: candidateValue,
                context: nested.context,
                results: nested.results,
              });
              dryStreak = 0;
            } else {
              dryStreak += 1;
            }
            results.push(...nested.results);
            if (dryStreak >= dryStreakLimit) break;
          }
          ctx = {
            ...ctx,
            [exportKey]: {
              collected,
              iterations: loopCount,
              dry_streak: dryStreak,
              target_count: targetCount,
              final_context: ctx,
            },
          };
          if (originalItemValue === void 0) delete ctx[itemName];
          else ctx[itemName] = originalItemValue;
        } else if (domain === 'core' && action === 'include') {
          const fragmentRef = String(resolveVars(params.fragment || '', ctx));
          if (!fragmentRef) throw new Error('core:include requires "fragment" param');
          const fragmentPath = resolveFragmentPath(fragmentRef);
          if (!safeExistsSync(fragmentPath)) {
            throw new Error(
              `core:include: fragment not found: ${fragmentRef} (resolved: ${fragmentPath})`
            );
          }
          const includeStack = opts._includeStack ?? /* @__PURE__ */ new Set();
          if (includeStack.has(fragmentPath)) {
            throw new Error(
              `core:include: circular reference detected \u2014 ${fragmentRef} is already in the include chain`
            );
          }
          const fragmentRaw = String(safeReadFile(fragmentPath, { encoding: 'utf8' }));
          const fragmentJson = (() => {
            try {
              return JSON.parse(fragmentRaw);
            } catch {}
            const repaired = tryRepairJson(fragmentRaw);
            if (repaired !== null) {
              logger.warn(`[pipeline] Auto-repaired malformed JSON in fragment: ${fragmentRef}`);
              return repaired;
            }
            throw new Error(
              `core:include: fragment at ${fragmentRef} contains invalid JSON that could not be repaired`
            );
          })();
          const fragmentSteps = (fragmentJson.steps || []).map((s) => ({
            ...s,
            params: s.params || {},
          }));
          const inlineCtx =
            params.context && typeof params.context === 'object'
              ? Object.fromEntries(
                  Object.entries(params.context).map(([k, v]) => [
                    k,
                    typeof v === 'string' ? resolveVars(v, ctx) : v,
                  ])
                )
              : {};
          const childOpts = {
            ...opts,
            _includeStack: /* @__PURE__ */ new Set([...includeStack, fragmentPath]),
          };
          const nested = await runSteps(fragmentSteps, { ...ctx, ...inlineCtx }, childOpts);
          ctx = nested.context;
          results.push(...nested.results);
          if (nested.status === 'failed') {
            return { status: 'failed', results, context: ctx };
          }
        } else if (domain === 'core' && action === 'wait') {
          const ms = Number(resolveVars(params.duration_ms || params.ms || 1e3, ctx));
          await new Promise((resolve) => setTimeout(resolve, ms));
        } else if (domain === 'core' && (action === 'run_janitor' || action === 'run-janitor')) {
          const dryRunParam = resolveVars(params.dry_run ?? params.dryRun ?? true, ctx);
          const dryRun = dryRunParam === true || dryRunParam === 'true';
          const report = runJanitor({ dryRun });
          const exportKey = resolveExportKey(step, 'janitor_report');
          ctx = { ...ctx, [exportKey]: report };
        } else if (domain === 'core' && action === 'transform') {
          const { Buffer } = await import('node:buffer');
          const vm = await import('node:vm');
          const util = await import('node:util');
          const input = resolveVars(params.input || ctx, ctx);
          const script = String(params.script || 'input');
          const wrappedScript = `(function() { ${script} })()`;
          const sandbox = {
            Buffer,
            input,
            ctx: { ...ctx },
            console: {
              log: (...args) =>
                logger.info(
                  `[TRANSFORM-LOG] ${args.map((a) => (typeof a === 'object' ? util.inspect(a) : a)).join(' ')}`
                ),
            },
          };
          vm.createContext(sandbox);
          const result = await new vm.Script(wrappedScript).runInContext(sandbox);
          const transformKey = resolveExportKey(step, 'last_transform');
          ctx = { ...ctx, [transformKey]: result };
        } else if (
          domain === 'reasoning' &&
          (action === 'analyze' || action === 'transform' || action === 'synthesize')
        ) {
          const { getReasoningBackend } = await import('@agent/core');
          const backend = getReasoningBackend();
          const resolvedInstruction =
            typeof params.instruction === 'string'
              ? resolveVars(params.instruction, ctx)
              : params.instruction;
          const resolvedContext = Array.isArray(params.context)
            ? params.context.map((item) =>
                typeof item === 'string' ? resolveVars(item, ctx) : item
              )
            : typeof params.context === 'string'
              ? resolveVars(params.context, ctx)
              : params.context || ctx;
          const prompt = `Instruction: ${resolvedInstruction || 'Analyze the context.'}
Context: ${JSON.stringify(resolvedContext)}${buildReasoningPolicyNote(stepPolicy)}`;
          const reasoningCallOptions = {
            effort: stepPolicy.effort,
            budget: stepPolicy.budget,
          };
          const preCallBudgetError = isReasoningBudgetExceeded(stepPolicy, prompt, '');
          if (preCallBudgetError) {
            throw new Error(
              `Reasoning budget exceeded${stepPolicy.budget?.approval_required ? '; approval required' : ''}: ${preCallBudgetError}`
            );
          }
          const rawResponse = shouldUseSubagentForReasoningStep(params)
            ? await backend.delegateTask(
                String(resolvedInstruction || 'Analyze the context.'),
                JSON.stringify(resolvedContext),
                reasoningCallOptions
              )
            : await retry(() => backend.prompt(prompt, reasoningCallOptions), {
                maxRetries: 2,
                initialDelayMs: 3e3,
                maxDelayMs: 15e3,
                factor: 2,
                shouldRetry: (err) =>
                  err.message.includes('timed out') ||
                  err.message.includes('INVALID_STREAM') ||
                  err.message.includes('empty response') ||
                  err.message.includes('missing "response"'),
                onRetry: (err, attempt2) =>
                  logger.warn(
                    `  [REASONING] Retry ${attempt2}/2 for reasoning:analyze \u2014 ${err.message.slice(0, 120)}`
                  ),
              });
          const postCallBudgetError = isReasoningBudgetExceeded(
            stepPolicy,
            prompt,
            String(rawResponse || '')
          );
          if (postCallBudgetError) {
            throw new Error(
              `Reasoning budget exceeded${stepPolicy.budget?.approval_required ? '; approval required' : ''}: ${postCallBudgetError}`
            );
          }
          const reasoningExportKey =
            typeof params.export_as === 'string' && params.export_as
              ? params.export_as
              : 'last_reasoning';
          ctx = { ...ctx, [reasoningExportKey]: rawResponse };
        } else {
          if (opts.trace) {
            const mainEntry = capabilityEntry(`${domain}-actuator`);
            const altEntry = capabilityEntry(domain);
            if (!safeExistsSync(mainEntry) && !safeExistsSync(altEntry)) {
              opts.trace.addEvent('capability.missing', {
                actuator: domain,
                step_op: step.op,
                tried_entries: `${mainEntry}, ${altEntry}`,
              });
            }
          }
          validatePipelineOpInput(domain, action, params);
          await assertPipelineStepCapabilityAvailable(domain, action);
          const dispatch = await loadActuatorDispatch(domain);
          const result = await dispatch(
            action,
            { ...params, _reasoning_policy: stepPolicy },
            ctx,
            effectiveType,
            opts.trace,
            stepPolicy
          );
          if (!result.handled) {
            throw new Error(`Unsupported pipeline op: ${step.op}`);
          }
          if (effectiveType === 'capture') {
            const exportKey = resolveExportKey(step, 'last_capture');
            const actualCtx =
              result.ctx && typeof result.ctx === 'object' && 'context' in result.ctx
                ? result.ctx.context
                : result.ctx;
            const data = actualCtx[exportKey];
            if (data === void 0) {
              logger.warn(
                `  [SYS_PIPELINE] Source op ${step.op} returned no data for channel: ${exportKey}.`
              );
              throw new Error(
                `Source op ${step.op} returned no data for channel "${exportKey}". Check that the query, path, or topic is valid and that the current persona has read access. Run \`pnpm doctor\` to verify credential and capability prerequisites.`
              );
            }
          }
          if (result.ctx && typeof result.ctx === 'object' && 'context' in result.ctx) {
            ctx = result.ctx.context;
          } else {
            ctx = result.ctx;
          }
        }
        stepSucceeded = true;
      } catch (err) {
        lastError = err;
        const failure = classifyError(err);
        if (attempt === 0 && failure.repairAction) {
          logger.warn(
            `  [SYS_PIPELINE] Step failed: ${failure.label}. Attempting autonomous repair...`
          );
          const repaired = await attemptAutonomousRepair(
            step,
            failure,
            ctx,
            opts.pipelinePath,
            stepPolicy
          );
          if (repaired) {
            logger.success(
              `  [SYS_PIPELINE] Repair successful. Refreshing ADF and retrying step ${step.op}...`
            );
            try {
              const refreshedPipeline = await readValidatedWorkflowAdf(opts.pipelinePath);
              const refreshedStep = refreshedPipeline.steps?.find(
                (s) => s.id === step.id || s.op === step.op
              );
              if (refreshedStep) {
                step.op = refreshedStep.op;
                step.params = refreshedStep.params;
                logger.info(
                  `  [SYS_PIPELINE] Step definition refreshed for ${step.id || step.op}. New path: ${step.params.path}`
                );
                attempt++;
                continue;
              }
            } catch (reloadErr) {
              logger.warn(
                `  [SYS_PIPELINE] Failed to reload ADF after repair: ${reloadErr.message}.`
              );
            }
          }
        }
        break;
      }
    }
    if (stepSucceeded) {
      if (stepSkipped) {
        continue;
      }
      if (step.hooks?.after?.length) {
        const afterDecision = await runStepHooks(
          step.hooks.after,
          ctx,
          'after',
          loadActuatorDispatch
        );
        if (afterDecision === 'abort') {
          results.push({
            op: currentNormalizedOp,
            status: 'failed',
            error: 'aborted by after hook',
          });
          finishStepTrace('step.aborted', 'failed');
          opts.trace?.endSpan('error', 'after hook abort');
          return { status: 'failed', results, context: ctx };
        }
      }
      results.push({ op: currentNormalizedOp, status: 'success' });
      finishStepTrace('step.completed', 'success');
      opts.trace?.endSpan('ok');
    } else {
      const message = lastError?.message ?? String(lastError);
      const failureFormatted = formatPipelineFailure(lastError);
      results.push({ op: currentNormalizedOp, status: 'failed', error: message });
      finishStepTrace('step.failed', 'failed', {
        error: message,
        error_category: failureFormatted.classification.category,
        error_rule_id: failureFormatted.classification.ruleId,
      });
      opts.trace?.endSpan('error', failureFormatted.summary);
      return { status: 'failed', results, context: ctx };
    }
  }
  return { status: derivePipelineStatus(results), results, context: ctx };
}
async function attemptAutonomousRepair(step, failure, ctx, pipelinePath, policy) {
  try {
    const { getReasoningBackend } = await import('@agent/core');
    const backend = getReasoningBackend();
    const repairHint =
      failure.repairAction ||
      'Investigate the error and the pipeline ADF structure to identify a potential fix.';
    const instruction = `
The following pipeline step failed in Kyberion:
Step Operation: ${step.op}
Step Params: ${JSON.stringify(step.params)}
Error Category: ${failure.category}
Error Detail: ${failure.detail}

Repair Hint: ${repairHint}
${policy ? `Step Policy: ${JSON.stringify(policy)}` : ''}

Repair Action Goal:
1. ANALYZE the error and parameters.
2. If it is a structural/parameter error, FIX the pipeline ADF at ${pipelinePath}.
3. If it is an environment/permission error, suggest or apply changes to .env or authority roles if appropriate.
4. Ensure the resulting ADF follows the required schema.

Assume the persona of a "Sovereign System Recovery Agent".
Once finished, provide a brief summary of the changes you applied to fix the pipeline.
`.trim();
    const report = await backend.delegateTask(
      instruction,
      `Self-Healing Mission for ${step.op}`,
      policy ? { effort: policy.effort, budget: policy.budget } : void 0
    );
    logger.info(`  [SYS_PIPELINE:REPAIR] Sub-agent report: ${report}`);
    try {
      await readValidatedWorkflowAdf(pipelinePath);
    } catch (validationErr) {
      logger.warn(
        `  [SYS_PIPELINE:REPAIR] Sub-agent finished but ADF is still invalid: ${validationErr.message}`
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`  [SYS_PIPELINE:REPAIR] Failed to perform repair: ${err.message}`);
    return false;
  }
}
async function main() {
  installReasoningBackends();
  installPythonVoiceBridgeIfAvailable();
  killSwitch.startMonitor(Number(process.env.KYBERION_KILL_SWITCH_INTERVAL_MS || 1e4));
  const cleanupAndExit = (code) => {
    resetRouterSync();
    process.exit(code);
  };
  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .option('context', {
      alias: 'c',
      type: 'string',
      describe: 'JSON string merged into pipeline.context (overrides)',
    })
    .parseSync();
  const pipeline = await readValidatedWorkflowAdf(argv.input);
  const baseContext = pipeline.context || {};
  let overrideContext = {};
  if (argv.context) {
    try {
      overrideContext = JSON.parse(argv.context);
    } catch (err) {
      logger.error(`\u274C [PIPELINE] Invalid --context JSON: ${err.message}`);
      process.exit(1);
    }
  }
  const firstNonEmpty = (...candidates) =>
    candidates.find((v) => typeof v === 'string' && v.length > 0);
  const missionId = firstNonEmpty(
    overrideContext.mission_id,
    baseContext.mission_id,
    process.env.MISSION_ID
  );
  const autoContext = {};
  if (missionId && !process.env.MISSION_ID) {
    process.env.MISSION_ID = missionId;
  }
  if (missionId) {
    const missionPath = findMissionPath(missionId);
    const evidenceDir = missionEvidenceDir(missionId);
    if (missionPath) {
      autoContext.mission_dir =
        nodePath.relative(pathResolver.rootDir(), missionPath) || missionPath;
      autoContext.mission_tier = nodePath.basename(nodePath.dirname(missionPath));
    }
    if (evidenceDir) {
      autoContext.mission_evidence_dir =
        nodePath.relative(pathResolver.rootDir(), evidenceDir) || evidenceDir;
    }
  }
  autoContext.browser_session_id = `${pipeline.pipeline_id || path.basename(String(argv.input), path.extname(String(argv.input)))}`;
  autoContext.repo_root = pathResolver.rootDir();
  autoContext.platform_name = process.platform;
  autoContext.node_options = process.env.NODE_OPTIONS || '';
  autoContext.run_utc_now = /* @__PURE__ */ new Date().toISOString();
  autoContext.__pipeline_options = pipeline.options || {};
  if (pipeline.knowledge_scope) {
    autoContext._knowledge_scope = pipeline.knowledge_scope;
  } else if (autoContext.mission_tier && autoContext.mission_tier !== 'public') {
    const inferredScope = {
      tiers: ['public', autoContext.mission_tier],
    };
    const customer = process.env.KYBERION_CUSTOMER?.trim();
    if (customer) inferredScope.customerId = customer;
    autoContext._knowledge_scope = inferredScope;
  }
  const mergedContext = { ...baseContext, ...autoContext, ...overrideContext };
  logger.info(
    `\u{1F680} [PIPELINE] Running ${argv.input.match(/\.(ts|js|mjs|cjs)$/u) ? 'workflow module' : 'ADF pipeline'}: ${pipeline.name || argv.input}`
  );
  logger.info(`   [PIPELINE] Mission ID: ${missionId || 'NONE'}`);
  logger.info(`   [PIPELINE] Evidence Dir: ${autoContext.mission_evidence_dir || 'UNDEFINED'}`);
  const pipelineId = String(
    pipeline.pipeline_id ||
      pipeline.id ||
      path.basename(String(argv.input), path.extname(String(argv.input)))
  );
  const trace = new TraceContext(`pipeline:${pipelineId}`, {
    ...(missionId ? { missionId } : {}),
    pipelineId,
  });
  trace.addArtifact('file', String(argv.input), 'Pipeline ADF input');
  try {
    const stepsToRun = (pipeline.steps || []).map((step) => ({
      ...step,
      params: step.params || {},
    }));
    const flowErrors = validateFlow(stepsToRun, mergedContext);
    if (flowErrors.length > 0) {
      for (const e of flowErrors) {
        logger.warn(
          `[FLOW_VALIDATION] Step "${e.stepId}" consumes unknown channel(s): ${e.missing.join(', ')} \u2014 ensure a preceding step produces them.`
        );
      }
    }
    const result = await runSteps(stepsToRun, mergedContext, {
      trace,
      pipelinePath: argv.input,
    });
    const persisted = finalizeAndPersist(trace);
    result.context.trace_summary = persisted.trace.rootSpan.status;
    result.context.trace_persisted_path =
      nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path;
    logger.info(`   [PIPELINE] Trace: ${result.context.trace_persisted_path}`);
    const pipelineStatus = result.status === 'succeeded' ? 'succeeded' : 'failed';
    runFeedbackLoop(pipelineId, pipelineStatus, persisted.trace);
    if (result.status === 'succeeded') {
      logger.success(`\u2705 [PIPELINE] Completed: ${pipeline.name || argv.input}`);
      if (autoContext.__pipeline_options && autoContext.__pipeline_options.keep_alive) {
        logger.info(
          '   [PROCESS] Browser session kept alive per pipeline options. Terminal will remain open.'
        );
      } else {
        process.exit(0);
      }
    } else {
      const failed = result.results.find((entry) => entry.status === 'failed');
      if (failed) {
        const failure = formatPipelineFailure(failed.error || 'unknown error');
        const fallbackPath = String(pipeline.fallback_pipeline || '');
        if (
          fallbackPath &&
          failure.classification.category === 'permission_denied' &&
          !process.env.KYBERION_PIPELINE_FALLBACK_ACTIVE
        ) {
          logger.warn(
            `\u26A0\uFE0F [PIPELINE] Primary first-win failed with permission denial. Running fallback pipeline: ${fallbackPath}`
          );
          const fallbackResult = runTsFallbackPipeline(fallbackPath);
          if (fallbackResult.status === 0) {
            logger.success(`\u2705 [PIPELINE] Fallback succeeded: ${fallbackPath}`);
            process.exit(0);
          }
          logger.error(`\u274C [PIPELINE] Fallback failed: ${fallbackPath}`);
          if (fallbackResult.stdout.trim()) logger.error(fallbackResult.stdout.trim());
          if (fallbackResult.stderr.trim()) logger.error(fallbackResult.stderr.trim());
        }
        logger.error(`\u274C [PIPELINE] Failed step: ${failed.op} :: ${failure.summary}`);
        logNextActionForPipelineFailure(failure, String(argv.input));
      }
      logger.error(`\u274C [PIPELINE] Failed: ${pipeline.name || argv.input}`);
      process.exit(1);
    }
  } catch (err) {
    const failure = formatPipelineFailure(err);
    const fallbackPath = String(pipeline.fallback_pipeline || '');
    if (
      fallbackPath &&
      failure.classification.category === 'permission_denied' &&
      !process.env.KYBERION_PIPELINE_FALLBACK_ACTIVE
    ) {
      logger.warn(
        `\u26A0\uFE0F [PIPELINE] Primary first-win failed with permission denial. Running fallback pipeline: ${fallbackPath}`
      );
      const fallbackResult = runTsFallbackPipeline(fallbackPath);
      if (fallbackResult.status === 0) {
        logger.success(`\u2705 [PIPELINE] Fallback succeeded: ${fallbackPath}`);
        process.exit(0);
      }
      logger.error(`\u274C [PIPELINE] Fallback failed: ${fallbackPath}`);
      if (fallbackResult.stdout.trim()) logger.error(fallbackResult.stdout.trim());
      if (fallbackResult.stderr.trim()) logger.error(fallbackResult.stderr.trim());
    }
    trace.addEvent('pipeline.error', {
      error: err?.message ?? String(err),
      error_category: failure.classification.category,
      error_rule_id: failure.classification.ruleId,
    });
    const persisted = finalizeAndPersist(trace);
    runFeedbackLoop(pipelineId, 'failed', persisted.trace);
    logger.info(
      `   [PIPELINE] Trace: ${nodePath.relative(pathResolver.rootDir(), persisted.path) || persisted.path}`
    );
    logger.error(`\u274C [PIPELINE] Error: ${failure.summary}`);
    logNextActionForPipelineFailure(failure, String(argv.input));
    process.exit(1);
  }
}
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
export {
  buildReasoningPolicyNote,
  formatPipelineFailure,
  isReasoningBudgetExceeded,
  main,
  normalizePipelineOp,
  normalizeReasoningPolicy,
  normalizeStepBudget,
  runSteps,
  summarizeReasoningPolicy,
  validateFlow,
};
