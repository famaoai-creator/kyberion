/**
 * Detects file encoding and line endings.
 */
export declare function detectEncoding(bufferOrPath: string | Buffer): {
    lineEnding: string;
    encoding: string;
    confidence: number;
};
/**
 * Detects natural language of text.
 */
export declare function detectLanguage(text: string): {
    language: string;
    confidence: number;
};
/**
 * Detects data format (json, yaml, csv).
 */
export declare function detectFormat(text: string): {
    format: string;
    confidence: number;
};
//# sourceMappingURL=detectors.d.ts.map