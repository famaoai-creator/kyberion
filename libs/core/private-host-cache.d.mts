export function currentUid(): number | null;

export function isTrustedStat(
  stat: { uid: number; mode: number },
  uid: number | null,
  platform?: NodeJS.Platform
): boolean;

export function privateHostCacheSupported(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform
): boolean;

export function realpathOfDeepestAncestor(target: string): string | null;

export function relativeInside(root: string, target: string): string | null;

export function resolvePrivateCacheDir(options: {
  projectRoot: string;
  name: string;
  override?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string | null;

export function ensureTrustedRoot(dir: string, uid?: number | null): boolean;

export function removeQuietly(filePath: string): void;

export function readTrustedFile(filePath: string, uid?: number | null): string | null;

export function writeTrustedFile(filePath: string, text: string): boolean;
