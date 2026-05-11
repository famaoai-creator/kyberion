import { logger, safeReadFile, safeWriteFile, safeMkdir, safeExistsSync, derivePipelineStatus, pathResolver, resolveVars, evaluateCondition, getPathValue, resolveWriteArtifactSpec, withRetry, classifyError } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { terraformToArchitectureAdf } from './terraform-architecture.js';
import { terraformToTopologyIr } from './terraform-topology.js';

const MODEL_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/modeling-actuator/manifest.json');
const DEFAULT_MODEL_RETRY = {
  maxRetries: 2,
  initialDelayMs: 150,
  maxDelayMs: 1200,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(MODEL_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    cachedRecoveryPolicy = {};
  }
  return cachedRecoveryPolicy;
}

function buildRetryOptions() {
  const policy = loadRecoveryPolicy();
  const retry = isPlainObject(policy.retry) ? policy.retry : DEFAULT_MODEL_RETRY;
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : [],
  );
  return {
    ...DEFAULT_MODEL_RETRY,
    ...retry,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      return retryableCategories.size > 0
        ? retryableCategories.has(classification.category)
        : classification.category === 'resource_unavailable' || classification.category === 'timeout';
    },
  };
}

/**
 * Modeling-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Generic data pipeline engine for architectural analysis with Control Flow and Safety Guards.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface ModelingAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const ajv = new AjvCtor({ allErrors: true });
addFormats(ajv);
const BROWSER_EXECUTION_PRESETS_PATH = pathResolver.knowledge('public/orchestration/browser-execution-presets.json');

/**
 * Main Entry Point
 */
async function handleAction(input: ModelingAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  
  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = await withRetry(
      async () => JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string),
      buildRetryOptions(),
    );
    ctx = { ...ctx, ...saved };
  }

  const resolve = (val: any) => resolveVars(val, ctx);

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [MODEL_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, ctx, options, state, resolve);
      } else {
        switch (step.type) {
          case 'capture': ctx = await opCapture(step.op, step.params, ctx, resolve); break;
          case 'transform': ctx = await opTransform(step.op, step.params, ctx, resolve); break;
          case 'apply': await opApply(step.op, step.params, ctx, resolve); break;
        }
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [MODEL_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    await withRetry(
      async () => {
        safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
        return undefined;
      },
      buildRetryOptions(),
    );
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, ctx: any, options: any, state: any, resolve: (value: any) => any) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipeline(params.then, ctx, options, state);
        return res.context;
      } else if (params.else) {
        const res = await executePipeline(params.else, ctx, options, state);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipeline(params.pipeline, ctx, options, state);
        ctx = res.context;
        iterations++;
      }
      return ctx;

    default: return ctx;
  }
}

/**
 * CAPTURE Operators
 */
