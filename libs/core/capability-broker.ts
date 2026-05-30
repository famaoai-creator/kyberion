import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { discoverProviders, type ProviderInfo } from './provider-discovery.js';
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

interface PinnedEntry {
  provider: string;
  modelId: string;
  instance: string | null;
  orchestration: HealthAwareResolution['orchestration'];
  pinnedAt: string;
  by: string;
}

interface PinFile {
  version: string;
  missionId?: string;
  pins: Record<string, PinnedEntry>;
}

const PIN_FILE_VERSION = '1.0';

function actorId(): string {
  return process.env.KYBERION_PERSONA || process.env.MISSION_ROLE || 'capability-broker';
}

/**
 * Where pins live. Inside the mission's own repo when MISSION_ID resolves to one (so they roll back
 * atomically with the mission); otherwise a shared runtime file keyed by mission id.
 */
function pinFilePath(): string {
  const missionId = process.env.MISSION_ID;
  if (missionId) {
    for (const tier of ['personal', 'confidential', 'public']) {
      const missionDir = pathResolver.rootResolve(path.join('active/missions', tier, missionId));
      if (safeExistsSync(path.join(missionDir, 'mission-state.json'))) {
        return path.join(missionDir, 'provider-pins.json');
      }
    }
    return pathResolver.rootResolve(path.join('active/shared/runtime/provider-pins', `${missionId}.json`));
  }
  return pathResolver.rootResolve('active/shared/runtime/provider-pins/default.json');
}

function readPinFile(): PinFile {
  try {
    const filePath = pinFilePath();
    if (!safeExistsSync(filePath)) return { version: PIN_FILE_VERSION, pins: {} };
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as PinFile;
    if (parsed && typeof parsed.pins === 'object' && parsed.pins !== null) return parsed;
  } catch { /* treat as empty */ }
  return { version: PIN_FILE_VERSION, pins: {} };
}

function writePinFile(file: PinFile): void {
  const filePath = pinFilePath();
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(file, null, 2), { encoding: 'utf8' });
}

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
    pinnedAt: new Date().toISOString(),
    by: actorId(),
  };
  file.version = PIN_FILE_VERSION;
  file.missionId = process.env.MISSION_ID;
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
  discoveredProviders: ProviderInfo[] = discoverProviders(),
): ProviderDecision {
  const now = options.now ?? Date.now();
  const shouldRecord = options.record !== false;

  if (options.decisionKey) {
    const pin = loadPinnedDecision(options.decisionKey);
    if (pin) {
      const stillInstalled = discoveredProviders.some(
        (entry) => entry.provider === pin.provider && entry.installed && entry.healthy,
      );
      if (stillInstalled) {
        const instance = pin.instance && !isInstanceDemoted(pin.provider, pin.instance, now)
          ? pin.instance
          : selectHealthyInstance(pin.provider, now);
        const decision: ProviderDecision = {
          provider: pin.provider,
          modelId: pin.modelId,
          instance,
          strategy: 'preferred',
          orchestration: pin.orchestration,
          availableProviders: discoveredProviders.filter((e) => e.installed && e.healthy).map((e) => e.provider),
          requiredCapabilities: (options.requiredCapabilities || []).map((c) => c.trim().toLowerCase()).filter(Boolean),
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
