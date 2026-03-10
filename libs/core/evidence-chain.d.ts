/**
 * Chain of Evidence: The Blockchain of Artifacts
 * [SECURE-IO COMPLIANT VERSION]
 */
export declare const evidenceChain: {
    registryPath: string;
    register: (filePath: string, agentId: string, parentId?: string | null, context?: string) => string;
    getLineage: (evidenceId: string) => any[];
    _loadRegistry: () => any;
};
//# sourceMappingURL=evidence-chain.d.ts.map