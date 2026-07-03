import { pathToFileURL } from 'node:url';
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

function isWorkflowModulePath(inputPath: string): boolean {
  const lower = inputPath.toLowerCase();
  return (
    lower.endsWith('.ts') ||
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  );
}

async function readWorkflowModuleInput<T = any>(inputPath: string): Promise<T> {
  const moduleUrl = pathToFileURL(resolveAdfInputPath(inputPath)).href;
  const loaded = await import(moduleUrl);
  const candidate = loaded.default ?? loaded.workflow ?? loaded.pipeline ?? loaded.adf;
  return (candidate ?? loaded) as T;
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

export async function readValidatedWorkflowAdf<T = any>(inputPath: string): Promise<T> {
  const raw = isWorkflowModulePath(inputPath)
    ? await readWorkflowModuleInput<T>(inputPath)
    : readJsonInput<T>(inputPath);
  const pipeline = validatePipelineAdf(raw);
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
