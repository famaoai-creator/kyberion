/**
 * Dynamic injection provider contract (KC-08).
 *
 * Prompt injections (working principles, repeat-governor warnings, delegation
 * notifications) share one lifecycle: collect before a step, throttle so the
 * same reminder is not repeated every step, and re-fire one-shot injections
 * after a context compaction wiped them. Modeled on kimi-cli's
 * dynamic_injection.py (throttled providers + on_context_compacted reset).
 *
 * Providers stay pure collectors; the registry owns throttling and compaction
 * resets so a provider cannot forget them.
 */

import { logger } from './core.js';
import { frameUntrustedInput } from './untrusted-input-framing.js';
import {
  canonicalizeScopedRegistryScope,
  ScopedRegistry,
  type ScopedRegistryScope,
} from './scoped-registry.js';

export interface DynamicInjectionState {
  /** Monotonic step counter of the consuming loop (for step-based pacing). */
  step?: number;
  [key: string]: unknown;
}

export interface DynamicInjectionProvider {
  id: string;
  /** Minimum ms between two injections from this provider (default 0). */
  throttleMs?: number;
  /** Inject at most once until the next compaction reset. */
  oneShot?: boolean;
  /** Return the injection text, or null when nothing should be injected. */
  collect(state: DynamicInjectionState): string | null;
  /** Optional extra reset work beyond the registry's own bookkeeping. */
  onContextCompacted?(): void;
}

export interface CollectedInjection {
  providerId: string;
  text: string;
}

interface ProviderBookkeeping {
  lastInjectedAtMs?: number;
  firedSinceReset: boolean;
}

export class DynamicInjectionRegistry {
  private readonly providers = new Map<
    string,
    { provider: DynamicInjectionProvider; bookkeeping: ProviderBookkeeping }
  >();

