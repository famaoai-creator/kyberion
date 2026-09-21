import { auditChain } from './audit-chain.js';
import {
  PIN_FILE_VERSION,
  pinActorId as actorId,
  readPinFile,
  writePinFile,
  type PinnedEntry,
} from './provider-pins-store.js';
import { discoverProviders, type ProviderInfo } from './provider-discovery.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import type { CapabilityResolveOptions } from './agent-provider-resolution.js';
import {
  isInstanceDemoted,
  resolveCapabilityTargetWithHealth,
  selectHealthyInstance,
  type HealthAwareResolution,
} from './provider-health-registry.js';

/**
 * Capability Broker v1.0
 *
 * Single decision point for "which provider/model/instance runs this task". It composes:
 *   - requirement-first, health-aware resolution (resolveCapabilityTargetWithHealth)
 *   - per-mission *pinning* so a resolved decision can be frozen for reproducibility
 *   - an audit-chain record of every decision (what was chosen and why)
 *
 * Why pin?  Transparent runtime selection is great for interactive use, but Kyberion sells
 * reproducible, audited missions. A mission replayed at work (gemini/claude) vs. home
 * (gemini/codex) would otherwise pick different models. Pinning lets a mission freeze the
 * decision once; everything else stays fully automatic.
 */

export interface ProviderDecision extends HealthAwareResolution {
  pinned: boolean;
  decisionKey?: string;
}

export interface ResolveProviderDecisionOptions extends CapabilityResolveOptions {
  /** Stable logical slot (e.g. a team role or task type). Required to pin/reuse a decision. */
  decisionKey?: string;
  /** Record the decision to the audit chain. Default true. */
  record?: boolean;
  /** Injected clock for deterministic tests. */
  now?: number;
}

export type { PinnedEntry, SeamPinnedEntry } from './provider-pins-store.js';
export {
  loadSeamProviderPin,
  pinSeamProviderDecision,
  unpinSeamProviderDecision,
} from './provider-pins-store.js';

export function loadPinnedDecision(decisionKey: string): PinnedEntry | null {
  return readPinFile().pins[decisionKey] ?? null;
}

export function pinProviderDecision(decisionKey: string, decision: ProviderDecision): PinnedEntry {
  const file = readPinFile();
  const entry: PinnedEntry = {
    provider: decision.provider,
    modelId: decision.modelId,
    instance: decision.instance,
    orchestration: decision.orchestration,
    pinnedAt: nowIso(),
    by: actorId(),
  };
  file.version = PIN_FILE_VERSION;
  file.missionId = getRegisteredEnvText('MISSION_ID');
  file.pins[decisionKey] = entry;
  writePinFile(file);
  return entry;
}

export function unpinProviderDecision(decisionKey: string): void {
  const file = readPinFile();
  if (file.pins[decisionKey]) {
    delete file.pins[decisionKey];
    writePinFile(file);
  }
}

function recordDecision(decision: ProviderDecision): void {
  auditChain.record({
    agentId: actorId(),
    action: 'provider_selection',
    operation: `${decision.provider}/${decision.modelId}${decision.instance ? `#${decision.instance}` : ''}`,
    result: decision.strategy === 'unresolved' ? 'error' : 'completed',
    reason: decision.rationale,
    metadata: {
      provider: decision.provider,
      modelId: decision.modelId,
      instance: decision.instance,
      strategy: decision.strategy,
      orchestration: decision.orchestration,
      pinned: decision.pinned,
      decisionKey: decision.decisionKey,
      requiredCapabilities: decision.requiredCapabilities,
      unmetCapabilities: decision.unmetCapabilities,
      availableProviders: decision.availableProviders,
    },
  });
}

/**
 * Resolve the provider/model/instance for a task. Honors a pin when one exists and is still
 * installable; otherwise resolves fresh. Records the decision to the audit chain by default.
 */
export function resolveProviderDecision(
  options: ResolveProviderDecisionOptions,
  discoveredProviders: ProviderInfo[] = discoverProviders()
): ProviderDecision {
  const now = options.now ?? Date.now();
  const shouldRecord = options.record !== false;

  if (options.decisionKey) {
    const pin = loadPinnedDecision(options.decisionKey);
    if (pin) {
      const stillInstalled = discoveredProviders.some(
        (entry) => entry.provider === pin.provider && entry.installed && entry.healthy
      );
      if (stillInstalled) {
        const instance =
          pin.instance && !isInstanceDemoted(pin.provider, pin.instance, now)
            ? pin.instance
            : selectHealthyInstance(pin.provider, now);
        const decision: ProviderDecision = {
          provider: pin.provider,
          modelId: pin.modelId,
          instance,
          strategy: 'preferred',
          orchestration: pin.orchestration,
          availableProviders: discoveredProviders
            .filter((e) => e.installed && e.healthy)
            .map((e) => e.provider),
          requiredCapabilities: (options.requiredCapabilities || [])
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean),
          unmetCapabilities: [],
          rationale: `pinned decision for '${options.decisionKey}' (pinned ${pin.pinnedAt} by ${pin.by})`,
          pinned: true,
          decisionKey: options.decisionKey,
        };
        if (shouldRecord) recordDecision(decision);
        return decision;
      }
      // Stale pin: provider no longer available. Fall through to fresh resolution.
    }
  }

  const resolved = resolveCapabilityTargetWithHealth(options, discoveredProviders, now);
  const decision: ProviderDecision = {
    ...resolved,
    pinned: false,
    decisionKey: options.decisionKey,
  };
  if (shouldRecord) recordDecision(decision);
  return decision;
}
