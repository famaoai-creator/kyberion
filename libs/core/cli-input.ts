import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { safeReadFile } from './secure-io.js';

export function resolveCliInputPath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(pathResolver.rootDir(), inputPath);
}

export function readTextFile(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

export function readJsonFile<T = any>(filePath: string): T {
  return readJson<T>(filePath);
}

export function readJsonCliInput<T = any>(inputPath: string): T {
  return readJsonFile<T>(resolveCliInputPath(inputPath));
}
