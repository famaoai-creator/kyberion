import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import path from 'node:path';
import { compileSchemaFromPath } from './schema-loader.js';
import { createAjv } from './foundation/ajv.js';
import { pathResolver } from './path-resolver.js';
import { loadJson, safeReadFile } from './secure-io.js';
import { requiresProjectTrust } from './trust-requiring-resources.js';
import type { DesktopRecordingStep } from './desktop-recording.js';

const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
let validator: ValidateFunction | null = null;

export interface DesktopPipelineStep {
  step_id: string;
  op: string;
  /** Selected governed native route. When present, GUI replay is prohibited. */
  native_op?: string;
  risk_class: DesktopRecordingStep['risk_class'];
  selector?: Record<string, unknown>;
  params?: Record<string, unknown>;
  variable?: DesktopRecordingStep['variable'];
}

export interface DesktopPipeline {
  schema_version: 'desktop-pipeline.v1';
  procedure_id: string;
  executor: 'system';
  recording_ref: string;
  recording_hash: string;
  steps: DesktopPipelineStep[];
}

export interface DesktopPipelineValidationResult {
  valid: boolean;
  errors: string[];
  value?: DesktopPipeline;
}

function getValidator(): ValidateFunction {
  if (!validator) {
    const ajv = createAjv();
    addFormats(ajv);
    validator = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/desktop-pipeline.schema.json')
    );
  }
  return validator;
}

export function validateDesktopPipeline(input: unknown): DesktopPipelineValidationResult {
  const validate = getValidator();
  if (!validate(input)) {
    return {
      valid: false,
      errors: (validate.errors || []).map(
        (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
      ),
    };
  }
  return { valid: true, errors: [], value: input as DesktopPipeline };
}

export function resolveDesktopPipelineRef(ref: string | undefined): string | null {
  if (!ref || typeof ref !== 'string') return null;
  const relative = ref.replaceAll('\\', '/');
  if (!/^pipelines\/desktop\/[^/]+\.json$/u.test(relative)) return null;
  const absolute = path.resolve(pathResolver.rootResolve(relative));
  const root = path.resolve(pathResolver.rootResolve('pipelines/desktop'));
  return absolute.startsWith(`${root}${path.sep}`) ? absolute : null;
}

export function loadDesktopPipeline(
  ref: string | undefined,
  options: { trustResolved?: boolean } = {}
): DesktopPipelineValidationResult {
  const absolute = resolveDesktopPipelineRef(ref);
  if (!absolute) return { valid: false, errors: ['desktop pipeline_ref is not allowlisted'] };
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (options.trustResolved === false && requiresProjectTrust(relative)) {
    return {
      valid: false,
      errors: [
        '[TRUST_REQUIRED] project-local desktop pipeline cannot be loaded before trust resolution',
      ],
    };
  }
  try {
    const raw = loadJson<unknown>(absolute);
    return validateDesktopPipeline(raw);
  } catch (error) {
    return {
      valid: false,
      errors: [
        `desktop pipeline could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
