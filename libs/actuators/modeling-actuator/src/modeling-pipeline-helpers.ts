import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  executeAdfSteps,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  resolveWriteArtifactSpec,
  retry,
  buildGovernedRetryOptions,
  runGovernedCommand,
  classifyError,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import * as path from 'node:path';
import * as AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { terraformToArchitectureAdf } from './terraform-architecture.js';
import { terraformToTopologyIr } from './terraform-topology.js';
import {
  deriveTestInventory,
  evaluateArchitectureReady,
  evaluateCustomerSignoff,
  evaluateQaReady,
  evaluateRequirementsCompleteness,
  extractDesignSpec,
  extractRequirements,
  extractTestPlan,
} from './sdlc-ops.js';
import type { SoftwareQualityContract } from '@agent/core';

const MODEL_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/modeling-actuator/manifest.json'
);
const DEFAULT_MODEL_RETRY = {
  maxRetries: 2,
  initialDelayMs: 150,
  maxDelayMs: 1200,
  factor: 2,
  jitter: true,
};

export function buildRetryOptions() {
  return buildGovernedRetryOptions({
    manifestPath: MODEL_MANIFEST_PATH,
    defaults: DEFAULT_MODEL_RETRY,
    fallbackCategories: ['resource_unavailable', 'timeout'],
  });
}

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const ajv = new AjvCtor({ allErrors: true });
addFormats(ajv);
const BROWSER_EXECUTION_PRESETS_PATH = pathResolver.knowledge(
  'product/orchestration/browser-execution-presets.json'
);

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export interface ModelingAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

// AR-01 Task 2: hand-rolled loop replaced by the canonical engine
// (executeAdfSteps). Nested control failures now propagate instead of being
// silently absorbed (AR-06 no-silent-failure).
export async function executePipeline(
  steps: PipelineStep[],
  initialCtx: any = {},
  options: any = {}
) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };

  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = await retry(
      async () =>
        JSON.parse(
          safeReadFile(path.resolve(rootDir, initialCtx.context_path), {
            encoding: 'utf8',
          }) as string
        ),
      buildRetryOptions()
    );
    ctx = { ...ctx, ...saved };
  }

  const result = await executeAdfSteps(
    steps as Parameters<typeof executeAdfSteps>[0],
    ctx,
    { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    {
      capture: opCapture,
      transform: opTransform,
      apply: async (op, params, currentCtx, resolve) =>
        await opApply(op, params, currentCtx, resolve),
      control: opControl,
    }
  );
  ctx = result.context;

  if (initialCtx.context_path) {
    await retry(async () => {
      safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
      return undefined;
    }, buildRetryOptions());
  }

  return result;
}

