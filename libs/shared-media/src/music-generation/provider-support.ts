import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import type { MusicGenerationRequest } from '../music-generation-types.js';

export function getFallbackTargetPath(request: MusicGenerationRequest): string {
  const filename = `generated-music-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`;
  const candidate = request.targetPath || pathResolver.resolve(`active/shared/tmp/${filename}`);
  assertSafeRepositoryPath(pathResolver.resolve(candidate), { allowMissingLeaf: true });
  return candidate;
}

export function ensureWavTargetPath(targetPath: string): string {
  const extension = path.extname(targetPath);
  if (extension.toLowerCase() === '.wav') return targetPath;
  return extension ? `${targetPath.slice(0, -extension.length)}.wav` : `${targetPath}.wav`;
}

export function patchUvxPackageSpec(args: string[], packageSpec: string): string[] {
  const next = [...args];
  const fromIndex = next.indexOf('--from');
  if (fromIndex >= 0 && next[fromIndex + 1]) {
    next[fromIndex + 1] = packageSpec;
  }
  return next;
}
