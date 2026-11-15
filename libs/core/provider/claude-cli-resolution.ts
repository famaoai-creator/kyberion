import * as os from 'node:os';
import * as path from 'node:path';
import { safeExistsSync } from '../secure-io.js';
import { trimEndChars } from '../foundation/text.js';
import { executableName, getPlatformFacts } from '../platform-facts.js';

export const CLAUDE_CLI_PLACEHOLDER_SIGNATURE = 'claude native binary not installed';

export function isClaudeCliPlaceholderFailure(reason: string | undefined | null): boolean {
  return Boolean(reason && reason.toLowerCase().includes(CLAUDE_CLI_PLACEHOLDER_SIGNATURE));
}

/**
 * Whether the default `claude` failure warrants searching the well-known
 * install locations: the pnpm placeholder shim, or no `claude` on PATH at all
 * (ENOENT) — the usual case under a daemon's minimal launchd/systemd/cron PATH.
 */
export function isClaudeCliFallbackEligible(reason: string | undefined | null): boolean {
  return isClaudeCliPlaceholderFailure(reason) || /\bENOENT\b/.test(reason ?? '');
}

export interface ClaudeCliFallbackCandidateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  exists?: (candidatePath: string) => boolean;
}

function isNodeModulesBinDir(entry: string, windows: boolean): boolean {
  const normalized = trimEndChars(entry.replace(/\\/g, '/'), '/');
  return (windows ? normalized.toLowerCase() : normalized).endsWith('/node_modules/.bin');
}

/** Resolve real Claude CLIs without spawning; pnpm placeholder directories are skipped. */
export function resolveClaudeCliFallbackCandidates(
  options: ClaudeCliFallbackCandidateOptions = {}
): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const facts = getPlatformFacts(options.platform);
  const windows = facts.family === 'windows';
  const paths = windows ? path.win32 : path.posix;
  // Native .exe files can be spawned directly. Batch/PowerShell shims cannot.
  const binary = executableName('claude', facts);
  const exists =
    options.exists ??
    ((candidatePath: string): boolean => {
      try {
        return safeExistsSync(candidatePath);
      } catch {
        return false;
      }
    });

  const wellKnown = [
    paths.join(home, '.local', 'bin', binary),
    ...(windows ? [] : [env.HOMEBREW_PREFIX?.trim(), '/opt/homebrew', '/usr/local'])
      .filter((prefix): prefix is string => Boolean(prefix))
      .map((prefix) => paths.join(prefix, 'bin', binary)),
  ];
  const pathValue =
    env.PATH ??
    (windows
      ? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
      : undefined) ??
    '';
  const pathCandidates = pathValue
    .split(paths.delimiter)
    .map((entry) => (windows ? entry.trim().replace(/^"(.*)"$/u, '$1') : entry.trim()))
    .filter(Boolean)
    .filter((entry) => !isNodeModulesBinDir(entry, windows))
    .map((entry) => paths.join(entry, binary));

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [...wellKnown, ...pathCandidates]) {
    const key = windows ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (exists(candidate)) candidates.push(candidate);
  }
  return candidates;
}
