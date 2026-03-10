/**
 * Structured Logger - provides leveled, structured logging for skills.
 */
export declare const LOG_LEVELS: Record<string, number>;
export interface LoggerOptions {
    level?: string;
    json?: boolean;
}
export declare function createLogger(name: string, options?: LoggerOptions): {
    debug: (msg: string, data?: any) => void;
    info: (msg: string, data?: any) => void;
    warn: (msg: string, data?: any) => void;
    error: (msg: string, data?: any) => void;
    child: (childName: string) => /*elided*/ any;
};
//# sourceMappingURL=logger.d.ts.map