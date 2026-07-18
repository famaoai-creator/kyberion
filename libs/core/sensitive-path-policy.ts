import * as os from 'node:os';
import * as path from 'node:path';

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

function homeRoot(): string {
  return path.resolve(process.env.HOME?.trim() || os.homedir());
}

function projectRoot(): string {
  return path.resolve(process.env.KYBERION_ROOT?.trim() || process.cwd());
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

function isPathWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeCandidate(candidate);
  const normalizedRoot = normalizeCandidate(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function findSensitivePathMatch(candidate: string): SensitivePathMatch | null {
  if (!candidate || typeof candidate !== 'string') return null;
  for (const rule of SENSITIVE_PATH_RULES) {
    for (const root of rule.resolveRoots()) {
      if (isPathWithin(candidate, root)) {
        return { ruleId: rule.id, description: rule.description, matchedRoot: root };
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
