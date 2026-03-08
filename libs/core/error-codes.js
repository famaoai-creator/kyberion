"use strict";
/**
 * Standardized Error Codes for Gemini Skills Ecosystem.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KyberionError = exports.ERROR_CODES = void 0;
exports.ERROR_CODES = {
    // --- Logic Resolution (1xx) ---
    LOGIC_NOT_FOUND: {
        code: 'E100',
        message: 'Logic component not found in index',
        retryable: false,
    },
    SCRIPT_NOT_FOUND: {
        code: 'E101',
        message: 'No executable script found for logic',
        retryable: false,
    },
    AMBIGUOUS_SCRIPT: {
        code: 'E102',
        message: 'Multiple scripts found without explicit main field',
        retryable: false,
    },
    // --- Input Validation (2xx) ---
    VALIDATION_ERROR: {
        code: 'E200',
        message: 'Input validation failed',
        retryable: false,
    },
    MISSING_ARGUMENT: {
        code: 'E201',
        message: 'Required argument is missing',
        retryable: false,
    },
    INVALID_FILE_PATH: {
        code: 'E202',
        message: 'File path is invalid or file does not exist',
        retryable: false,
    },
    SCHEMA_MISMATCH: {
        code: 'E203',
        message: 'Input does not match expected JSON Schema',
        retryable: false,
    },
    // --- Execution (3xx) ---
    EXECUTION_ERROR: {
        code: 'E300',
        message: 'Logic execution failed',
        retryable: true,
    },
    TIMEOUT: {
        code: 'E301',
        message: 'Execution timed out',
        retryable: true,
    },
    DEPENDENCY_ERROR: {
        code: 'E302',
        message: 'External dependency (CLI tool, API) unavailable',
        retryable: true,
    },
    PARSE_ERROR: {
        code: 'E303',
        message: 'Failed to parse execution output',
        retryable: false,
    },
    // --- Pipeline / Orchestration (4xx) ---
    PIPELINE_STEP_FAILED: {
        code: 'E400',
        message: 'A step in the pipeline failed',
        retryable: false,
    },
    PIPELINE_ABORTED: {
        code: 'E401',
        message: 'Pipeline was aborted due to a non-recoverable step failure',
        retryable: false,
    },
    INVALID_PIPELINE: {
        code: 'E402',
        message: 'Pipeline YAML is malformed or missing required fields',
        retryable: false,
    },
    // --- Knowledge / Security (5xx) ---
    TIER_VIOLATION: {
        code: 'E500',
        message: 'Knowledge tier data flow violation detected',
        retryable: false,
    },
    WRITE_DENIED: {
        code: 'E501',
        message: 'Write operation denied by role-based access control',
        retryable: false,
    },
    READ_DENIED: {
        code: 'E502',
        message: 'Read operation denied — path is outside sandbox',
        retryable: false,
    },
    SOVEREIGN_LEAK: {
        code: 'E503',
        message: 'Potential sovereign secret leak detected in output',
        retryable: false,
    },
};
/**
 * Custom error class that carries a structured error code.
 */
class KyberionError extends Error {
    code;
    retryable;
    context;
    cause;
    constructor(errorDef, detail, options = {}) {
        const msg = detail ? `${errorDef.message}: ${detail}` : errorDef.message;
        super(msg);
        this.name = 'KyberionError';
        this.code = errorDef.code;
        this.retryable = errorDef.retryable;
        if (options.cause)
            this.cause = options.cause;
        if (options.context)
            this.context = options.context;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.context && { context: this.context }),
        };
    }
}
exports.KyberionError = KyberionError;
