import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { assertSafeRepositoryPath, safeReadFile } from './secure-io.js';

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
  return readJson<T>(assertSafeRepositoryPath(filePath, { allowMissingLeaf: false }));
}

export function readJsonCliInput<T = any>(inputPath: string): T {
  return readJsonFile<T>(resolveCliInputPath(inputPath));
}
