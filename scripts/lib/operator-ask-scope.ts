import { parseExecutionFeedbackText } from '@agent/core/execution-feedback';
import { currentScope } from '@agent/core/scope-context';
import { nowIso } from '@agent/core/foundation';
import type { SupportedLocale } from '@agent/core/locale';
import { normalizeEventScope } from '@agent/core/event-scope';
import type { runSurfaceMessageConversation } from '@agent/core/surface/surface-runtime-orchestrator';

/** Scope options must never be silently ignored in favor of ambient selection. */
export function assertAskScopeOptionsSupported(args: string[]): void {
  // yargs supplies a public tier even when no option was given. Inspect
  // actual option tokens only, never text inside a quoted feedback payload.
  const scopeOptions = new Set([
    '--tier',
    '--tenant',
    '--tenant-slug',
    '--tenant-id',
    '--organization',
    '--organization-id',
    '--project',
    '--project-id',
    '--mission',
    '--mission-id',
    '--task',
    '--task-id',
    '--session',
    '--session-id',
    '--scope',
    '--scope-context',
  ]);
  const optionEnd = args.indexOf('--');
  const explicitScopeOption = args
    .slice(0, optionEnd < 0 ? args.length : optionEnd)
    .find((arg) =>
      scopeOptions.has(
        arg.split('=', 1)[0].replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
      )
    );
  if (explicitScopeOption) {
    throw new Error(
      '[SURFACE_CLI_SCOPE_FLAGS_UNSUPPORTED] ask uses the selected scope; select it with pnpm scope use before asking instead of passing scope flags.'
    );
  }
}

/** Bind feedback to the selected scope, never to yargs' default public tier. */
export function buildAskConversationInput(
  text: string,
  locale: SupportedLocale,
  suppliedCorrelationId?: string
): Parameters<typeof runSurfaceMessageConversation>[0] {
  const selected = currentScope();
  const scope =
    selected.tier !== 'public' || Object.keys(selected).some((key) => key !== 'tier')
      ? normalizeEventScope(selected)
      : undefined;
  const executionFeedback = parseExecutionFeedbackText(text) || undefined;
  // Until delegated runtimes preserve this exact scope, selected organization
  // context must never fall through to the legacy unscoped execution path.
  if (scope && !executionFeedback) {
    throw new Error(
      '[SURFACE_CLI_SCOPE_UNSUPPORTED] Scoped ask currently supports execution feedback only; use an explicitly scoped workflow for other work.'
    );
  }
  const correlationId = suppliedCorrelationId?.trim() || `kyberion-ask-${Date.now().toString(36)}`;
  return {
    surface: 'cli',
    text,
    ...(scope ? { scope, missionId: scope.mission_id } : {}),
    ...(executionFeedback ? { executionFeedback } : {}),
    channel: 'kyberion-home',
    threadTs: correlationId,
    correlationId,
    receivedAt: nowIso(),
    locale,
    actorId: 'operator',
    senderAgentId: 'kyberion:home-cli',
    agentId: 'cli-surface-agent',
    delegationSummaryInstruction:
      'Produce a concise terminal-friendly reply in the operator language. No A2A blocks.',
  };
}
