/**
 * libs/core/sensory-memory.ts
 * Kyberion Autonomous Nerve System (KANS) - Shared Sensory Memory v1.0
 * [CORE COMPONENT]
 */

import { NerveMessage } from './nerve-bridge.js';
import { appendStimulus, isStimulusExpired, loadRecentStimuli } from './stimuli-journal.js';
import { createLogger } from './logger.js';
const logger = createLogger('sensory-memory');

const MAX_MEMORY_SIZE = 5000;

export class SensoryMemory {
  private static instance: SensoryMemory;
  private buffer: NerveMessage[] = [];
  private hydrated = false;

  private constructor() {}

  public static getInstance(): SensoryMemory {
    if (!SensoryMemory.instance) {
      SensoryMemory.instance = new SensoryMemory();
    }
    return SensoryMemory.instance;
  }

  private hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      this.buffer.push(...loadRecentStimuli(MAX_MEMORY_SIZE));
    } catch (err) {
      logger.warn(`suppressed error in hydrate: ${err}`);
    }
  }

  public remember(stimulus: NerveMessage) {
    this.hydrate();
    this.buffer.push(stimulus);
    if (this.buffer.length > MAX_MEMORY_SIZE) this.buffer.shift();
    appendStimulus(stimulus);
  }

  /**
   * EV-04: `timeWindowMs` is required, not optional.
   *
   * This previously searched the whole buffer with no time bound, so a single
   * historical stimulus made the intent "present" forever. Its only production
   * caller is the dynamic permission guard, which decides whether to open a
   * temporary write grant — an unbounded lookup there means a grant that never
   * closes. A window the caller must state is the whole point of the lookup.
   */
  public getLatestByIntent(intent: string, timeWindowMs: number): NerveMessage | undefined {
    this.hydrate();
    const cutoff = Date.now() - timeWindowMs;
    return this.buffer
      .slice()
      .reverse()
      .find((m) => {
        if (m.intent !== intent && (m as any).signal?.intent !== intent) return false;
        if (isStimulusExpired(m)) return false;
        const ts = new Date(m.ts).getTime();
        return Number.isFinite(ts) && ts >= cutoff;
      });
  }

  public hasActiveContext(keyword: string, timeWindowMs: number): boolean {
    this.hydrate();
    const cutoff = Date.now() - timeWindowMs;
    return this.buffer.some((msg) => {
      const ts = new Date(msg.ts).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) return false;
      // A stimulus past its own declared TTL must not keep a context "active",
      // regardless of how wide a window the caller asks for.
      if (isStimulusExpired(msg)) return false;

      // Extract payload from any known format
      const payload = msg.payload || (msg as any).signal?.payload || '';
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

      return payloadStr.includes(keyword);
    });
  }
}

export const sensoryMemory = SensoryMemory.getInstance();
