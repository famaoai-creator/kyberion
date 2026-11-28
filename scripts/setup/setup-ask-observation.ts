import {
  recordConversationSignal,
  type ConversationSignalKind,
} from '@agent/core/intent/conversation-signals';
import type { SurfaceConversationResult } from '@agent/core/surface/channel-surface-types';
import { currentScope } from '@agent/core/scope-context';

type GuidanceSignal = Extract<ConversationSignalKind, 'guidance_offered' | 'guidance_followup'>;

export function isDefaultPublicAskScope(): boolean {
  const scope = currentScope();
  return scope.tier === 'public' && Object.keys(scope).every((key) => key === 'tier');
}

export function observeSetupAsk(
  kind: GuidanceSignal,
  correlationId: string | undefined,
  detail: Record<string, string>
): void {
  if (!correlationId || !/^guidance:[a-f0-9-]{36}$/u.test(correlationId)) return;
  if (!isDefaultPublicAskScope()) return;
  recordConversationSignal({ kind, correlationId, surface: 'cli', detail });
}

export function classifyGuidanceFollowUp(result: SurfaceConversationResult) {
  if (result.delegationResults?.some(({ error }) => error)) return 'error';
  const nextAction = result.intentResolution?.next_action.kind;
  if (result.approvalRequests?.length || nextAction === 'request_approval')
    return 'approval_pending';
  if (nextAction === 'provide_input') return 'input_pending';
  return result.text?.trim() ? 'response_returned' : 'empty_response';
}