async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_json':
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: await withRetry(
          async () => JSON.parse(safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string),
          buildRetryOptions(),
        ),
      };
    case 'read_file':
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await withRetry(
          async () => safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }),
          buildRetryOptions(),
        ),
      };
    case 'glob_files':
      return {
        ...ctx,
        [params.export_as || 'file_list']: await withRetry(
          async () => getAllFiles(path.resolve(rootDir, resolve(params.dir))).filter(f => !params.ext || f.endsWith(params.ext)).map(f => path.relative(rootDir, f)),
          buildRetryOptions(),
        ),
      };
    case 'shell':
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await withRetry(
          async () => execSync(resolve(params.cmd), { encoding: 'utf8' }).trim(),
          buildRetryOptions(),
        ),
      };
    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'ajv_validate':
      const validate = ajv.compile(ctx[params.schema_from || 'last_schema_data']);
      const valid = validate(ctx[params.data_from || 'last_capture_data']);
      return { ...ctx, [params.export_as || 'is_valid']: valid, [params.errors_as || 'validation_errors']: validate.errors };
    case 'json_query':
      const res = getPathValue(ctx[params.from || 'last_capture_data'], params.path);
      return { ...ctx, [params.export_as]: res };
    case 'mermaid_gen':
      const items = ctx[params.from || 'skills_list'] || [];
      let mermaid = 'graph TD\n';
      items.forEach((item: any) => { mermaid += `  ${item.n.replace(/-/g, '_')}["${item.n}"]\n`; });
      return { ...ctx, [params.export_as || 'last_transform']: mermaid };
    case 'web_profile_to_ui_flow_adf': {
      const profile = ctx[params.from || 'last_capture_data'];
      if (!profile || typeof profile !== 'object') {
        throw new Error('web_profile_to_ui_flow_adf requires a web app profile object');
      }
      const base = String(profile.base_url || '');
      const loginRoute = String(profile.login_route || '/login');
      const logoutRoute = String(profile.logout_route || '/logout');
      const guardedRoutes = Array.isArray(profile.guarded_routes) ? profile.guarded_routes.map(String) : [];
      const debugRoute = String(profile.debug_routes?.session_export || '/__kyberion/session-export');
      const states = [
        {
          id: 'login',
          kind: 'route',
          path: loginRoute,
          selectors: profile.selectors?.login || {},
        },
        ...guardedRoutes.map((route: string) => ({
          id: route.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'guarded_route',
          kind: 'route',
          path: route,
          guard: 'authenticated',
          selectors: profile.selectors?.navigation || {},
        })),
        {
          id: 'logout',
          kind: 'route',
          path: logoutRoute,
        },
        {
          id: 'session_export',
          kind: 'debug',
          path: debugRoute,
          guard: 'debug_only',
        },
      ];

      const transitions = [
        {
          id: 'login_success',
          from: 'login',
          to: states.find((state: any) => state.id !== 'login' && state.kind === 'route' && state.guard === 'authenticated')?.id || 'login',
          action: 'submit_login',
          expected: 'authenticated route is reachable',
        },
        ...guardedRoutes.map((route: string) => ({
          id: `guard_redirect_${route.replace(/[^\w]+/g, '_')}`,
          from: 'login',
          to: route.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'guarded_route',
          action: `navigate ${base}${route}`,
          guard: 'authenticated',
          expected: 'redirects to login when unauthenticated or loads route when authenticated',
        })),
        {
          id: 'logout_transition',
          from: states.find((state: any) => state.id !== 'login' && state.kind === 'route' && state.guard === 'authenticated')?.id || 'login',
          to: 'logout',
          action: 'trigger_logout',
          expected: 'session cleared and login route shown',
        },
        {
          id: 'session_export_transition',
          from: states.find((state: any) => state.id !== 'login' && state.kind === 'route' && state.guard === 'authenticated')?.id || 'login',
          to: 'session_export',
          action: 'open_debug_session_export',
          guard: 'debug_only',
          expected: 'session handoff artifact is returned',
        },
      ];

      return {
        ...ctx,
        [params.export_as || 'ui_flow_adf']: {
          kind: 'ui-flow-adf',
          app_id: String(profile.app_id || 'web-app'),
          platform: 'browser',
          entry_state: 'login',
          states,
          transitions,
        },
      };
    }
    case 'ui_flow_to_test_inventory': {
      const flow = ctx[params.from || 'ui_flow_adf'];
      if (!flow || typeof flow !== 'object' || !Array.isArray(flow.transitions)) {
        throw new Error('ui_flow_to_test_inventory requires a ui-flow-adf object');
      }
      const cases = flow.transitions.map((transition: any, index: number) => ({
        case_id: `TC-${String(index + 1).padStart(3, '0')}`,
        title: transition.id,
        objective: transition.expected || `validate transition ${transition.id}`,
        steps: [
          `Open state ${transition.from}`,
          `Perform action ${transition.action}`,
          transition.guard ? `Satisfy guard ${transition.guard} when needed` : 'No additional guard required',
        ],
        expected: [
          `Transition reaches ${transition.to}`,
          transition.expected || 'Observed state matches transition expectation',
        ],
        automation_backend: flow.platform || 'browser',
      }));
      return {
        ...ctx,
        [params.export_as || 'test_case_inventory']: {
          kind: 'test-case-adf',
          app_id: String(flow.app_id || 'unknown-app'),
          cases,
        },
      };
    }
    case 'test_inventory_to_browser_pipeline': {
      const flow = ctx[params.ui_flow_from || 'ui_flow_adf'];
      const tests = ctx[params.from || 'test_case_inventory'];
      const profile = ctx[params.profile_from || 'web_profile'];
      if (!flow || typeof flow !== 'object' || !Array.isArray(flow.states)) {
        throw new Error('test_inventory_to_browser_pipeline requires a ui-flow-adf object');
      }
      if (!tests || typeof tests !== 'object' || !Array.isArray(tests.cases)) {
        throw new Error('test_inventory_to_browser_pipeline requires a test-case-adf object');
      }
      if (!profile || typeof profile !== 'object') {
        throw new Error('test_inventory_to_browser_pipeline requires a web app profile object');
      }
      const presetCatalog = await loadBrowserExecutionPresetCatalog();
      const presetName = String(profile.execution_preset || params.preset || presetCatalog.default_preset || 'standard-web-auth');
      const executionPreset = presetCatalog.presets?.[presetName] || {};

      const baseUrl = String(profile.base_url || '');
      const loginRoute = String(profile.login_route || '/login');
      const logoutRoute = String(profile.logout_route || '/logout');
      const loginSelectors = profile.selectors?.login || {};
      const guardedStates = (flow.states || []).filter((state: any) => state.kind === 'route' && state.guard === 'authenticated');
      const sessionExportState = (flow.states || []).find((state: any) => state.kind === 'debug' && String(state.path || '').includes('session-export'));
      const steps: any[] = [
        {
          type: 'capture',
          op: 'goto',
          params: {
            url: `${baseUrl}${loginRoute}`,
            waitUntil: 'domcontentloaded',
          },
        },
      ];

      if (loginSelectors.email && loginSelectors.password && loginSelectors.submit) {
        steps.push(
          {
            type: 'apply',
            op: 'fill',
            params: {
              selector: String(loginSelectors.email),
              text: params.default_email || executionPreset.default_email || 'tester@example.com',
            },
          },
          {
            type: 'apply',
            op: 'fill',
            params: {
              selector: String(loginSelectors.password),
              text: params.default_password || executionPreset.default_password || 'debug-password',
            },
          },
          {
            type: 'apply',
            op: 'click',
            params: {
              selector: String(loginSelectors.submit),
            },
          },
          {
            type: 'capture',
            op: 'snapshot',
            params: {
              export_as: 'post_login_snapshot',
              max_elements: 80,
            },
          },
        );
      }

      guardedStates.forEach((state: any) => {
        steps.push(
          {
            type: 'capture',
            op: 'goto',
            params: {
              url: `${baseUrl}${state.path}`,
              waitUntil: 'domcontentloaded',
            },
          },
          {
            type: 'capture',
            op: 'snapshot',
            params: {
              export_as: `${state.id}_snapshot`,
              max_elements: 80,
            },
          },
        );
      });

      if (sessionExportState) {
        steps.push(
          {
            type: 'capture',
            op: 'goto',
            params: {
              url: `${baseUrl}${sessionExportState.path}`,
              waitUntil: 'domcontentloaded',
            },
          },
          {
            type: 'capture',
            op: 'content',
            params: {
              export_as: 'debug_session_export_payload',
            },
          },
          {
            type: 'capture',
            op: 'export_session_handoff',
            params: {
              path: params.handoff_output_path || executionPreset.handoff_output_path || 'active/shared/tmp/browser/generated-web-session-handoff.json',
              browser_session_id: String(profile.app_id || 'generated-web-session'),
              prefer_persistent_context: true,
              export_as: 'generated_session_handoff',
            },
          },
        );
      }

      steps.push(
        {
          type: 'capture',
          op: 'goto',
          params: {
            url: `${baseUrl}${logoutRoute}`,
            waitUntil: 'domcontentloaded',
          },
        },
        {
          type: 'capture',
          op: 'snapshot',
          params: {
            export_as: 'post_logout_snapshot',
            max_elements: 80,
          },
        },
      );

      return {
        ...ctx,
        [params.export_as || 'browser_execution_pipeline']: {
          action: 'pipeline',
          session_id: String(profile.app_id || 'generated-browser-plan'),
          options: {
            headless: params.headless !== false,
          },
          context: {
            generated_from: String(profile.app_id || 'unknown-app'),
            case_count: tests.cases.length,
          },
          steps,
        },
      };
    }
    case 'terraform_to_architecture_adf': {
      const rootDir = pathResolver.rootDir();
      const terraformRoot = path.resolve(rootDir, resolve(params.dir || params.path || ctx[params.from || 'terraform_root']));
      const title = resolve(params.title) || path.basename(terraformRoot);
      return {
        ...ctx,
        [params.export_as || 'architecture_adf']: terraformToArchitectureAdf(terraformRoot, { title }),
      };
    }
    case 'terraform_to_topology_ir': {
      const rootDir = pathResolver.rootDir();
      const terraformRoot = path.resolve(rootDir, resolve(params.dir || params.path || ctx[params.from || 'terraform_root']));
      const title = resolve(params.title) || path.basename(terraformRoot);
      return {
        ...ctx,
        [params.export_as || 'topology_ir']: terraformToTopologyIr(terraformRoot, { title }),
      };
    }
    default: return ctx;
  }
}

