/**
 * Entropy Gate v1.0
 * Allows the agent to detect if the environment has changed.
 */
export declare const entropyGate: {
    /**
     * Compare the given data with its last seen state.
     * If identical, returns false (Gate Closed - Sleep).
     * If changed, updates cache and returns true (Gate Open - Process).
     */
    shouldWake(key: string, data: any): boolean;
    /**
     * Reset the gate for a specific key.
     */
    reset(key: string): void;
};
//# sourceMappingURL=entropy-gate.d.ts.map