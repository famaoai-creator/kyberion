import type { ValidateFunction } from 'ajv';
import path from 'node:path';
import { compileSchema } from './foundation/ajv.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import { requiresProjectTrust } from './trust-requiring-resources.js';
import type { DesktopRecordingStep } from './desktop-recording.js';

let validator: ValidateFunction | null = null;
const DESKTOP_PIPELINE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/desktop-pipeline.schema.json'
);

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
    validator = compileSchema(DESKTOP_PIPELINE_SCHEMA_PATH);
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

/** Reject symlink traversal even after the caller has resolved project trust. */
export function assertDesktopPipelineResourcePath(
  filePath: string,
  rootDir = pathResolver.rootResolve('pipelines/desktop')
): void {
  const root = path.resolve(rootDir);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(
      `[DESKTOP_PIPELINE_SCOPE] pipeline path is outside the allowlisted root: ${filePath}`
    );
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (!safeExistsSync(current)) break;
    if (safeLstat(current).isSymbolicLink()) {
      throw new Error(
        `[DESKTOP_PIPELINE_SCOPE] pipeline path cannot traverse a symbolic link: ${relative}`
      );
    }
  }
}

function desktopPipelineCatalogAtPath(filePath: string) {
  return defineCatalog<DesktopPipeline>({
    id: 'desktop-pipeline',
    path: filePath,
    schema: DESKTOP_PIPELINE_SCHEMA_PATH,
  });
}

/** Load one persisted desktop pipeline through the canonical schema boundary. */
export function loadDesktopPipelineAtPath(filePath: string): DesktopPipeline {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[DESKTOP_PIPELINE] pipeline must be a regular file: ${filePath}`);
  }
  return desktopPipelineCatalogAtPath(safeFilePath).load();
}

export function loadDesktopPipeline(
  ref: string | undefined,
  options: { trustResolved?: boolean } = {}
): DesktopPipelineValidationResult {
  const absolute = resolveDesktopPipelineRef(ref);
  if (!absolute) return { valid: false, errors: ['desktop pipeline_ref is not allowlisted'] };
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (options.trustResolved !== true && requiresProjectTrust(relative)) {
    return {
      valid: false,
      errors: [
        '[TRUST_REQUIRED] project-local desktop pipeline cannot be loaded before trust resolution',
      ],
    };
  }
  try {
    assertDesktopPipelineResourcePath(absolute);
    return { valid: true, errors: [], value: loadDesktopPipelineAtPath(absolute) };
  } catch (error) {
    return {
      valid: false,
      errors: [
        `desktop pipeline could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
