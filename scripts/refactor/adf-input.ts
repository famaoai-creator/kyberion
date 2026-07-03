import { rootResolve } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { validatePipelineAdf } from '@agent/core/pipeline-contract';
import { validatePipelineGuardrails } from '@agent/core/adf-guardrails';

export function resolveAdfInputPath(inputPath: string): string {
  return rootResolve(inputPath);
}

export function readJsonInput<T = any>(inputPath: string): T {
  const content = safeReadFile(resolveAdfInputPath(inputPath), { encoding: 'utf8' }) as string;
  return JSON.parse(content) as T;
}

export function readValidatedPipelineAdf<T = any>(inputPath: string): T {
  const pipeline = validatePipelineAdf(readJsonInput(inputPath));
  const guardrails = validatePipelineGuardrails(pipeline, inputPath);
  if (!guardrails.ok) {
    const details = guardrails.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.path} ${finding.message}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF guardrails: ${details}`);
  }
  return pipeline as T;
}
