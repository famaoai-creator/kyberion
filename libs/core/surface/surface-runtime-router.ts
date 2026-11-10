import { classifyTaskSessionIntent } from '../task/task-session.js';
import { detectTextLocale } from '../foundation/locale-normalize.js';
import type { IntentResolutionPacket } from '../intent/intent-resolution.js';
import { decideSurfaceCompilation, resolveRoutingPacket } from '../intent/intent-resolver-entry.js';
import {
  deriveSurfaceDelegationReceiverForProvider,
  getSurfaceProviderManifestRecord,
  resolveSurfaceConversationReceiverForProvider,
  shouldForceSurfaceDelegationFromProviderPolicy,
} from './surface-provider-policy.js';
import { listSurfaceProviderManifests } from './surface-provider-manifest.js';
import { resolveChannelMessageShape } from './channel-adapter-registry.js';
import type { SurfaceDelegationReceiver } from './surface-provider-policy.js';
import type { SurfaceIntentResolution } from '../intent/router-contract.js';
export type { SurfaceDelegationReceiver } from './surface-provider-policy.js';

import type {
  SurfaceConversationInput,
  SlackExecutionMode,
  ParsedSlackSurfacePrompt,
  SlackSurfaceMetadata,
  SurfaceAsyncChannel,
} from './channel-surface-types.js';
import type { UserIntentFlow } from '../intent/intent-contract.js';

export interface SurfaceRuntimeRouteContext {
  input: SurfaceConversationInput;
  compiledFlow: UserIntentFlow | null;
  resolutionPacket?: IntentResolutionPacket;
  resolvedIntent?: SurfaceIntentResolution;
  computedReceiver?: SurfaceDelegationReceiver;
  structuredQuery: string;
  parsedSlackPrompt: ParsedSlackSurfacePrompt | null;
}

export function buildDelegationFallbackText(query: string): string {
  const marker = 'User message:\n';
  const idx = query.lastIndexOf(marker);
  if (idx >= 0) {
    const extracted = query.slice(idx + marker.length).trim();
    if (extracted) return extracted;
  }
  return query.trim();
}

export function parseSlackSurfacePrompt(query: string): ParsedSlackSurfacePrompt | null {
  if (
    !query.includes('Surface: slack') &&
    !query.includes('You are handling a Slack conversation as the Slack Surface Agent.')
  ) {
    return null;
  }

  const readLine = (label: string): string | undefined => {
    const match = query.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim();
  };

  const userMessage = buildDelegationFallbackText(query);
  return {
    channel: readLine('Channel'),
    thread: readLine('Thread'),
    user: readLine('User'),
    derivedLanguage: detectTextLocale(userMessage) ?? 'en',
    executionMode: readLine('Execution mode') as SlackExecutionMode | undefined,
    userMessage,
  };
}
export function surfaceChannelFromAgentId(agentId: string): SurfaceAsyncChannel {
  const normalized = agentId.trim();
  if (!normalized) return 'slack';
  const manifests = listSurfaceProviderManifests();
  const exact = manifests.find((entry) => entry.agentId === normalized);
  if (exact) return exact.id;
  const inferred = manifests.find(
    (entry) => normalized.includes(entry.id) || normalized.includes(entry.agentId)
  );
  return inferred?.id || 'slack';
}

export function deriveSurfaceDelegationReceiver(
  text: string,
  surface: SurfaceAsyncChannel = 'slack'
): SurfaceDelegationReceiver | undefined {
  return deriveSurfaceDelegationReceiverForProvider(surface, text);
}

export function deriveSlackDelegationReceiver(text: string): SurfaceDelegationReceiver | undefined {
  return deriveSurfaceDelegationReceiver(text, 'slack');
}

export function normalizeSurfaceDelegationReceiver(
  value?: string
): SurfaceDelegationReceiver | undefined {
  return value === 'chronos-mirror' || value === 'nerve-agent' ? value : undefined;
}

export function resolveSurfaceConversationReceiver(
  forcedReceiver: string | undefined,
  compiledFlow: UserIntentFlow | null | undefined,
  surface: SurfaceAsyncChannel = 'slack'
): SurfaceDelegationReceiver | undefined {
  if (forcedReceiver) return forcedReceiver as SurfaceDelegationReceiver;
  return resolveSurfaceConversationReceiverForProvider(surface, compiledFlow) || 'chronos-mirror';
}

export function surfaceRoutingText(input: SurfaceConversationInput): {
  text: string;
  parsedSlackPrompt: ParsedSlackSurfacePrompt | null;
} {
  // Structured thread metadata applies to surfaces whose channel adapter declares
  // the slack-thread message shape, addressed by that surface's own agent (RS-06).
  const surface = input.surface;
  const slackThreadShape =
    Boolean(surface) && resolveChannelMessageShape(surface!) === 'slack-thread';
  const slackMetadata = slackThreadShape
    ? (input.surfaceMetadata as SlackSurfaceMetadata | undefined)
    : undefined;
  const hasStructuredSlackMetadata =
    slackThreadShape &&
    input.agentId === getSurfaceProviderManifestRecord(surface!).agentId &&
    (typeof input.surfaceText === 'string' ||
      typeof slackMetadata?.channel === 'string' ||
      typeof slackMetadata?.threadTs === 'string' ||
      typeof slackMetadata?.user === 'string');
  const parsedSlackPrompt = hasStructuredSlackMetadata
    ? {
        channel: typeof slackMetadata?.channel === 'string' ? slackMetadata.channel : undefined,
        thread: typeof slackMetadata?.threadTs === 'string' ? slackMetadata.threadTs : undefined,
        user: typeof slackMetadata?.user === 'string' ? slackMetadata.user : undefined,
        derivedLanguage: detectTextLocale(input.surfaceText || input.query) ?? 'en',
        executionMode:
          slackMetadata?.execution_mode === 'conversation' ||
          slackMetadata?.execution_mode === 'task'
            ? (slackMetadata.execution_mode as SlackExecutionMode)
            : undefined,
        userMessage: input.surfaceText || buildDelegationFallbackText(input.query),
      }
    : null;
  return {
    text: input.surfaceText || parsedSlackPrompt?.userMessage || input.query,
    parsedSlackPrompt,
  };
}

/**
 * Thin adapter (R3): report this turn's surface facts and let the resolver
 * entry decide whether it must pass through the shared intent compiler.
 */
export function shouldCompileSurfaceIntent(
  input: SurfaceConversationInput,
  routingText: string,
  ruleBasedReceiver?: SurfaceDelegationReceiver,
  resolvedPacket?: IntentResolutionPacket
): boolean {
  const originalText = (input.surfaceText || input.query || '').trim();
  const normalized = routingText.trim();
  const scope = { tier: input.scope?.tier, tenantId: input.scope?.tenant_slug };
  return decideSurfaceCompilation(
    {
      agent_id: input.agentId,
      utterance_length: originalText.length,
      routing_text_length: normalized.length,
      multiline: originalText.includes('\n'),
      provider_forces_delegation:
        input.agentId === 'slack-surface-agent' && normalized
          ? shouldForceSurfaceDelegationFromProviderPolicy('slack', normalized)
          : false,
      mission_team_handoff: Boolean(input.missionId && input.teamRole),
      has_rule_based_receiver: Boolean(ruleBasedReceiver),
    },
    () => resolvedPacket || resolveRoutingPacket(originalText, scope),
    (packet) => Boolean(classifyTaskSessionIntent(originalText, packet, scope))
  );
}
