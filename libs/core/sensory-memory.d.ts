/**
 * libs/core/sensory-memory.ts
 * Kyberion Autonomous Nerve System (KANS) - Shared Sensory Memory v1.0
 * [CORE COMPONENT - DIRECT FS AUTHORIZED]
 */
import { NerveMessage } from './nerve-bridge.js';
export declare class SensoryMemory {
    private static instance;
    private buffer;
    private constructor();
    static getInstance(): SensoryMemory;
    private hydrate;
    remember(stimulus: NerveMessage): void;
    getLatestByIntent(intent: string): NerveMessage | undefined;
    hasActiveContext(keyword: string, timeWindowMs: number): boolean;
}
export declare const sensoryMemory: SensoryMemory;
//# sourceMappingURL=sensory-memory.d.ts.map