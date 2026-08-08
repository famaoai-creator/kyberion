import * as os from 'node:os';
import * as path from 'node:path';
import { safeExistsSync } from './secure-io.js';

export const CLAUDE_CLI_PLACEHOLDER_SIGNATURE = 'claude native binary not installed';

export function isClaudeCliPlaceholderFailure(reason: string | undefined | null): boolean {
  return Boolean(reason && reason.toLowerCase().includes(CLAUDE_CLI_PLACEHOLDER_SIGNATURE));
}

export interface ClaudeCliFallbackCandidateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (candidatePath: string) => boolean;
}

function isNodeModulesBinDir(entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.endsWith('/node_modules/.bin');
}

/** Resolve real Claude CLIs without spawning; pnpm placeholder directories are skipped. */
export function resolveClaudeCliFallbackCandidates(
  options: ClaudeCliFallbackCandidateOptions = {}
): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
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
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  const pathCandidates = (env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !isNodeModulesBinDir(entry))
    .map((entry) => path.join(entry, 'claude'));

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of [...wellKnown, ...pathCandidates]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (exists(candidate)) candidates.push(candidate);
  }
  return candidates;
}
