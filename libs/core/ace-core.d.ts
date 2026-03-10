/**
 * ACE (Autonomous Consensus Engine) Core Utility
 */
export declare const aceCore: {
    calculateHash: (text: string) => string;
    appendThought: (minutesPath: string, role: string, thought: string, _metadata?: {}) => string;
    validateIntegrity: (minutesPath: string) => boolean;
    evaluateDecision: (votes: any[]) => {
        decision: string;
        reason: string;
        allowYellowCard: boolean;
        debtAction?: undefined;
    } | {
        decision: string;
        reason: string;
        allowYellowCard: boolean;
        debtAction: any;
    };
};
//# sourceMappingURL=ace-core.d.ts.map