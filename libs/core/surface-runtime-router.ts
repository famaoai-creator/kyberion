import { classifyTaskSessionIntent } from './task-session.js';
import {
  deriveSurfaceDelegationReceiverForProvider,
  resolveSurfaceConversationReceiverForProvider,
  shouldForceSlackDelegationFromProviderPolicy,
} from './surface-provider-policy.js';
import { listSurfaceProviderManifests } from './surface-provider-manifest.js';
import type { SurfaceDelegationReceiver } from './surface-provider-policy.js';
import type { SurfaceIntentResolution } from './router-contract.js';
export type { SurfaceDelegationReceiver } from './surface-provider-policy.js';

import type { SurfaceConversationInput, SlackExecutionMode, ParsedSlackSurfacePrompt, SlackSurfaceMetadata } from './channel-surface-types.js';
import type { UserIntentFlow } from './intent-contract.js';

export interface SurfaceRuntimeRouteContext {
  input: SurfaceConversationInput;
  compiledFlow: UserIntentFlow | null;
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
  if (!query.includes('Surface: slack') && !query.includes('You are handling a Slack conversation as the Slack Surface Agent.')) {
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
    derivedLanguage: /[ぁ-んァ-ン一-龯]/.test(userMessage) ? 'ja' : 'en',
    executionMode: readLine('Execution mode') as SlackExecutionMode | undefined,
    userMessage,
  };
}
export function surfaceChannelFromAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!normalized) return 'slack';
  const manifests = listSurfaceProviderManifests();
  const exact = manifests.find((entry) => entry.agentId === normalized);
  if (exact) return exact.id;
  const inferred = manifests.find((entry) => normalized.includes(entry.id) || normalized.includes(entry.agentId));
  return inferred?.id || 'slack';
}

export function deriveSurfaceDelegationReceiver(
  text: string,
  surface: string = 'slack',
): SurfaceDelegationReceiver | undefined {
  return deriveSurfaceDelegationReceiverForProvider(surface, text);
}

export function deriveSlackDelegationReceiver(text: string): SurfaceDelegationReceiver | undefined {
  return deriveSurfaceDelegationReceiver(text, 'slack');
}

export function normalizeSurfaceDelegationReceiver(value?: string): SurfaceDelegationReceiver | undefined {
  return value === 'chronos-mirror' || value === 'nerve-agent' ? value : undefined;
}

export function resolveSurfaceConversationReceiver(
  forcedReceiver: string | undefined,
  compiledFlow: UserIntentFlow | null | undefined,
  surface: string = 'slack',
): SurfaceDelegationReceiver | undefined {
  if (forcedReceiver) return forcedReceiver as SurfaceDelegationReceiver;
  return resolveSurfaceConversationReceiverForProvider(surface, compiledFlow) || 'chronos-mirror';
}

export function surfaceRoutingText(input: SurfaceConversationInput): { text: string; parsedSlackPrompt: ParsedSlackSurfacePrompt | null } {
  const slackMetadata = input.surface === 'slack' ? input.surfaceMetadata as SlackSurfaceMetadata | undefined : undefined;
  const hasStructuredSlackMetadata =
    input.agentId === 'slack-surface-agent' &&
    input.surface === 'slack' &&
    (typeof input.surfaceText === 'string' ||
      typeof slackMetadata?.channel === 'string' ||
      typeof slackMetadata?.threadTs === 'string' ||
      typeof slackMetadata?.user === 'string');
  const parsedSlackPrompt = hasStructuredSlackMetadata
    ? ({
      channel: typeof slackMetadata?.channel === 'string' ? slackMetadata.channel : undefined,
      thread: typeof slackMetadata?.threadTs === 'string' ? slackMetadata.threadTs : undefined,
      user: typeof slackMetadata?.user === 'string' ? slackMetadata.user : undefined,
      derivedLanguage: /[ぁ-んァ-ン一-龯]/.test(input.surfaceText || input.query) ? 'ja' : 'en',
      executionMode:
        slackMetadata?.execution_mode === 'conversation' || slackMetadata?.execution_mode === 'task'
          ? (slackMetadata.execution_mode as SlackExecutionMode)
          : undefined,
      userMessage: input.surfaceText || buildDelegationFallbackText(input.query),
    })
    : null;
  return {
    text: input.surfaceText || parsedSlackPrompt?.userMessage || input.query,
    parsedSlackPrompt,
  };
}

export function shouldCompileSurfaceIntent(
  input: SurfaceConversationInput,
  routingText: string,
  ruleBasedReceiver?: SurfaceDelegationReceiver,
): boolean {
  if (input.forcedReceiver || ruleBasedReceiver) return false;
  const normalized = routingText.trim();
  if (!normalized) return false;
  if (input.agentId === 'slack-surface-agent' && !shouldForceSlackDelegationFromProviderPolicy(normalized)) {
    return false;
  }
  if (classifyTaskSessionIntent(normalized)) return true;
  return normalized.length > 80 || normalized.includes('\n');
}
