export declare const getSecret: (key: string) => string | null;
export declare const getActiveSecrets: () => string[];
export declare const isSecretPath: (filePath: string) => boolean;
export declare const secretGuard: {
    getSecret: (key: string) => string | null;
    getActiveSecrets: () => string[];
    isSecretPath: (filePath: string) => boolean;
};
//# sourceMappingURL=secret-guard.d.ts.map