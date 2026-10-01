import type { AgentManifest } from '../agent/agent-manifest.js';
import { isActuatorAllowed } from '../agent/agent-manifest.js';
import { loadActuatorManifestCatalog } from '../actuator/actuator-manifest-index.js';

/**
 * Legacy tool-title keywords (substring match) that map to an actuator. These
 * preserve the pre-existing ACP permission behaviour; every other actuator is
 * derived from the actuator manifests (libs/actuators/<id>/manifest.json).
 */
const LEGACY_KEYWORD_ACTUATORS: Array<[string, string]> = [
  ['shell', 'system-actuator'],
  ['command', 'system-actuator'],
  ['exec', 'system-actuator'],
  ['file', 'file-actuator'],
  ['read_file', 'file-actuator'],
  ['write_file', 'file-actuator'],
  ['browser', 'browser-actuator'],
  ['navigate', 'browser-actuator'],
  ['network', 'network-actuator'],
  ['fetch', 'network-actuator'],
  ['curl', 'network-actuator'],
];

let cachedActuatorIds: string[] | null = null;

function listManifestActuatorIds(): string[] {
  if (!cachedActuatorIds) {
    try {
      cachedActuatorIds = loadActuatorManifestCatalog().map((entry) => entry.n);
    } catch {
      cachedActuatorIds = [];
    }
  }
  return cachedActuatorIds;
}

/** Test hook: drop the cached manifest listing. */
export function resetAcpToolActuatorResolverCache(): void {
  cachedActuatorIds = null;
}

/**
 * Resolve every actuator an ACP tool-call title refers to. Legacy keywords use
 * substring matching (unchanged); manifest-derived actuators match when the
 * actuator stem (`terminal` for `terminal-actuator`) appears as whole word(s) in
 * the title. An empty result means the tool is unknown.
 */
export function resolveAcpToolActuators(title: string): string[] {
  const lower = title.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, actuator] of LEGACY_KEYWORD_ACTUATORS) {
    if (lower.includes(keyword)) found.add(actuator);
  }
  const normalized = `-${lower
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .join('-')}-`;
  for (const id of listManifestActuatorIds()) {
    const stem = id.replace(/-actuator$/u, '');
    if (normalized.includes(`-${stem}-`)) found.add(id);
  }
  return [...found];
}

const SAFE_WORDS = ['read', 'search', 'list', 'view', 'get', 'ls', 'cat', 'grep', 'find'];
const SAFE_PHRASES = ['git status', 'git log', 'git diff'];

/** Read-only tool-title fragments that are allowed without approval (substring semantics). */
export function isAcpReadOnlyTitleFragment(title: string): boolean {
  const lower = title.toLowerCase();
  return [...SAFE_WORDS, ...SAFE_PHRASES].some((p) => lower.includes(p));
}

function isReadOnlyWord(title: string): boolean {
  const words = new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean)
  );
  return (
    SAFE_WORDS.some((w) => words.has(w)) ||
    SAFE_PHRASES.some((p) => title.toLowerCase().includes(p))
  );
}

export interface AcpManifestToolVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Manifest actuator restriction for an ACP tool call. Known tools follow the
 * manifest allow/deny lists; unknown tools fail closed when any restriction
 * is in effect (unless they are whole-word read-only operations).
 */
export function evaluateAcpManifestToolPolicy(
  manifest: AgentManifest,
  title: string
): AcpManifestToolVerdict {
  const actuators = resolveAcpToolActuators(title);
  const restricted = manifest.allowedActuators.length > 0 || manifest.deniedActuators.length > 0;
  if (actuators.length === 0 && restricted && !isReadOnlyWord(title)) {
    return {
      allowed: false,
      reason: `tool maps to no known actuator while actuator restrictions are in effect`,
    };
  }
  for (const actuator of actuators) {
    if (!isActuatorAllowed(manifest, actuator)) {
      return { allowed: false, reason: `cannot use ${actuator}` };
    }
  }
  return { allowed: true };
}
