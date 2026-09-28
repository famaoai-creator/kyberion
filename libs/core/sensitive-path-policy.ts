import * as os from 'node:os';
import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';

/**
 * OH-02: credential paths are a deny layer that runs before tier, persona,
 * sudo, or approval checks. Keep this registry as the single source of truth
 * for filesystem and command-path protection.
 */
export interface SensitivePathRule {
  id: string;
  description: string;
  resolveRoots: () => string[];
}

export interface SensitivePathMatch {
  ruleId: string;
  description: string;
  matchedRoot: string;
}

/**
 * Resolved credential roots for one HOME / KYBERION_ROOT / cwd combination.
 * `run-gc` calls this check once per directory entry, and each rule used to
 * re-read the environment registry and re-resolve the same roots. The snapshot
 * is rebuilt only when one of those three inputs changes, which tests do
 * between cases via `setRegisteredEnv`.
 */
interface RootSnapshot {
  stamp: string;
  home: string;
  project: string;
  roots: readonly (readonly string[])[];
}

let rootSnapshot: RootSnapshot | null = null;
/** Set while `resolveRoots` runs, so those closures read the snapshot being built. */
let pendingRoots: { home: string; project: string } | null = null;

function currentRootSnapshot(): RootSnapshot {
  const homeKey = getRegisteredEnvText('HOME')?.trim() ?? '';
  const projectKey = getRegisteredEnvText('KYBERION_ROOT')?.trim() ?? '';
  const cwd = process.cwd();
  const stamp = `${homeKey}\0${projectKey}\0${cwd}`;
  if (rootSnapshot?.stamp === stamp) return rootSnapshot;

  const home = path.resolve(homeKey || os.homedir());
  const project = path.resolve(projectKey || cwd);
  pendingRoots = { home, project };
  try {
    const roots = SENSITIVE_PATH_RULES.map((rule) =>
      rule.resolveRoots().map((root) => path.resolve(root))
    );
    rootSnapshot = { stamp, home, project, roots };
    return rootSnapshot;
  } finally {
    pendingRoots = null;
  }
}

function homeRoot(): string {
  if (pendingRoots) return pendingRoots.home;
  return currentRootSnapshot().home;
}

function projectRoot(): string {
  if (pendingRoots) return pendingRoots.project;
  return currentRootSnapshot().project;
}

function descendantRoot(root: string, child: string): string {
  return path.join(root, child);
}

export const SENSITIVE_PATH_RULES: readonly SensitivePathRule[] = [
  {
    id: 'credential.ssh',
    description: 'SSH keys and configuration',
    resolveRoots: () => [descendantRoot(homeRoot(), '.ssh')],
  },
  {
    id: 'credential.aws',
    description: 'AWS credential file',
    resolveRoots: () => [descendantRoot(homeRoot(), '.aws/credentials')],
  },
  {
    id: 'credential.kube',
    description: 'Kubernetes client credentials',
    resolveRoots: () => [descendantRoot(homeRoot(), '.kube/config')],
  },
  {
    id: 'credential.gnupg',
    description: 'GnuPG private key material',
    resolveRoots: () => [descendantRoot(homeRoot(), '.gnupg')],
  },
  {
    id: 'credential.claude',
    description: 'Claude CLI credentials',
    resolveRoots: () => [descendantRoot(homeRoot(), '.claude/.credentials.json')],
  },
  {
    id: 'credential.codex',
    description: 'Codex CLI credentials',
    resolveRoots: () => [descendantRoot(homeRoot(), '.codex/auth.json')],
  },
  {
    id: 'credential.kyberion-connections',
    description: 'Kyberion OAuth and service connection documents',
    resolveRoots: () => [path.join(projectRoot(), 'knowledge/personal/connections')],
  },
  {
    id: 'credential.kyberion-vault',
    description: 'Kyberion local secret vault',
    resolveRoots: () => [path.join(projectRoot(), 'vault/secrets')],
  },
];

function normalizeCandidate(candidate: string): string {
  const expanded = candidate
    .replace(/^~(?=$|[\\/])/, homeRoot())
    .replace(/^\$HOME(?=$|[\\/])/, homeRoot())
    .replace(/^\$\{HOME\}(?=$|[\\/])/, homeRoot());
  return path.resolve(expanded);
}

function isNormalizedPathWithin(normalizedCandidate: string, normalizedRoot: string): boolean {
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  // On Windows, path.relative() returns an absolute path when the two paths
  // are on different drives. That absolute result is not a descendant of the
  // sensitive root and must not be accepted by the prefix checks below.
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

export function findSensitivePathMatch(candidate: string): SensitivePathMatch | null {
  if (!candidate || typeof candidate !== 'string') return null;
  const snapshot = currentRootSnapshot();
  const normalizedCandidate = normalizeCandidate(candidate);
  for (let index = 0; index < SENSITIVE_PATH_RULES.length; index += 1) {
    const rule = SENSITIVE_PATH_RULES[index];
    const roots = snapshot.roots[index];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      if (isNormalizedPathWithin(normalizedCandidate, roots[rootIndex])) {
        return { ruleId: rule.id, description: rule.description, matchedRoot: roots[rootIndex] };
      }
    }
  }
  return null;
}

/**
 * Extract path-like tokens from a shell command without attempting to execute
 * or fully parse shell syntax. The command policy performs the final verdict.
 */
export function findSensitivePathInText(text: string): SensitivePathMatch | null {
  if (!text || typeof text !== 'string') return null;
  const candidates =
    text.match(
      /(?:~[\/][^\s"'`;&|<>]+|\$HOME[\/][^\s"'`;&|<>]+|\$\{HOME\}[\/][^\s"'`;&|<>]+|\/(?:[^\s"'`;&|<>])+)/g
    ) || [];
  for (const candidate of candidates) {
    const match = findSensitivePathMatch(candidate);
    if (match) return match;
  }
  return null;
}

export function sensitivePathDeniedError(operation: string, match: SensitivePathMatch): Error {
  return new Error(
    `[SENSITIVE_PATH_DENIED] ${operation} blocked by ${match.ruleId}: ${match.description}.`
  );
}

export function assertSensitivePathAllowed(
  candidate: string,
  operation: string,
  mediated = false
): void {
  if (mediated) return;
  const match = findSensitivePathMatch(candidate);
  if (match) throw sensitivePathDeniedError(operation, match);
}

export function assertSensitiveTextAllowed(text: string, operation: string): void {
  const match = findSensitivePathInText(text);
  if (match) throw sensitivePathDeniedError(operation, match);
}

export function getSensitivePathRuleIds(): string[] {
  return SENSITIVE_PATH_RULES.map((rule) => rule.id);
}
