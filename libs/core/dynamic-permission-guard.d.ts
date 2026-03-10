/**
 * libs/core/dynamic-permission-guard.ts
 * Kyberion Autonomous Nerve System (KANS) - Dynamic Permission Guard v1.0
 * [CORE COMPONENT - DIRECT FS AUTHORIZED]
 */
export interface DynamicPolicy {
    id: string;
    condition: {
        intent: string;
        keyword?: string;
        lookback_ms: number;
    };
    grant: {
        role: string;
        allow_paths: string[];
    };
}
declare class DynamicPermissionGuard {
    private static instance;
    private policies;
    private readonly POLICY_PATH;
    private constructor();
    static getInstance(): DynamicPermissionGuard;
    loadPolicies(): void;
    evaluate(role: string, filePath: string): {
        allowed: boolean;
        reason?: string;
    };
}
export declare const dynamicPermGuard: DynamicPermissionGuard;
export {};
//# sourceMappingURL=dynamic-permission-guard.d.ts.map