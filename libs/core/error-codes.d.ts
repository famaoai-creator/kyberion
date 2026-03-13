/**
 * Standardized Error Codes for Kyberion Ecosystem.
 */
export declare const ERROR_CODES: {
    LOGIC_NOT_FOUND: {
        code: string;
        message: string;
        retryable: boolean;
    };
    SCRIPT_NOT_FOUND: {
        code: string;
        message: string;
        retryable: boolean;
    };
    AMBIGUOUS_SCRIPT: {
        code: string;
        message: string;
        retryable: boolean;
    };
    VALIDATION_ERROR: {
        code: string;
        message: string;
        retryable: boolean;
    };
    MISSING_ARGUMENT: {
        code: string;
        message: string;
        retryable: boolean;
    };
    INVALID_FILE_PATH: {
        code: string;
        message: string;
        retryable: boolean;
    };
    SCHEMA_MISMATCH: {
        code: string;
        message: string;
        retryable: boolean;
    };
    EXECUTION_ERROR: {
        code: string;
        message: string;
        retryable: boolean;
    };
    TIMEOUT: {
        code: string;
        message: string;
        retryable: boolean;
    };
    DEPENDENCY_ERROR: {
        code: string;
        message: string;
        retryable: boolean;
    };
    PARSE_ERROR: {
        code: string;
        message: string;
        retryable: boolean;
    };
    PIPELINE_STEP_FAILED: {
        code: string;
        message: string;
        retryable: boolean;
    };
    PIPELINE_ABORTED: {
        code: string;
        message: string;
        retryable: boolean;
    };
    INVALID_PIPELINE: {
        code: string;
        message: string;
        retryable: boolean;
    };
    TIER_VIOLATION: {
        code: string;
        message: string;
        retryable: boolean;
    };
    WRITE_DENIED: {
        code: string;
        message: string;
        retryable: boolean;
    };
    READ_DENIED: {
        code: string;
        message: string;
        retryable: boolean;
    };
    SOVEREIGN_LEAK: {
        code: string;
        message: string;
        retryable: boolean;
    };
};
/**
 * Custom error class that carries a structured error code.
 */
export declare class KyberionError extends Error {
    code: string;
    retryable: boolean;
    context: any;
    cause: any;
    constructor(errorDef: any, detail?: string, options?: any);
    toJSON(): {
        context: any;
        code: string;
        message: string;
        retryable: boolean;
    };
}
//# sourceMappingURL=error-codes.d.ts.map