async function loadBrowserExecutionPresetCatalog(): Promise<{ default_preset?: string; presets: Record<string, any> }> {
  if (safeExistsSync(BROWSER_EXECUTION_PRESETS_PATH)) {
    try {
      const parsed = await withRetry(
        async () => JSON.parse(safeReadFile(BROWSER_EXECUTION_PRESETS_PATH, { encoding: 'utf8' }) as string),
        buildRetryOptions(),
      );
      if (parsed && typeof parsed === 'object' && parsed.presets) return parsed;
    } catch (_) {}
  }

  return {
    default_preset: 'standard-web-auth',
    presets: {
      'standard-web-auth': {
        default_email: 'tester@example.com',
        default_password: 'debug-password',
        handoff_output_path: 'active/shared/tmp/browser/generated-web-session-handoff.json',
      },
    },
  };
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const outPath = path.resolve(rootDir, spec.path);
      const content = spec.content;
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      await withRetry(
        async () => {
          safeWriteFile(outPath, typeof content === 'string' ? content : content === undefined ? '' : JSON.stringify(content, null, 2));
          return undefined;
        },
        buildRetryOptions(),
      );
      break;
    case 'log':
      logger.info(`[MODELING_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: ModelingAction) {
  const strategyPath = pathResolver.rootResolve(input.strategy_path || 'knowledge/governance/modeling-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = await withRetry(
    async () => JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string),
    buildRetryOptions(),
  );
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputContent = await withRetry(
    async () => safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string,
    buildRetryOptions(),
  );
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
