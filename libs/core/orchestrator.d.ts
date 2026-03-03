export declare function resolveSkillScript(skillName: string): string;
export declare function runStep(script: string, args: string, step?: any): {
    status: string;
    data: any;
    attempts: number;
    recovered: boolean;
    error?: undefined;
} | {
    status: string;
    error: any;
    attempts: number;
    recovered: boolean;
    data?: undefined;
} | {
    status: string;
    error: string;
    attempts: any;
    recovered: boolean;
    data?: undefined;
};
export declare function runPipeline(steps: any[], initialData?: {}): {
    pipeline: boolean;
    totalSteps: number;
    completedSteps: number;
    duration_ms: number;
    steps: never[];
};
export declare function runParallel(steps: any[]): Promise<any>;
export declare function loadPipeline(yamlPath: string): {
    name: any;
    steps: any;
    run: (initialData: any) => {
        pipeline: boolean;
        totalSteps: number;
        completedSteps: number;
        duration_ms: number;
        steps: never[];
    };
};
//# sourceMappingURL=orchestrator.d.ts.map