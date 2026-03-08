/**
 * libs/core/sensory-memory.ts
 * Kyberion Autonomous Nerve System (KANS) - Shared Sensory Memory v1.0
 * [CORE COMPONENT - DIRECT FS AUTHORIZED]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { NerveMessage } from './nerve-bridge.js';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
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
      if (!fs.existsSync(STIMULI_PATH)) return;
      const content = fs.readFileSync(STIMULI_PATH, 'utf8');
      const lines = content.trim().split('\n');
      
      // Get the last N lines to ensure we have the most recent context
      const latestLines = lines.slice(-MAX_MEMORY_SIZE);
      for (const line of latestLines) {
        if (!line) continue;
        try {
          this.buffer.push(JSON.parse(line));
        } catch (_) {}
      }
    } catch (_) {}
  }

  public remember(stimulus: NerveMessage) {
    this.buffer.push(stimulus);
    if (this.buffer.length > MAX_MEMORY_SIZE) this.buffer.shift();
    fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
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
