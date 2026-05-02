import { rootResolve } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { validatePipelineAdf } from '@agent/core/pipeline-contract';

export function resolveAdfInputPath(inputPath: string): string {
  return rootResolve(inputPath);
}

export function readJsonInput<T = any>(inputPath: string): T {
  const content = safeReadFile(resolveAdfInputPath(inputPath), { encoding: 'utf8' }) as string;
  return JSON.parse(content) as T;
}

export function readValidatedPipelineAdf<T = any>(inputPath: string): T {
  return validatePipelineAdf(readJsonInput(inputPath)) as T;
}
