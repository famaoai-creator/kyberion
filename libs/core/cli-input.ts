import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { assertSafeRepositoryPath, safeLstat, safeReadFile } from './secure-io.js';

export function resolveCliInputPath(inputPath: string): string {
  return assertSafeRepositoryPath(
    path.isAbsolute(inputPath) ? inputPath : path.resolve(pathResolver.rootDir(), inputPath),
    { allowMissingLeaf: true }
  );
}

export function readTextFile(filePath: string): string {
  return safeReadFile(assertSafeRepositoryPath(filePath, { allowMissingLeaf: false }), {
    encoding: 'utf8',
  }) as string;
}

export function readJsonFile<T = any>(filePath: string): T {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[CLI_INPUT] JSON input must be a regular file: ${filePath}`);
  }
  return parseSafeJsonInput(
    String(safeReadFile(safeFilePath, { encoding: 'utf8' }) || ''),
    `CLI JSON input ${filePath}`
  ) as T;
}

export function readJsonCliInput<T = any>(inputPath: string): T {
  return readJsonFile<T>(resolveCliInputPath(inputPath));
}
