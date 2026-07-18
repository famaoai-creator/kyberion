import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  safeLstat,
  executeAdfSteps,
  resolveVars,
  evaluateCondition,
  resolveWriteArtifactSpec,
  pathResolver,
  loadCapabilityRegistry,
  scanProviderCapabilities,
  retry,
  buildGovernedRetryOptions,
  runGovernedCommand,
  classifyError,
  createActuatorTrace,
  finalizeActuatorTrace,
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import * as path from 'node:path';
import * as vm from 'node:vm';

const CODE_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/code-actuator/manifest.json');
const DEFAULT_CODE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 150,
  maxDelayMs: 1200,
  factor: 2,
  jitter: true,
};

export function buildRetryOptions() {
  return buildGovernedRetryOptions({
    manifestPath: CODE_MANIFEST_PATH,
    defaults: DEFAULT_CODE_RETRY,
    fallbackCategories: ['resource_unavailable', 'timeout'],
  });
}

/**
 * Code-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Generic data pipeline engine for source code analysis with Control Flow and Safety Guards.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const ALLOW_UNSAFE_JS = process.env.KYBERION_ALLOW_UNSAFE_JS === 'true';

function assertUnsafeShellAllowed() {
  if (!ALLOW_UNSAFE_SHELL) {
    throw new Error(
      '[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.'
    );
  }
}

function assertUnsafeJsAllowed() {
  if (!ALLOW_UNSAFE_JS) {
    throw new Error(
      '[SECURITY] JS execution disabled. Set KYBERION_ALLOW_UNSAFE_JS=true to enable.'
    );
  }
}

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export interface CodeAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

interface GlobalSkillIndexEntry {
  n: string;
  path: string;
  d: string;
  s: string;
  version?: string;
  capability_count?: number;
}

interface GlobalSkillIndex {
  v?: string;
  t?: number;
  u?: string;
  s?: GlobalSkillIndexEntry[];
}

export async function handleAction(input: CodeAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  const traceCtx = createActuatorTrace('code-actuator', 'pipeline');
  traceCtx.startSpan('code:pipeline', {
    stepCount: Array.isArray(input.steps) ? input.steps.length : 0,
  });
  try {
    const result = await executePipeline(
      input.steps || [],
      input.context || {},
      input.options,
      traceCtx
    );
    traceCtx.endSpan('ok');
    return { ...result, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'error',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

// AR-01 Task 2: hand-rolled loop replaced by the canonical engine. traceCtx
// span parity is preserved by wrapping each op handler (span per step, same
// code:<type>:<op> naming); nested control failures now propagate instead of
// being silently absorbed (AR-06 no-silent-failure).
export async function executePipeline(
  steps: PipelineStep[],
  initialCtx: any = {},
  options: any = {},
  traceCtx?: any
) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, root: rootDir };

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

  let spanCount = 0;
  const traced = async <T>(type: string, op: string, run: () => Promise<T>): Promise<T> => {
    spanCount += 1;
    traceCtx?.startSpan?.(`code:${type}:${op}`, { stepCount: spanCount });
    try {
      const value = await run();
      traceCtx?.endSpan?.('ok');
      return value;
    } catch (err: any) {
      traceCtx?.endSpan?.('error', err?.message ?? String(err));
      throw err;
    }
  };

  const result = await executeAdfSteps(
    steps as Parameters<typeof executeAdfSteps>[0],
    ctx,
    { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    {
      capture: (op, params, currentCtx, resolve) =>
        traced('capture', op, () => opCapture(op, params, currentCtx, resolve)),
      transform: (op, params, currentCtx, resolve) =>
        traced('transform', op, () => opTransform(op, params, currentCtx, resolve)),
      apply: (op, params, currentCtx, resolve) =>
        traced('apply', op, async () => {
          await opApply(op, params, currentCtx, resolve);
          return currentCtx;
        }),
      control: (op, params, currentCtx, runSteps, resolve) =>
        traced('control', op, () => opControl(op, params, currentCtx, runSteps, resolve)),
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
      assertUnsafeShellAllowed();
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await retry(async () => {
          const result = runGovernedCommand('/bin/sh', ['-c', resolve(params.cmd)], {
            maxOutputMB: 10,
          });
          if (result.error) throw result.error;
          if (result.status !== 0) {
            throw new Error(result.stderr || `Command failed with exit code ${result.status}`);
          }
          return String(result.stdout || '').trim();
        }, buildRetryOptions()),
      };
    case 'discover_capabilities':
      const actuatorsRootDir = path.join(rootDir, 'libs/actuators');
      const capabilities: any[] = [];
      if (safeExistsSync(actuatorsRootDir)) {
        const actuatorDirs = await retry(
          async () =>
            safeReaddir(actuatorsRootDir).filter((f) =>
              safeLstat(path.join(actuatorsRootDir, f)).isDirectory()
            ),
          buildRetryOptions()
        );
        for (const dir of actuatorDirs) {
          capabilities.push({
            name: dir,
            path: path.join('libs/actuators', dir),
            category: 'actuator',
          });
        }
      }
      capabilities.push(...discoverProviderCliCapabilities());
      return { ...ctx, [params.export_as || 'capabilities_list']: capabilities };
    case 'semgrep_scan':
      return {
        ...ctx,
        [params.export_as || 'semgrep_findings']: await retry(async () => {
          const target = path.resolve(rootDir, resolve(params.target_dir));
          const config = String(resolve(params.config) || 'auto');
          const args = ['--config', config, target, '--json'];
          const result = runGovernedCommand('semgrep', args, { maxOutputMB: 10 });
          if (result.error) {
            throw result.error;
          }
          const stdout = String(result.stdout || '');
          if (result.status !== 0 && !stdout) {
            throw new Error(
              `[SEMGREP_ERROR] Scan failed: ${result.stderr || `exit code ${result.status}`}`
            );
          }
          try {
            return JSON.parse(stdout);
          } catch {
            if (result.status === 0) {
              throw new Error('[SEMGREP_ERROR] Scan succeeded but did not return valid JSON.');
            }
            try {
              return JSON.parse(String(result.stderr || ''));
            } catch {
              throw new Error(
                `[SEMGREP_ERROR] Scan failed: ${result.stderr || `exit code ${result.status}`}`
              );
            }
          }
        }, buildRetryOptions()),
      };
    case 'discover_skills':
      return { ...ctx, [params.export_as || 'skills_list']: discoverGovernedSkills() };
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

function discoverProviderCliCapabilities(): any[] {
  const registry = loadCapabilityRegistry();
  return scanProviderCapabilities(registry, undefined, { includeUnavailable: false }).map(
    (capability) => ({
      name: capability.source.name,
      path: `${capability.source.provider} ${capability.source.name}`.trim(),
      category: capability.source.type,
      provider: capability.source.provider,
      capability_id: capability.capability_id,
      status: capability.discovery_status === 'available' ? capability.status : 'blocked',
      description: capability.notes || capability.capability_id,
      evidence: capability.evidence || capability.provider_probe.evidence,
      discovery_status: capability.discovery_status,
    })
  );
}

function discoverGovernedSkills(): any[] {
  const skillIndexPath = pathResolver.knowledge('product/orchestration/global_skill_index.json');
  if (!safeExistsSync(skillIndexPath)) {
    return [];
  }

  try {
    const raw = safeReadFile(skillIndexPath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as GlobalSkillIndex;
    const entries = Array.isArray(parsed.s) ? parsed.s : [];
    return entries.map((entry) => ({
      name: entry.n,
      path: entry.path,
      category: 'skill',
      description: entry.d,
      status: entry.s,
      version: entry.version || 'unknown',
      capability_count: entry.capability_count ?? 0,
      catalog: 'global_skill_index',
    }));
  } catch (err: any) {
    logger.warn(`[CODE_DISCOVERY] Failed to read global_skill_index.json: ${err?.message || err}`);
    return [];
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'regex_replace':
      return {
        ...ctx,
        [params.export_as || 'last_transform']: String(
          ctx[params.from || 'last_capture'] || ''
        ).replace(new RegExp(params.pattern, 'g'), resolve(params.template)),
      };
    case 'json_update':
      const json = JSON.parse(ctx[params.from || 'last_capture']);
      params.updates.forEach((u: any) => {
        json[u.key] = resolve(u.value);
      });
      return {
        ...ctx,
        [params.export_as || 'last_transform']: JSON.stringify(json, null, 2) + '\n',
      };
    case 'run_js':
      assertUnsafeJsAllowed();
      const sandbox = { Buffer, process: { env: { ...process.env } }, console, ctx: { ...ctx } };
      vm.createContext(sandbox);
      await new vm.Script(resolve(params.code)).runInContext(sandbox);
      return { ...sandbox.ctx };
    case 'impact_analysis':
      return {
        ...ctx,
        [params.export_as || 'impact_analysis']: await impactAnalysisOp({
          repo_path: String(
            resolve(params.repo_path) || ctx[params.repo_path_from || 'repo_path'] || ''
          ),
          requirements:
            params.requirements !== undefined
              ? resolve(params.requirements)
              : ctx[params.requirements_from || 'requirements_draft'],
          output_path: resolve(params.output_path),
        }),
      };
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

// ---------------------------------------------------------------------------
// E2E-06 Task 6: impact analysis — "既存資産への変更明記" as a first-class
// artifact. Deterministic file inventory + reasoning-backend judgment,
// validated into impact-analysis.schema.json shape. The size (S/M/L) feeds
// the price-book estimate_rules for quoting.
// ---------------------------------------------------------------------------

const IMPACT_CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.swift',
  '.kt',
  '.kts',
  '.java',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.md',
  '.yml',
  '.yaml',
  '.gradle',
]);

export interface ImpactAnalysisResult {
  kind: 'impact-analysis';
  generated_at: string;
  repo_path: string;
  summary: string;
  files: Array<{ path: string; change: string }>;
  risks: string[];
  size: 'S' | 'M' | 'L';
}

export async function impactAnalysisOp(input: {
  repo_path: string;
  requirements: unknown;
  output_path?: string;
}): Promise<ImpactAnalysisResult> {
  if (!input.repo_path) throw new Error('[impact_analysis] requires repo_path');
  if (!input.requirements) throw new Error('[impact_analysis] requires requirements');
  const rootDir = pathResolver.rootDir();
  const repoPath = path.resolve(rootDir, input.repo_path);
  if (!safeExistsSync(repoPath)) throw new Error(`[impact_analysis] repo not found: ${repoPath}`);
  const files = getAllFiles(repoPath)
    .filter((file) => IMPACT_CODE_EXTENSIONS.has(path.extname(file)))
    .filter((file) => !/node_modules|\.git\/|dist\//.test(file))
    .slice(0, 400)
    .map((file) => path.relative(repoPath, file));

  const { getReasoningBackend } = await import('@agent/core');
  const prompt = [
    'You are performing an impact analysis for a change request against an existing codebase.',
    'Return JSON only, exactly this shape:',
    '{ "summary": string, "files": [{ "path": string, "change": string }], "risks": string[], "size": "S" | "M" | "L" }',
    '- files: which existing files must change and how (paths MUST come from the inventory below)',
    '- size: S = hours, M = days, L = a week or more',
    '',
    '--- REPOSITORY FILE INVENTORY ---',
    files.join('\n'),
    '',
    '--- CHANGE REQUEST / REQUIREMENTS ---',
    typeof input.requirements === 'string'
      ? input.requirements
      : JSON.stringify(input.requirements, null, 1).slice(0, 8000),
  ].join('\n');

  const raw = await getReasoningBackend().prompt(prompt);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('[impact_analysis] backend did not return JSON');
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<ImpactAnalysisResult>;
  const size =
    parsed.size === 'S' || parsed.size === 'M' || parsed.size === 'L' ? parsed.size : 'M';
  const result: ImpactAnalysisResult = {
    kind: 'impact-analysis',
    generated_at: new Date().toISOString(),
    repo_path: input.repo_path,
    summary: String(parsed.summary || '').trim(),
    files: Array.isArray(parsed.files)
      ? parsed.files
          .filter((entry): entry is { path: string; change: string } =>
            Boolean(entry && typeof entry === 'object' && (entry as any).path)
          )
          .map((entry) => ({ path: String(entry.path), change: String(entry.change || '') }))
      : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
    size,
  };
  if (input.output_path) {
    const outPath = path.resolve(rootDir, input.output_path);
    if (!safeExistsSync(path.dirname(outPath)))
      safeMkdir(path.dirname(outPath), { recursive: true });
    safeWriteFile(outPath, JSON.stringify(result, null, 2));
  }
  return result;
}

async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const out = path.resolve(rootDir, spec.path);
      const content =
        typeof spec.content === 'string'
          ? spec.content
          : spec.content === undefined
            ? ''
            : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      await retry(async () => {
        safeWriteFile(out, content);
        return undefined;
      }, buildRetryOptions());
      break;
    case 'log':
      logger.info(`[CODE_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
}

async function performReconcile(input: CodeAction) {
  const strategyPath = path.resolve(
    pathResolver.rootDir(),
    input.strategy_path || 'knowledge/product/governance/code-strategy.json'
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
