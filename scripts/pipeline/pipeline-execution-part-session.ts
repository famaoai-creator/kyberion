/**
 * The authored browser session and options of one pipeline run, at the
 * runner boundary (pipeline-run-manifest-model.md §8): the out-of-band run
 * session actuators read, the pinned context keys, and the once-per-run
 * warning for declared browser options the run will not apply.
 */
import { logger } from '@agent/core/core';
import {
  classifyPipelineBrowserOptions,
  describeDroppedBrowserOption,
  pipelineUsesBrowser,
  type RunScope,
} from '@agent/core/pipeline/run-manifest';

/**
 * Once per run: the browser options the pipeline declares but the run will
 * not apply (launch overrides, a profile or recording outside the run's
 * partition). They are dropped, as before runner dispatch forwarded options.
 */
export function warnDroppedBrowserOptions(
  pipeline: { options?: unknown; steps?: unknown },
  runScope: RunScope | undefined
): void {
  if (!pipelineUsesBrowser(pipeline.steps)) return;
  for (const entry of classifyPipelineBrowserOptions(pipeline.options, runScope).dropped)
    logger.warn(`[PIPELINE] ${describeDroppedBrowserOption(entry)}`);
}

/**
 * The session and engine options a run hands its actuators (browser
 * `headless`, `user_data_dir`, `navigation_policy`, ...) are the pipeline
 * file's own — the content project trust binds — never a caller's context: a
 * `--context` or library caller supplying `__pipeline_options` could otherwise
 * loosen the navigation fence (e.g. `allow_private_network`) at run time.
 */
export function pinPipelineSessionContext(
  context: Record<string, unknown>,
  pipeline: { options?: unknown; session_id?: unknown }
): void {
  context.__pipeline_options = pipeline.options || {};
  if (typeof pipeline.session_id === 'string' && pipeline.session_id)
    context.__pipeline_session_id = pipeline.session_id;
  else delete context.__pipeline_session_id;
}

/**
 * The out-of-band run session for actuator dispatch: the file's own session
 * and options, plus the location-derived run scope (never the ambient tenant)
 * that confines what the options may write to disk.
 */
export function pipelineRunSessionOf(
  pipeline: { session_id?: unknown; options?: unknown },
  runScope: RunScope | undefined
) {
  return {
    session_id: pipeline.session_id,
    options: pipeline.options,
    ...(runScope
      ? {
          scope: {
            tier: runScope.tier,
            ...(runScope.tenant_slug ? { tenant_slug: runScope.tenant_slug } : {}),
          },
        }
      : {}),
  };
}
