import * as path from 'node:path';
import { pathResolver } from '@agent/core';
import { safeReadFile } from '@agent/core/secure-io';

export function resolveCliInputPath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(pathResolver.rootDir(), inputPath);
}

export function readTextFile(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

export function readJsonFile<T = any>(filePath: string): T {
  return JSON.parse(readTextFile(filePath)) as T;
}

export function readJsonCliInput<T = any>(inputPath: string): T {
  return readJsonFile<T>(resolveCliInputPath(inputPath));
}
