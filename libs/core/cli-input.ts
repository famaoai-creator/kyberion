import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { readTextFile as readFoundationTextFile } from './foundation/text.js';
import { assertSafeRepositoryPath, safeLstat } from './secure-io.js';

export function resolveCliInputPath(inputPath: string): string {
  return assertSafeRepositoryPath(
    path.isAbsolute(inputPath) ? inputPath : path.resolve(pathResolver.rootDir(), inputPath),
    { allowMissingLeaf: true }
  );
}

export function readTextFile(filePath: string): string {
  return readFoundationTextFile(assertSafeRepositoryPath(filePath, { allowMissingLeaf: false }));
}

export function readJsonFile<T = unknown>(filePath: string): T {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[CLI_INPUT] JSON input must be a regular file: ${filePath}`);
  }
  return parseSafeJsonInput(
    readFoundationTextFile(safeFilePath),
    `CLI JSON input ${filePath}`
  ) as T;
}

export function readJsonCliInput<T = unknown>(inputPath: string): T {
  return readJsonFile<T>(resolveCliInputPath(inputPath));
}