async function opControl(
  op: string,
  params: any,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>,
  _resolve: (value: any) => any
) {
  const runNested = async (steps: any[], seedCtx: any) => {
    const res = await runSteps(steps, seedCtx);
    if (res.status === 'failed') {
      throw new Error(
        res.results.find((entry: any) => entry.status === 'failed')?.error ||
          'nested pipeline failed'
      );
    }
    return res.context;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then, ctx);
      } else if (params.else) {
        return await runNested(params.else, ctx);
      }
      return ctx;

    case 'while': {
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        ctx = await runNested(params.pipeline, ctx);
        iterations++;
      }
      return ctx;
    }

    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_json':
      return {
        ...ctx,
        [params.export_as || 'last_capture_data']: await retry(
          async () =>
            JSON.parse(
              safeReadFile(path.resolve(rootDir, resolve(params.path)), {
                encoding: 'utf8',
              }) as string
            ),
          buildRetryOptions()
        ),
      };
    case 'read_file':
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await retry(
          async () =>
            safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }),
          buildRetryOptions()
        ),
      };
    case 'glob_files':
      return {
        ...ctx,
        [params.export_as || 'file_list']: await retry(
          async () =>
            getAllFiles(path.resolve(rootDir, resolve(params.dir)))
              .filter((f) => !params.ext || f.endsWith(params.ext))
              .map((f) => path.relative(rootDir, f)),
          buildRetryOptions()
        ),
      };
    case 'shell':
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await retry(async () => {
          const result = runGovernedCommand('/bin/sh', ['-c', resolve(params.cmd)]);
          if (result.error || result.status !== 0) {
            throw (
              result.error ||
              new Error(result.stderr || `Command failed with exit code ${result.status}`)
            );
          }
          return result.stdout.trim();
        }, buildRetryOptions()),
      };
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'ajv_validate':
      const validate = ajv.compile(ctx[params.schema_from || 'last_schema_data']);
      const valid = validate(ctx[params.data_from || 'last_capture_data']);
      return {
        ...ctx,
        [params.export_as || 'is_valid']: valid,
        [params.errors_as || 'validation_errors']: validate.errors,
      };
    case 'json_query':
      const res = getPathValue(ctx[params.from || 'last_capture_data'], params.path);
      return { ...ctx, [params.export_as]: res };
    case 'mermaid_gen':
      const items = ctx[params.from || 'skills_list'] || [];
      let mermaid = 'graph TD\n';
      items.forEach((item: any) => {
        mermaid += `  ${item.n.replace(/-/g, '_')}["${item.n}"]\n`;
      });
      return { ...ctx, [params.export_as || 'last_transform']: mermaid };
    case 'web_profile_to_ui_flow_adf': {
      const profile = ctx[params.from || 'last_capture_data'];
      if (!profile || typeof profile !== 'object') {
        throw new Error('web_profile_to_ui_flow_adf requires a web app profile object');
      }
      const base = String(profile.base_url || '');
      const loginRoute = String(profile.login_route || '/login');
      const logoutRoute = String(profile.logout_route || '/logout');
      const guardedRoutes = Array.isArray(profile.guarded_routes)
        ? profile.guarded_routes.map(String)
        : [];
      const debugRoute = String(
        profile.debug_routes?.session_export || '/__kyberion/session-export'
      );
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
          to:
            states.find(
              (state: any) =>
                state.id !== 'login' && state.kind === 'route' && state.guard === 'authenticated'
            )?.id || 'login',
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
          from:
            states.find(
              (state: any) =>
                state.id !== 'login' && state.kind === 'route' && state.guard === 'authenticated'
            )?.id || 'login',
          to: 'logout',
          action: 'trigger_logout',
          expected: 'session cleared and login route shown',
        },
        {
          id: 'session_export_transition',
          from:
            states.find(
              (state: any) =>
                state.id !== 'login' && state.kind === 'route' && state.guard === 'authenticated'
            )?.id || 'login',
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
          transition.guard
            ? `Satisfy guard ${transition.guard} when needed`
            : 'No additional guard required',
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
      const presetName = String(
        profile.execution_preset ||
          params.preset ||
          presetCatalog.default_preset ||
          'standard-web-auth'
      );
      const executionPreset = presetCatalog.presets?.[presetName] || {};

      const baseUrl = String(profile.base_url || '');
      const loginRoute = String(profile.login_route || '/login');
      const logoutRoute = String(profile.logout_route || '/logout');
      const loginSelectors = profile.selectors?.login || {};
      const guardedStates = (flow.states || []).filter(
        (state: any) => state.kind === 'route' && state.guard === 'authenticated'
      );
      const sessionExportState = (flow.states || []).find(
        (state: any) =>
          state.kind === 'debug' && String(state.path || '').includes('session-export')
      );
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
          }
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
          }
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
              path:
                params.handoff_output_path ||
                executionPreset.handoff_output_path ||
                'active/shared/tmp/browser/generated-web-session-handoff.json',
              browser_session_id: String(profile.app_id || 'generated-web-session'),
              prefer_persistent_context: true,
              export_as: 'generated_session_handoff',
            },
          }
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
        }
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
    case 'test_inventory_to_device_pipeline': {
      const tests = ctx[params.from || 'test_case_inventory'];
      const profile = ctx[params.profile_from || 'app_profile'];
      const platform = String(params.platform || profile?.platform || '');
      if (!tests || typeof tests !== 'object' || !Array.isArray(tests.cases)) {
        throw new Error('test_inventory_to_device_pipeline requires a test-case-adf object');
      }
      if (platform !== 'android' && platform !== 'ios') {
        throw new Error("test_inventory_to_device_pipeline requires platform 'android' | 'ios'");
      }
      if (!profile || typeof profile !== 'object') {
        throw new Error('test_inventory_to_device_pipeline requires an app profile object');
      }
      return {
        ...ctx,
        [params.export_as || 'device_execution_pipeline']: compileTestInventoryToDevicePipeline(
          tests as { app_id?: string; cases: TestInventoryCase[] },
          profile,
          {
            platform,
            artifactsDir: String(
              params.artifacts_dir || profile.artifacts_dir || 'active/shared/tmp/test-runs'
            ),
          }
        ),
      };
    }
    case 'terraform_to_architecture_adf': {
      const rootDir = pathResolver.rootDir();
      const terraformRoot = path.resolve(
        rootDir,
        resolve(params.dir || params.path || ctx[params.from || 'terraform_root'])
      );
      const title = resolve(params.title) || path.basename(terraformRoot);
      return {
        ...ctx,
        [params.export_as || 'architecture_adf']: terraformToArchitectureAdf(terraformRoot, {
          title,
        }),
      };
    }
    case 'terraform_to_topology_ir': {
      const rootDir = pathResolver.rootDir();
      const terraformRoot = path.resolve(
        rootDir,
        resolve(params.dir || params.path || ctx[params.from || 'terraform_root'])
      );
      const title = resolve(params.title) || path.basename(terraformRoot);
      return {
        ...ctx,
        [params.export_as || 'topology_ir']: terraformToTopologyIr(terraformRoot, { title }),
      };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function loadBrowserExecutionPresetCatalog(): Promise<{
  default_preset?: string;
  presets: Record<string, any>;
}> {
  if (safeExistsSync(BROWSER_EXECUTION_PRESETS_PATH)) {
    try {
      const parsed = await retry(
        async () =>
          JSON.parse(safeReadFile(BROWSER_EXECUTION_PRESETS_PATH, { encoding: 'utf8' }) as string),
        buildRetryOptions()
      );
      if (parsed && typeof parsed === 'object' && parsed.presets) return parsed;
    } catch (err) {
      logger.warn(
        `[modeling-pipeline-helpers] suppressed error in loadBrowserExecutionPresetCatalog: ${err}`
      );
    }
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

async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const outPath = path.resolve(rootDir, spec.path);
      const content = spec.content;
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      await retry(async () => {
        safeWriteFile(
          outPath,
          typeof content === 'string'
            ? content
            : content === undefined
              ? ''
              : JSON.stringify(content, null, 2)
        );
        return undefined;
      }, buildRetryOptions());
      break;
    case 'extract_requirements': {
      const result = await extractRequirements({
        mission_id: resolve(params.mission_id),
        project_name: resolve(params.project_name),
        source_path: resolve(params.source_path) || resolve(params.transcript_path),
        source_type: resolve(params.source_type),
        language: resolve(params.language),
        customer_name: resolve(params.customer_name),
        customer_person_slug: resolve(params.customer_person_slug),
        customer_org: resolve(params.customer_org),
        prior_draft_ref: resolve(params.prior_draft_ref),
      });
      return { ...ctx, [params.export_as || 'requirements_result']: result };
    }
    case 'extract_design_spec': {
      const result = await extractDesignSpec({
        mission_id: resolve(params.mission_id),
        project_name: resolve(params.project_name),
        requirements_draft_path: resolve(params.requirements_draft_path),
        additional_context: resolve(params.additional_context),
      });
      return { ...ctx, [params.export_as || 'design_spec_result']: result };
    }
    case 'extract_test_plan': {
      const result = await extractTestPlan({
        mission_id: resolve(params.mission_id),
        project_name: resolve(params.project_name),
        app_id: resolve(params.app_id),
        requirements_draft_path: resolve(params.requirements_draft_path),
        design_spec_path: resolve(params.design_spec_path),
      });
      return { ...ctx, [params.export_as || 'test_plan_result']: result };
    }
    case 'derive_test_inventory': {
      const contractPath = resolve(params.contract_path);
      const contract =
        params.contract ??
        ctx[params.contract_from || 'quality_contract'] ??
        (contractPath && safeExistsSync(pathResolver.rootResolve(contractPath))
          ? JSON.parse(
              safeReadFile(pathResolver.rootResolve(contractPath), { encoding: 'utf8' }) as string
            )
          : null);
      if (!contract) throw new Error('[derive_test_inventory] quality contract not found');
      const systemTags = params.system_tags ?? ctx[params.system_tags_from || 'system_tags'];
      const riskRefs = params.risk_refs ?? ctx[params.risk_refs_from || 'risk_refs'];
      const result = await deriveTestInventory({
        contract: contract as SoftwareQualityContract,
        system_tags: Array.isArray(systemTags) ? systemTags.map(String) : [],
        risk_refs: Array.isArray(riskRefs) ? riskRefs.map(String) : [],
        additional_context: resolve(params.additional_context),
        project_id: resolve(params.project_id) || undefined,
      });
      const outputPath = resolve(params.output_path);
      if (outputPath) {
        safeWriteFile(
          pathResolver.rootResolve(outputPath),
          `${JSON.stringify(result, null, 2)}\n`,
          { encoding: 'utf8' }
        );
      }
      return {
        ...ctx,
        [params.export_as || 'test_inventory']: result,
        ...(outputPath ? { written_to: outputPath } : {}),
      };
    }
    case 'evaluate_requirements_completeness':
      return {
        ...ctx,
        [params.export_as || 'requirements_completeness']: evaluateRequirementsCompleteness(
          resolve(params.mission_id)
        ),
      };
    case 'evaluate_customer_signoff':
      return {
        ...ctx,
        [params.export_as || 'customer_signoff']: evaluateCustomerSignoff(
          resolve(params.mission_id)
        ),
      };
    case 'evaluate_architecture_ready':
      return {
        ...ctx,
        [params.export_as || 'architecture_ready']: evaluateArchitectureReady(
          resolve(params.mission_id)
        ),
      };
    case 'evaluate_qa_ready': {
      const mustHaveIds = params.must_have_ids ?? ctx[params.must_have_ids_from || 'must_have_ids'];
      return {
        ...ctx,
        [params.export_as || 'qa_ready']: evaluateQaReady(
          resolve(params.mission_id),
          Array.isArray(mustHaveIds) ? mustHaveIds.map(String) : []
        ),
      };
    }
    case 'log':
      logger.info(`[MODELING_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
  return ctx;
}

export async function performReconcile(input: ModelingAction) {
  const strategyPath = pathResolver.rootResolve(
    input.strategy_path || 'knowledge/product/governance/modeling-strategy.json'
  );
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = await retry(
    async () => JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string),
    buildRetryOptions()
  );
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

// ---------------------------------------------------------------------------
// E2E-05 Task 5: test-case-adf → device execution pipeline compiler.
// android: full step compilation (find/tap/input + text assertions +
// per-case screenshot). ios: deep-link navigation + screenshot evidence only —
// richer iOS UI-interaction ops are documented residual work in the plan.
// ---------------------------------------------------------------------------

export interface TestInventoryCase {
  case_id: string;
  title: string;
  objective: string;
  steps: string[];
  expected: string[];
  automation_backend?: 'browser' | 'android' | 'ios';
}

interface DevicePipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: Record<string, unknown>;
}

function extractQuotedTarget(text: string): string {
  const quoted = text.match(/"([^"]+)"|「([^」]+)」/);
  return (quoted?.[1] || quoted?.[2] || text).trim();
}

function compileAndroidStep(stepText: string): DevicePipelineStep[] {
  const input =
    stepText.match(/input\s+"([^"]+)"\s+into\s+"([^"]+)"/i) ||
    stepText.match(/「([^」]+)」を「([^」]+)」に入力/);
  if (input) {
    const [, value, field] = input;
    return [
      { type: 'capture', op: 'extract_ui_tree', params: {} },
      { type: 'transform', op: 'find_ui_nodes', params: { text: field } },
      { type: 'apply', op: 'input_text_into_ui_node', params: { text: value } },
    ];
  }
  const target = extractQuotedTarget(stepText);
  return [
    { type: 'capture', op: 'extract_ui_tree', params: {} },
    { type: 'transform', op: 'find_ui_nodes', params: { text: target } },
    { type: 'apply', op: 'tap_ui_node', params: { text: target } },
  ];
}

export function compileTestInventoryToDevicePipeline(
  tests: { app_id?: string; cases: TestInventoryCase[] },
  profile: Record<string, any>,
  options: { platform: string; artifactsDir: string }
): { action: 'pipeline'; context: Record<string, unknown>; steps: DevicePipelineStep[] } {
  const { platform, artifactsDir } = options;
  const steps: DevicePipelineStep[] = [];
  const cases = tests.cases.filter(
    (entry) => !entry.automation_backend || entry.automation_backend === platform
  );

  for (const testCase of cases) {
    if (platform === 'android') {
      const component = String(profile.launch_component || profile.component || '');
      steps.push({
        type: 'apply',
        op: 'launch_app',
        params: component
          ? { component }
          : { component: `${profile.package || tests.app_id}/.MainActivity` },
      });
      for (const stepText of testCase.steps) {
        steps.push(...compileAndroidStep(stepText));
      }
      for (const expectation of testCase.expected) {
        steps.push({
          type: 'apply',
          op: 'wait_for_ui_text',
          params: { text: extractQuotedTarget(expectation), timeout_ms: 10_000 },
        });
      }
    } else {
      steps.push(
        { type: 'apply', op: 'boot_simulator', params: {} },
        ...(profile.app_path
          ? [{ type: 'apply' as const, op: 'install_app', params: { app_path: profile.app_path } }]
          : []),
        {
          type: 'apply',
          op: 'launch_app',
          params: { bundle_id: profile.bundle_id || tests.app_id },
        }
      );
      for (const stepText of testCase.steps) {
        const deepLink = stepText.match(/open\s+(\S+:\/\/\S+)/i);
        if (deepLink) {
          steps.push({ type: 'apply', op: 'open_deep_link', params: { url: deepLink[1] } });
        } else if (profile.deep_link_base) {
          steps.push({
            type: 'apply',
            op: 'open_deep_link',
            params: { url: `${profile.deep_link_base}${extractQuotedTarget(stepText)}` },
          });
        } else {
          steps.push({
            type: 'control',
            op: 'log',
            params: {
              message: `iOS UI interaction not yet automated (residual: E2E-05 Task 5): ${stepText}`,
            },
          });
        }
      }
    }
    steps.push({
      type: 'capture',
      op: 'capture_screen',
      params: { path: `${artifactsDir}/${platform}-${testCase.case_id}.png` },
    });
  }

  return {
    action: 'pipeline',
    context: {
      generated_from: String(tests.app_id || 'unknown-app'),
      platform,
      case_count: cases.length,
      artifacts_dir: artifactsDir,
    },
    steps,
  };
}
