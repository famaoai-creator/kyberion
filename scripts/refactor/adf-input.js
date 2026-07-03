import { pathToFileURL } from 'node:url';
import { rootResolve } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { validatePipelineAdf } from '@agent/core/pipeline-contract';
import { validatePipelineGuardrails } from '@agent/core/adf-guardrails';
function resolveAdfInputPath(inputPath) {
  return rootResolve(inputPath);
}
function readJsonInput(inputPath) {
  const content = safeReadFile(resolveAdfInputPath(inputPath), { encoding: 'utf8' });
  return JSON.parse(content);
}
function isWorkflowModulePath(inputPath) {
  const lower = inputPath.toLowerCase();
  return (
    lower.endsWith('.ts') ||
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  );
}
async function readWorkflowModuleInput(inputPath) {
  const moduleUrl = pathToFileURL(resolveAdfInputPath(inputPath)).href;
  const loaded = await import(moduleUrl);
  const candidate = loaded.default ?? loaded.workflow ?? loaded.pipeline ?? loaded.adf;
  return candidate ?? loaded;
}
function readValidatedPipelineAdf(inputPath) {
  const pipeline = validatePipelineAdf(readJsonInput(inputPath));
  const guardrails = validatePipelineGuardrails(pipeline, inputPath);
  if (!guardrails.ok) {
    const details = guardrails.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.path} ${finding.message}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF guardrails: ${details}`);
  }
  return pipeline;
}
async function readValidatedWorkflowAdf(inputPath) {
  const raw = isWorkflowModulePath(inputPath)
    ? await readWorkflowModuleInput(inputPath)
    : readJsonInput(inputPath);
  const pipeline = validatePipelineAdf(raw);
  const guardrails = validatePipelineGuardrails(pipeline, inputPath);
  if (!guardrails.ok) {
    const details = guardrails.findings
      .filter((finding) => finding.severity === 'error')
      .map((finding) => `${finding.path} ${finding.message}`)
      .join('; ');
    throw new Error(`Invalid pipeline ADF guardrails: ${details}`);
  }
  return pipeline;
}
export { readJsonInput, readValidatedPipelineAdf, readValidatedWorkflowAdf, resolveAdfInputPath };
