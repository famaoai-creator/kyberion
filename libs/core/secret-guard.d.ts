/**
 * Issued by Orchestrator to authorize a secret for a limited time.
 */
export declare const grantAccess: (missionId: string, serviceId: string, ttlMinutes?: number) => void;
/**
 * Retrieve a secret value, enforcing temporal and intent-based gates.
 */
export declare const getSecret: (key: string, scope?: string) => string | null;
export declare const getActiveSecrets: () => string[];
/**
 * Checks if a given path points to a known secret location.
 */
export declare const isSecretPath: (filePath: string) => boolean;
export declare const secretGuard: {
    getSecret: (key: string, scope?: string) => string | null;
    getActiveSecrets: () => string[];
    grantAccess: (missionId: string, serviceId: string, ttlMinutes?: number) => void;
    isSecretPath: (filePath: string) => boolean;
};
//# sourceMappingURL=secret-guard.d.ts.map