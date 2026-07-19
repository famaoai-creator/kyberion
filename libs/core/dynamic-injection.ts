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

const GLOBAL_KEY = Symbol.for('kyberion.dynamicInjectionRegistry');
const MISSION_REGISTRIES_KEY = Symbol.for('kyberion.dynamicInjectionMissionRegistries');

function missionRegistries(): Map<string, DynamicInjectionRegistry> {
  const holder = globalThis as Record<symbol, unknown>;
  if (!holder[MISSION_REGISTRIES_KEY]) {
    holder[MISSION_REGISTRIES_KEY] = new Map<string, DynamicInjectionRegistry>();
  }
  return holder[MISSION_REGISTRIES_KEY] as Map<string, DynamicInjectionRegistry>;
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

/** Reset all live registries after compaction, including mission-scoped ones. */
export function notifyAllDynamicInjectionRegistries(): void {
  getDefaultDynamicInjectionRegistry().notifyContextCompacted();
  for (const registry of missionRegistries().values()) registry.notifyContextCompacted();
}

/** Test seam. */
export function resetDefaultDynamicInjectionRegistry(): void {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  missionRegistries().clear();
}
