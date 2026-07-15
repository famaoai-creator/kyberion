import AjvModule, { type ValidateFunction } from 'ajv';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

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
  /** Typed Flow node role. Preferred over `type`. */
  role?: FlowRole;
  /** Legacy role alias. Prefer `role`. capture→source, transform→transform, apply→sink, control→gate. */
  type?: 'capture' | 'transform' | 'apply' | 'control';
  /** Channel this step emits. Preferred over params.export_as. */
  produces?: string | FlowChannel;
  /** Channel(s) this step reads from upstream steps. Validated before execution. */
  consumes?: string | string[];
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
  };
  steps: PipelineAdfStep[];
  schedule?: PipelineSchedule;
}

let validatePipelineFn: ValidateFunction | null = null;
const Ajv = AjvModule as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

function getPipelineValidator() {
  if (validatePipelineFn) return validatePipelineFn;

  const schemaPath = pathResolver.knowledge('product/schemas/pipeline-adf.schema.json');
  const schema = JSON.parse(safeReadFile(schemaPath, { encoding: 'utf8' }) as string);
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  validatePipelineFn = ajv.compile(schema);
  return validatePipelineFn;
}

export function validatePipelineAdf(input: unknown): PipelineAdf {
  const validate = getPipelineValidator();
  const valid = validate(input);
  if (!valid) {
    const details = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF: ${details}`);
  }
  return input as PipelineAdf;
}

export function derivePipelineStatus(results: PipelineStepResult[]): 'succeeded' | 'failed' {
  return results.some((result) => result.status === 'failed') ? 'failed' : 'succeeded';
}
