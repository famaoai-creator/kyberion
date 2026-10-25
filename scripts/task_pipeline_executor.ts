/** Composition boundary: task tools reuse the typed CLI pipeline engine. */
import { registerTaskPipelineExecutor } from '@agent/core/workforce/task-pipeline-tool';
import { createHash } from 'node:crypto';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

let installed = false;
export function installTaskPipelineExecutor(): void {
  if (installed) return;
  registerTaskPipelineExecutor(async (request) => {
    request.assertCurrent();
    const engine = await import('./pipeline-execution-part-results.js');
    request.assertCurrent();
    const scope = request.binding.scope;
    const validateSource = (source: string): void => {
      request.assertCurrent();
      if (createHash('sha256').update(source).digest('hex') !== request.sourceSha256)
        throw new Error('[TASK_PIPELINE_DENIED] Approved pipeline source changed');
    };
    validateSource(
      String(safeReadFile(pathResolver.rootResolve(request.pipelineRef), { encoding: 'utf8' }))
    );
    if (request.resumeRunId)
      return engine.resumeLibraryPipelineRun(
        request.resumeRunId,
        { tier: scope.tier, tenantSlug: scope.tenant_slug },
        request.assertCurrent,
        validateSource
      );
    return engine.executePipelineFile(request.pipelineRef, {
      delegatedExecution: 'require',
      resumeOwner: 'task',
      context: { ...scope },
      payloadScope: {
        tier: scope.tier,
        tenant_slug: scope.tenant_slug,
        purpose: 'claimed task pipeline',
        external_egress: request.binding.externalEgress,
        allowed_reasoning_backends: request.binding.allowedReasoningBackends,
        training_use:
          request.binding.externalEgress === 'deny'
            ? 'local_only'
            : scope.tier === 'public'
              ? 'training_eligible'
              : request.binding.externalEgress === 'allow'
                ? 'no_training'
                : 'local_only',
      },
      validateLoadedPipeline: (_pipeline, source) => validateSource(source),
      assertExecutionCurrent: request.assertCurrent,
      hasHuman: false,
      quiet: true,
    });
  });
  installed = true;
}
installTaskPipelineExecutor();
