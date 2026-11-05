import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';

export type VoicePathKind = 'audio-input' | 'recording-output' | 'transcript-output';

function projectRoot(): string {
  return path.resolve(pathResolver.rootResolve('.'));
}

function isWithin(child: string, parent: string): boolean {
  return pathResolver.isPathInsideOrEqual(parent, child);
}

function approvedRoots(kind: VoicePathKind): string[] {
  const root = projectRoot();
  const shared = path.resolve(pathResolver.shared());
  const tmp = path.resolve(pathResolver.sharedTmp());
  const runtime = path.resolve(pathResolver.shared('runtime/voice-profiles'));
  const personalVoice = path.resolve(pathResolver.rootResolve('knowledge/personal/voice'));
  if (kind === 'recording-output' || kind === 'transcript-output') {
    return [tmp, runtime, personalVoice];
  }
  return [root, shared, tmp, runtime, personalVoice];
}

/** Constrain voice data paths before they cross into a subprocess. */
export function resolveVoicePath(inputPath: string, kind: VoicePathKind): string {
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error(`voice ${kind} path is required`);
  const resolved = path.resolve(pathResolver.rootResolve(raw));
  const root = projectRoot();
  if (!isWithin(resolved, root)) {
    throw new Error(`[SECURITY] voice ${kind} path must stay inside the project root: ${raw}`);
  }
  if (!approvedRoots(kind).some((allowedRoot) => isWithin(resolved, allowedRoot))) {
    throw new Error(
      `[SECURITY] voice ${kind} path is outside an approved voice data directory: ${raw}`
    );
  }
  return assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
}

export function isVoicePathAllowed(inputPath: string, kind: VoicePathKind): boolean {
  try {
    resolveVoicePath(inputPath, kind);
    return true;
  } catch {
    return false;
  }
}
