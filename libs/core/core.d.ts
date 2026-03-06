/**
 * Shared Utility Core for Gemini Skills (TypeScript Edition)
 */
export declare const logger: {
    _log: (level: string, msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    success: (msg: string) => void;
};
export declare const ui: {
    spinner: (msg: string) => {
        stop: (success?: boolean) => void;
    };
    generateMissionId: () => string;
    formatDuration: (ms: number) => string;
    progressBar: (current: number, total: number, width?: number) => string;
    confirm: (question: string) => Promise<boolean>;
    ask: (question: string) => Promise<string>;
    summarize: (data: any, maxItems?: number) => any;
    stripAnsi: (input: string) => string;
};
export declare const sre: {
    analyzeRootCause: (errorMessage: string) => any;
};
export declare class Cache {
    private _maxSize;
    private _ttlMs;
    private _persistenceDir;
    private _map;
    private _stats;
    constructor(maxSize?: number, ttlMs?: number, persistenceDir?: string);
    getStats(): any;
    purge(fraction?: number): void;
    get(key: string): any;
    set(key: string, value: any, customTtlMs?: number, persist?: boolean): void;
    private _generateHash;
    private _getDiskPath;
    has(key: string): boolean;
    clear(): void;
    get size(): number;
}
export declare const _fileCache: Cache;
export declare const errorHandler: (err: any, context?: string) => never;
export declare const fileUtils: {
    getCurrentRole: () => any;
    getFullRoleConfig: () => any;
    ensureDir: (dirPath: string) => void;
    readJson: (filePath: string) => any;
    writeJson: (filePath: string, data: any) => void;
    getGoldenRule: () => string;
};
//# sourceMappingURL=core.d.ts.map