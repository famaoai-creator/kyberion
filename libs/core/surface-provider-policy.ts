import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';

import type { SurfaceAsyncChannel } from './channel-surface-types.js';
import type { UserIntentFlow } from './intent-contract.js';
import type { TierLevel } from './types.js';

const SURFACE_PROVIDER_MANIFESTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-provider-manifests.schema.json'
);
const SURFACE_PROVIDER_MANIFESTS_PATH = pathResolver.knowledge(
  'product/governance/surface-provider-manifests.json'
);

export type SurfaceDelegationReceiver = 'chronos-mirror' | 'nerve-agent';

export interface SurfaceProviderRoutingRule {
  id?: string;
  receiver: SurfaceDelegationReceiver;
  patterns?: Array<TextMatchRule | string>;
}

export interface SurfaceProviderCompiledFlowRule {
  id?: string;
  receiver: SurfaceDelegationReceiver;
  execution_shapes?: string[];
  conversation_agents?: string[];
  task_types?: string[];
}

export interface SurfaceProviderRoutingPolicy {
  text_routing: {
    greeting_patterns?: Array<TextMatchRule | string>;
    receiver_rules?: SurfaceProviderRoutingRule[];
  };
  compiled_flow_rules?: SurfaceProviderCompiledFlowRule[];
}

export interface SurfaceProviderManifestRecord {
  id: SurfaceAsyncChannel;
  displayName: string;
  agentId: string;
  channel: string;
  interactionMode: 'threaded' | 'session' | 'live';
  capabilities: Record<string, boolean>;
  delivery: {
    directReply: 'outbox' | 'notification' | 'none';
    supportsOutbox: boolean;
    supportsNotifications: boolean;
  };
  scope_policy?: {
    process_scope: 'system' | 'tenant-service';
    scope_mode: 'system' | 'server-bound-tenant' | 'viewer-derived' | 'request-derived';
    allowed_tiers: TierLevel[];
    requires_channel_binding_for_customer_mode: boolean;
    principal_resolution: string;
    write_authority: string;
    nhi_binding: string;
    approval_classes: string[];
    data_residency: string;
  };
  intent_rules?: {
    rules?: Array<{
      id?: string;
      label: string;
      patterns: Array<TextMatchRule | string>;
    }>;
    default_label: string;
  };
  surface_rules?: {
    execution_mode?: {
      feasibility_patterns: Array<TextMatchRule | string>;
      durable_task_patterns: Array<TextMatchRule | string>;
    };
    delegation?: {
      lightweight_patterns: Array<TextMatchRule | string>;
    };
  };
  routing?: SurfaceProviderRoutingPolicy;
}

interface SurfaceProviderManifestFile {
  version: string;
  providers: Record<SurfaceAsyncChannel, SurfaceProviderManifestRecord>;
}

const surfaceProviderCatalog = defineCatalog<SurfaceProviderManifestFile>({
  id: 'surface-provider-manifests',
  path: SURFACE_PROVIDER_MANIFESTS_PATH,
  schema: SURFACE_PROVIDER_MANIFESTS_SCHEMA_PATH,
});

export function loadSurfaceProviderManifestFile(): SurfaceProviderManifestFile {
  return surfaceProviderCatalog.load();
}

export function listSurfaceProviderManifestRecords(): SurfaceProviderManifestRecord[] {
  return Object.values(loadSurfaceProviderManifestFile().providers);
}

export function getSurfaceProviderManifestRecord(
  surface: SurfaceAsyncChannel
): SurfaceProviderManifestRecord {
  return loadSurfaceProviderManifestFile().providers[surface];
}

export function deriveSurfaceIntentLabelFromProviderPolicy(
  surface: SurfaceAsyncChannel,
  text: string
): string {
  const normalized = text.trim();
  const manifest = getSurfaceProviderManifestRecord(surface);
  if (!normalized) return manifest.intent_rules?.default_label || 'general_request';
  const matchedRule = (manifest.intent_rules?.rules || []).find((rule) =>
    matchesAnyTextRule(normalized, rule.patterns)
  );
  return matchedRule?.label || manifest.intent_rules?.default_label || 'request_deeper_reasoning';
}

export function deriveSlackIntentLabelFromProviderPolicy(text: string): string {
  return deriveSurfaceIntentLabelFromProviderPolicy('slack', text);
}

export function deriveSurfaceExecutionModeFromProviderPolicy(
  surface: SurfaceAsyncChannel,
  text: string
): 'conversation' | 'task' {
  const normalized = text.trim();
  if (!normalized) return 'conversation';
  const rules = getSurfaceProviderManifestRecord(surface).surface_rules;
  if (matchesAnyTextRule(normalized, rules?.execution_mode?.feasibility_patterns)) {
    return 'conversation';
  }
  const softRequestConversation =
    /(作って|作成して).*(ください|下さい|ほしい|欲しい|くれない|もらえます|もらえる|お願い)/u.test(
      normalized
    ) && !/(保存|実装|ファイル|ミッション|mission)/iu.test(normalized);
  if (softRequestConversation) return 'conversation';
  return matchesAnyTextRule(normalized, rules?.execution_mode?.durable_task_patterns)
    ? 'task'
    : 'conversation';
}

export function deriveSlackExecutionModeFromProviderPolicy(text: string): 'conversation' | 'task' {
  return deriveSurfaceExecutionModeFromProviderPolicy('slack', text);
}

export function shouldForceSurfaceDelegationFromProviderPolicy(
  surface: SurfaceAsyncChannel,
  text: string
): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const rules = getSurfaceProviderManifestRecord(surface).surface_rules;
  return !matchesAnyTextRule(normalized, rules?.delegation?.lightweight_patterns);
}

export function shouldForceSlackDelegationFromProviderPolicy(text: string): boolean {
  return shouldForceSurfaceDelegationFromProviderPolicy('slack', text);
}

export function deriveSurfaceDelegationReceiverForProvider(
  surface: SurfaceAsyncChannel,
  text: string
): SurfaceDelegationReceiver | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const routing = getSurfaceProviderManifestRecord(surface).routing;
  if (!routing) return undefined;
  if (matchesAnyTextRule(normalized, routing.text_routing?.greeting_patterns)) {
    return undefined;
  }
  const matchedRule = (routing.text_routing?.receiver_rules || []).find((rule) =>
    matchesAnyTextRule(normalized, rule.patterns)
  );
  return matchedRule?.receiver;
}

export function resolveSurfaceConversationReceiverForProvider(
  surface: SurfaceAsyncChannel,
  compiledFlow?: UserIntentFlow | null
): SurfaceDelegationReceiver | undefined {
  if (!compiledFlow) return undefined;
  if (compiledFlow.routingDecision?.mode === 'prompt') return undefined;
  const routing = getSurfaceProviderManifestRecord(surface).routing;
  if (!routing) return undefined;
  return (routing.compiled_flow_rules || []).find((rule) => {
    const executionShape = compiledFlow.intentContract.resolution.execution_shape;
    const conversationAgent = compiledFlow.workLoop.teaming.conversation_agent;
    const taskType = compiledFlow.workLoop.resolution.task_type;
    return Boolean(
      (rule.execution_shapes || []).includes(executionShape) ||
      (conversationAgent && (rule.conversation_agents || []).includes(conversationAgent)) ||
      (taskType && (rule.task_types || []).includes(taskType))
    );
  })?.receiver;
}
