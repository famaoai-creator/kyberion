export interface MetricsOptions {
    metricsDir?: string;
    metricsFile?: string;
    persist?: boolean;
    memoryBudgetMB?: number;
}
export declare class MetricsCollector {
    private _metricsDir;
    private _metricsFile;
    private _persist;
    private _memoryBudgetMB;
    private _aggregates;
    constructor(options?: MetricsOptions);
    record(skillName: string, durationMs: number, status: 'success' | 'error', extra?: any): void;
    recordIntervention(context: string, decisionId: string): void;
    summarize(): any[];
    getSkillMetrics(skillName: string): any;
    loadHistory(): any[];
    reportFromHistory(): {
        totalEntries: number;
        uniqueSkills: number;
        dateRange: {
            from: any;
            to: any;
        };
        skills: {
            skill: string;
            executions: any;
            errors: any;
            errorRate: number;
            avgMs: number;
            minMs: any;
            maxMs: any;
            cacheHitRatio: number;
            sloCompliance: number;
            efficiencyScore: number;
            manualMs: number;
            savedMs: number;
            savedCost: number;
        }[];
    };
    detectRegressions(thresholdMultiplier?: number): any[];
    reset(): void;
    private _appendToFile;
}
export declare const metrics: MetricsCollector;
//# sourceMappingURL=metrics.d.ts.map