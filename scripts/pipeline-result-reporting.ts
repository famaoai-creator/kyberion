import {
  buildNextActionFromError,
  classifyError,
  formatClassification,
  formatNextAction,
  logger,
} from '@agent/core';

/** The normalized failure summary shared by CLI and library pipeline callers. */
export type PipelineFailure = {
  classification: ReturnType<typeof classifyError>;
  summary: string;
};

/** Convert an arbitrary execution error into the stable pipeline failure shape. */
export function formatPipelineFailure(err: unknown): PipelineFailure {
  const classification = classifyError(err);
  return {
    classification,
    summary: formatClassification(classification).replace(/\n+/g, ' | '),
  };
}

/** Emit the governed recovery action for a failed pipeline step. */
export function logNextActionForPipelineFailure(
  failure: PipelineFailure,
  pipelinePath: string
): void {
  const nextAction = buildNextActionFromError(failure.classification, {
    source: 'pipeline',
    pipelinePath,
  });
  for (const line of formatNextAction(nextAction)) {
    logger.error(line);
  }
}
