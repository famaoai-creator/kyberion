/**
 * Recursively walk through a directory and yield file paths.
 * Automatically respects ignore lists from project_standards.json.
 */
export function walk(
  dir: string,
  options?: { maxDepth?: number; includeBinary?: boolean; currentDepth?: number }
): Generator<string>;

/**
 * Get all files in a directory as an array.
 */
export function getAllFiles(
  dir: string,
  options?: { maxDepth?: number; includeBinary?: boolean }
): string[];

/**
 * Asynchronously walk through a directory and yield file paths.
 */
export function walkAsync(
  dir: string,
  options?: { maxDepth?: number; includeBinary?: boolean; currentDepth?: number }
): AsyncGenerator<string>;

/**
 * Get all files asynchronously.
 */
export function getAllFilesAsync(
  dir: string,
  options?: { maxDepth?: number; includeBinary?: boolean }
): Promise<string[]>;

/**
 * Map an array through an async function with limited concurrency.
 */
export function mapAsync<T, R>(
  items: T[],
  concurrency: number,
  taskFn: (item: T) => Promise<R>
): Promise<R[]>;
