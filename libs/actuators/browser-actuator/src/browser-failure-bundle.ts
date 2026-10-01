import { nowIso } from '@agent/core/foundation';
import { judgeBrowserFailureKind } from '@agent/core/browser/browser-judgment';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import type { BrowserRuntime } from './browser-runtime-types.js';

/**
 * The browser failure bundle (`browser-failure-bundle.v1`) written when a
 * pipeline fails, and refreshed once tracing stops.
 */
export function saveBrowserFailureBundle(
  sessionId: string,
  ctx: any,
  runtime: Pick<BrowserRuntime, 'consoleEvents' | 'networkEvents'>,
  tracePath: string | null
): string {
  return browserRuntimeHelpers.saveFailureBundle(sessionId, {
    schema_version: 'browser-failure-bundle.v1',
    session_id: sessionId,
    created_at: nowIso(),
    error: ctx.error,
    ...(ctx.failure_kind ? { failure_kind: ctx.failure_kind } : {}),
    url: ctx.last_url || null,
    title: ctx.last_snapshot?.title || null,
    snapshot: ctx.last_snapshot || null,
    screenshot: ctx.last_screenshot || null,
    trace_path: tracePath,
    console_events: runtime.consoleEvents.slice(-50),
    network_events: runtime.networkEvents.slice(-50),
    action_trail: browserRuntimeHelpers.readRecordedActions(ctx).slice(-200),
  });
}

/**
 * `{ failure_kind }` only when a calibrated judgment named a failure the
 * heuristics could not; empty (and no provider call) until a fit lands.
 */
export async function judgedFailureKindFields(
  message: string,
  title: unknown
): Promise<{ failure_kind?: string }> {
  const kind = await judgeBrowserFailureKind(
    [message, typeof title === 'string' ? title : ''].filter(Boolean).join('\n')
  ).catch(() => undefined);
  return kind ? { failure_kind: kind } : {};
}
