/**
 * libs/core/sensory-memory.ts
 * Kyberion Autonomous Nerve System (KANS) - Shared Sensory Memory v1.0
 * [CORE COMPONENT]
 */

import { NerveMessage } from './nerve-bridge.js';
import { appendStimulus, loadRecentStimuli } from './stimuli-journal.js';

const MAX_MEMORY_SIZE = 5000;

export class SensoryMemory {
  private static instance: SensoryMemory;
  private buffer: NerveMessage[] = [];

  private constructor() {
    this.hydrate();
  }

  public static getInstance(): SensoryMemory {
    if (!SensoryMemory.instance) {
      SensoryMemory.instance = new SensoryMemory();
    }
    return SensoryMemory.instance;
  }

  private hydrate() {
    try {
      this.buffer.push(...loadRecentStimuli(MAX_MEMORY_SIZE));
    } catch (_) {}
  }

  public remember(stimulus: NerveMessage) {
    this.buffer.push(stimulus);
    if (this.buffer.length > MAX_MEMORY_SIZE) this.buffer.shift();
    appendStimulus(stimulus);
  }

  public getLatestByIntent(intent: string): NerveMessage | undefined {
    return this.buffer.slice().reverse().find(m => m.intent === intent || (m as any).signal?.intent === intent);
  }

  public hasActiveContext(keyword: string, timeWindowMs: number): boolean {
    const cutoff = Date.now() - timeWindowMs;
    return this.buffer.some(msg => {
      const ts = new Date(msg.ts).getTime();
      if (ts < cutoff) return false;
      
      // Extract payload from any known format
      const payload = msg.payload || (msg as any).signal?.payload || '';
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      
      return payloadStr.includes(keyword);
    });
  }
}

export const sensoryMemory = SensoryMemory.getInstance();
