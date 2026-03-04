export interface WalkOptions {
    maxDepth?: number;
    currentDepth?: number;
}
/**
 * Recursively walk through a directory and yield file paths.
 */
export declare function walk(dir: string, options?: WalkOptions): Generator<string>;
/**
 * Get all files in a directory as an array.
 */
export declare function getAllFiles(dir: string, options?: WalkOptions): string[];
/**
 * Asynchronously walk through a directory and yield file paths.
 */
export declare function walkAsync(dir: string, options?: WalkOptions): AsyncGenerator<string>;
/**
 * Get all files asynchronously.
 */
export declare function getAllFilesAsync(dir: string, options?: WalkOptions): Promise<string[]>;
/**
 * Map an array through an async function with limited concurrency.
 */
export declare function mapAsync<T, R>(items: T[], concurrency: number, taskFn: (item: T) => Promise<R>): Promise<R[]>;
//# sourceMappingURL=fs-utils.d.ts.map