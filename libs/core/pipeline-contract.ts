import AjvModule, { type ValidateFunction } from 'ajv';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

export interface PipelineStepResult {
  op: string;
  status: 'success' | 'failed';
  error?: string;
}

export interface PipelineAdfStep {
  op: string;
  params: Record<string, unknown>;
  id?: string;
  type?: 'capture' | 'transform' | 'apply' | 'control';
  on_error?: {
    strategy: 'skip' | 'abort' | 'fallback';
    fallback?: PipelineAdfStep[];
    ref?: string;
    bind?: Record<string, unknown>;
  };
}

export interface PipelineAdf {
  action?: 'pipeline';
  name?: string;
  description?: string;
  context?: Record<string, unknown>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
  steps: PipelineAdfStep[];
}

let validatePipelineFn: ValidateFunction | null = null;
const Ajv = AjvModule as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

function getPipelineValidator() {
  if (validatePipelineFn) return validatePipelineFn;

  const schemaPath = pathResolver.knowledge('public/schemas/pipeline-adf.schema.json');
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