  register(provider: DynamicInjectionProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`[INJECTION_CONFIG] Duplicate dynamic injection provider: ${provider.id}`);
    }
    this.providers.set(provider.id, { provider, bookkeeping: { firedSinceReset: false } });
    return () => {
      this.providers.delete(provider.id);
    };
  }

  /**
   * Collect due injections. Provider failures are isolated (fail-open): a
   * broken reminder must never stop the loop it decorates.
   */
  collect(state: DynamicInjectionState = {}, nowMs: number = Date.now()): CollectedInjection[] {
    const collected: CollectedInjection[] = [];
    for (const { provider, bookkeeping } of this.providers.values()) {
      if (provider.oneShot && bookkeeping.firedSinceReset) continue;
      if (
        provider.throttleMs &&
        bookkeeping.lastInjectedAtMs !== undefined &&
        nowMs - bookkeeping.lastInjectedAtMs < provider.throttleMs
      ) {
        continue;
      }
      let text: string | null = null;
      try {
        text = provider.collect(state);
      } catch (err) {
        logger.warn(
          `[dynamic-injection] provider ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (!text || !text.trim()) continue;
      bookkeeping.lastInjectedAtMs = nowMs;
      bookkeeping.firedSinceReset = true;
      collected.push({ providerId: provider.id, text: text.trim() });
    }
    return collected;
  }

  /**
   * Compaction wiped the context: clear one-shot/throttle bookkeeping so
   * standing reminders (working principles etc.) re-fire on the next step.
   */
  notifyContextCompacted(): void {
    for (const { provider, bookkeeping } of this.providers.values()) {
      bookkeeping.firedSinceReset = false;
      bookkeeping.lastInjectedAtMs = undefined;
      try {
        provider.onContextCompacted?.();
      } catch (err) {
        logger.warn(
          `[dynamic-injection] provider ${provider.id} compaction reset failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  get providerCount(): number {
    return this.providers.size;
  }

  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}

/**
 * DH-09: scope-aware dynamic injections. Ancestor providers are inherited by
 * descendants; a same-id provider at a more specific scope shadows it. The
 * generic ScopedRegistry owns deterministic selection while this wrapper owns
 * provider throttling/compaction state.
 */
export class ScopedDynamicInjectionRegistry {
  private readonly providers = new ScopedRegistry<DynamicInjectionProvider>();
  private readonly bookkeeping = new Map<string, ProviderBookkeeping>();

  register(scope: ScopedRegistryScope, provider: DynamicInjectionProvider): () => void {
    const dispose = this.providers.register(scope, provider.id, provider);
    const key = this.providerKey(scope, provider.id);
    this.bookkeeping.set(key, { firedSinceReset: false });
    return () => {
      dispose();
      this.bookkeeping.delete(key);
    };
  }

  collect(
    scope: ScopedRegistryScope,
    state: DynamicInjectionState = {},
    nowMs: number = Date.now()
  ): CollectedInjection[] {
    const collected: CollectedInjection[] = [];
    for (const entry of this.providers.list(scope)) {
      const bookkeeping = this.bookkeeping.get(this.providerKey(entry.scope, entry.id));
      if (!bookkeeping) continue;
      const provider = entry.value;
      if (provider.oneShot && bookkeeping.firedSinceReset) continue;
      if (
        provider.throttleMs &&
        bookkeeping.lastInjectedAtMs !== undefined &&
        nowMs - bookkeeping.lastInjectedAtMs < provider.throttleMs
      ) {
        continue;
      }
      let text: string | null = null;
      try {
        text = provider.collect(state);
      } catch (err) {
        logger.warn(
          `[dynamic-injection] scoped provider ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (!text || !text.trim()) continue;
      bookkeeping.lastInjectedAtMs = nowMs;
      bookkeeping.firedSinceReset = true;
      collected.push({ providerId: provider.id, text: text.trim() });
    }
    return collected;
  }

  notifyContextCompacted(): void {
    for (const entry of this.providers.listAll()) {
      const bookkeeping = this.bookkeeping.get(this.providerKey(entry.scope, entry.id));
      if (!bookkeeping) continue;
      bookkeeping.firedSinceReset = false;
      bookkeeping.lastInjectedAtMs = undefined;
      try {
        entry.value.onContextCompacted?.();
      } catch (err) {
        logger.warn(
          `[dynamic-injection] scoped provider ${entry.id} compaction reset failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  list(scope: ScopedRegistryScope): ScopedRegistryScope[] {
    return this.providers.list(scope).map((entry) => entry.scope);
  }

  get providerCount(): number {
    return this.providers.size;
  }

  hasProvider(scope: ScopedRegistryScope, providerId: string): boolean {
    return this.providers.get(scope, providerId) !== undefined;
  }

  private providerKey(scope: ScopedRegistryScope, providerId: string): string {
    return `${canonicalizeScopedRegistryScope(scope)}::${providerId.trim()}`;
  }
}

/**
 * Injections are carried as standalone user-role messages; merge adjacent
 * same-role text messages so providers never fragment the visible history
 * (kimi-cli normalize_history).
 */
export function mergeAdjacentSameRoleMessages<T extends { role: string; content: string }>(
  messages: readonly T[],
  separator = '\n\n'
): T[] {
  const merged: T[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      merged[merged.length - 1] = {
        ...previous,
        content: `${previous.content}${separator}${message.content}`,
      };
      continue;
    }
    merged.push({ ...message });
  }
  return merged;
}

/** Render collected injections as system-reminder blocks for prompt assembly. */
export function renderInjectionsAsSystemReminders(
  injections: readonly CollectedInjection[]
): string {
  return injections
    .map((injection) => `<system-reminder>${injection.text}</system-reminder>`)
    .join('\n');
}

/**
 * Working principles as a one-shot provider: injected once per context
 * lifetime, re-fired automatically after a compaction reset (the compacted
 * transcript no longer contains the original brief).
 */
export function buildWorkingPrinciplesInjectionProvider(
  buildLines: (teamRole?: string) => readonly string[],
  teamRole?: string
): DynamicInjectionProvider {
  return {
    id: 'working-principles',
    oneShot: true,
    collect: () => {
      const lines = buildLines(teamRole);
      return lines.length > 0 ? lines.join('\n') : null;
    },
  };
}

/**
 * Build a provider whose injected text originates outside the system prompt
 * (goal objectives, delegation echoes, surface input) and therefore must go
 * through the KD-04 injection framing contract before it reaches `collect()`
 * callers. `getData` returns the raw, untrusted text (or null/empty to skip
 * this cycle); `frameUntrustedInput` (untrusted-input-framing.ts) does the
 * HTML-escape + `<untrusted_data>` tag + boilerplate so this provider never
 * hand-rolls its own framing.
 */
export function buildUntrustedDataInjectionProvider(
  id: string,
  source: string,
  getData: (state: DynamicInjectionState) => string | null,
  options?: Pick<DynamicInjectionProvider, 'throttleMs' | 'oneShot' | 'onContextCompacted'>
): DynamicInjectionProvider {
  return {
    id,
    throttleMs: options?.throttleMs,
    oneShot: options?.oneShot,
    onContextCompacted: options?.onContextCompacted,
    collect: (state) => {
      const data = getData(state);
      if (!data || !data.trim()) return null;
      return frameUntrustedInput({ data, source });
    },
  };
}

const GLOBAL_KEY = Symbol.for('kyberion.dynamicInjectionRegistry');
const MISSION_REGISTRIES_KEY = Symbol.for('kyberion.dynamicInjectionMissionRegistries');
const SCOPED_MISSION_REGISTRIES_KEY = Symbol.for(
  'kyberion.dynamicInjectionScopedMissionRegistries'
);

function missionRegistries(): Map<string, DynamicInjectionRegistry> {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[MISSION_REGISTRIES_KEY]) {
    holder[MISSION_REGISTRIES_KEY] = new Map<string, DynamicInjectionRegistry>();
  }
  return holder[MISSION_REGISTRIES_KEY] as Map<string, DynamicInjectionRegistry>;
}

function scopedMissionRegistries(): Map<string, ScopedDynamicInjectionRegistry> {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[SCOPED_MISSION_REGISTRIES_KEY]) {
    holder[SCOPED_MISSION_REGISTRIES_KEY] = new Map<string, ScopedDynamicInjectionRegistry>();
  }
  return holder[SCOPED_MISSION_REGISTRIES_KEY] as Map<string, ScopedDynamicInjectionRegistry>;
}

/**
 * Process-wide registry. Compaction (worker-context-compaction) notifies it
 * so one-shot reminders re-fire without every consumer wiring the reset.
 */
export function getDefaultDynamicInjectionRegistry(): DynamicInjectionRegistry {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[GLOBAL_KEY]) holder[GLOBAL_KEY] = new DynamicInjectionRegistry();
  return holder[GLOBAL_KEY] as DynamicInjectionRegistry;
}

/** A persistent registry per mission; one-shot state must not leak between missions. */
export function getMissionDynamicInjectionRegistry(missionId: string): DynamicInjectionRegistry {
  const key = String(missionId || '').trim();
  if (!key) throw new Error('[INJECTION_SCOPE] missionId is required');
  const registries = missionRegistries();
  let registry = registries.get(key);
  if (!registry) {
    registry = new DynamicInjectionRegistry();
    registries.set(key, registry);
  }
  return registry;
}

/** DH-09: persistent scope-aware registry per mission. */
export function getMissionScopedDynamicInjectionRegistry(
  missionId: string
): ScopedDynamicInjectionRegistry {
  const key = String(missionId || '').trim();
  if (!key) throw new Error('[INJECTION_SCOPE] missionId is required');
  const registries = scopedMissionRegistries();
  let registry = registries.get(key);
  if (!registry) {
    registry = new ScopedDynamicInjectionRegistry();
    registries.set(key, registry);
  }
  return registry;
}

/** Reset all live registries after compaction, including mission-scoped ones. */
export function notifyAllDynamicInjectionRegistries(): void {
  getDefaultDynamicInjectionRegistry().notifyContextCompacted();
  for (const registry of missionRegistries().values()) registry.notifyContextCompacted();
  for (const registry of scopedMissionRegistries().values()) registry.notifyContextCompacted();
}

/** Test seam. */
export function resetDefaultDynamicInjectionRegistry(): void {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  missionRegistries().clear();
  scopedMissionRegistries().clear();
}
