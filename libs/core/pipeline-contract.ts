import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

export interface PipelineStepResult {
  op: string;
  status: 'success' | 'failed' | 'skipped' | 'recovered';
  error?: string;
}

export interface StepHook {
  type: 'actuator_op' | 'http' | 'command';
  label?: string;
  on_reject?: 'abort' | 'skip' | 'warn';
  // actuator_op
  op?: string;
  params?: Record<string, unknown>;
  // http
  url?: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  // command
  cmd?: string;
}

export interface PipelineStepBudget {
  cost_cap_tokens?: number;
  max_prompt_chars?: number;
  max_response_chars?: number;
  max_combined_chars?: number;
  approval_required?: boolean;
  /** Context key containing a persisted, step-bound approval decision. */
  approval_ref?: string;
}

export interface PipelineStepReasoning {
  provider?: string;
  mode?: string;
  profile?: string;
  model?: string;
  model_tier?: 'fast' | 'standard' | 'deep';
  permission_mode?: 'readonly' | 'edit' | 'full';
  capability_profile?: string;
  tags?: string[];
  promotion?: Array<{
    after_failures?: number;
    after_iterations?: number;
    provider?: string;
    mode?: string;
    profile?: string;
    model?: string;
  }>;
}

export interface PipelineStepFacets {
  persona?: string;
  policies?: string[];
  instructions?: string[];
  output_contract?: string;
}

export interface PipelineStepReport {
  schema_ref: string;
  use_judge?: boolean;
  order?: number;
  export_as?: string;
}

export type FlowRole = 'source' | 'transform' | 'sink' | 'gate';

/** Maps legacy type values to Typed Flow roles. */
export const ROLE_FROM_TYPE: Record<string, FlowRole> = {
  capture: 'source',
  transform: 'transform',
  apply: 'sink',
  control: 'gate',
};

export interface FlowChannel {
  channel: string;
  /** Optional data type hint for documentation and future validation. */
  type?: string;
}

export interface PipelineAdfStep {
  op: string;
  params: Record<string, unknown>;
  id?: string;
  /** Display name / documentation only. */
  name?: string;
  /** Author note; ignored by the runtime. */
  comment?: string;
  effort?: 'low' | 'medium' | 'high';
  budget?: PipelineStepBudget;
  /** Optional per-operation execution budget declared by the op definition. */
  timeout_ms?: number;
  reasoning?: PipelineStepReasoning;
  facets?: PipelineStepFacets;
  /** Optional perform -> report phase contract. */
  report?: PipelineStepReport | PipelineStepReport[];
  /** Typed Flow node role. Preferred over `type`. */
  role?: FlowRole;
  /** Legacy role alias. Prefer `role`. capture→source, transform→transform, apply→sink, control→gate. */
  type?: 'capture' | 'transform' | 'apply' | 'control';
  /** Channel this step emits. Preferred over params.export_as. */
  produces?: string | FlowChannel;
  /** Channel(s) this step reads from upstream steps. Validated before execution. */
  consumes?: string | string[];
  /** Explicit control dependencies. Omit for legacy implicit linear flow. */
  depends_on?: string[];
  /** Explicit shared-resource claims; omitted means no graph-level claim. */
  resource_claims?: string[];
  /** Structured condition for a graph edge/node. False skips downstream work. */
  when?: {
    from?: string;
    operator?: string;
    value?: unknown;
    conditions?: unknown[];
    label?: string;
    field?: string;
    eq?: unknown;
    in?: unknown[];
    matches?: string;
  };
  /** Fan-in context merge policy. */
  merge?: 'collect' | 'namespace' | 'last';
  on_error?: {
    strategy: 'skip' | 'abort' | 'fallback';
    fallback?: PipelineAdfStep[];
    ref?: string;
    bind?: Record<string, unknown>;
    /** Operator-facing hint shown when the step fails; ignored by the runtime. */
    remediation?: string;
  };
  hooks?: {
    before?: StepHook[];
    after?: StepHook[];
  };
}

export interface PipelineSchedule {
  cron: string;
  timezone?: string;
  enabled?: boolean;
  id?: string;
  deliver_to?: {
    surface: string;
    channel: string;
    thread_ts?: string;
    template?: string;
  };
}

export interface PipelineAdf {
  action?: 'pipeline';
  name?: string;
  description?: string;
  context?: Record<string, unknown>;
  /** Knowledge tier/customer scope propagated to wisdom:* ops (run_pipeline). */
  knowledge_scope?: unknown;
  /** Env vars applied when a template is executed (e.g. persona/role). */
  env?: Record<string, string>;
  /** Browser/session pipelines: logical session identifier. */
  session_id?: string;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
    max_concurrency?: number;
  };
  steps: PipelineAdfStep[];
  schedule?: PipelineSchedule;
}

const PIPELINE_ADF_SCHEMA_PATH = pathResolver.knowledge('product/schemas/pipeline-adf.schema.json');
const pipelineAdfCatalog = defineCatalog<PipelineAdf>({
  id: 'pipeline-adf',
  path: () => PIPELINE_ADF_SCHEMA_PATH,
  schema: PIPELINE_ADF_SCHEMA_PATH,
});

function pipelineAdfCatalogAtPath(filePath: string) {
  return defineCatalog<PipelineAdf>({
    id: 'pipeline-adf',
    path: filePath,
    schema: PIPELINE_ADF_SCHEMA_PATH,
  });
}

function invalidPipelineAdf(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const details = message.replace(/^Invalid catalog pipeline-adf at [^:]+:\s*/u, '');
  throw new Error(`Invalid pipeline ADF: ${details}`);
}

export function validatePipelineAdf(input: unknown): PipelineAdf {
  try {
    return pipelineAdfCatalog.validate(input, 'pipeline ADF');
  } catch (error) {
    return invalidPipelineAdf(error);
  }
}

/** Load one persisted pipeline ADF through the canonical schema boundary. */
export function loadPipelineAdfAtPath(filePath: string): PipelineAdf {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[PIPELINE_ADF] pipeline must be a regular file: ${filePath}`);
  }
  try {
    return pipelineAdfCatalogAtPath(safeFilePath).load();
  } catch (error) {
    return invalidPipelineAdf(error);
  }
}

export function derivePipelineStatus(results: PipelineStepResult[]): 'succeeded' | 'failed' {
  return results.some((result) => result.status === 'failed') ? 'failed' : 'succeeded';
}
