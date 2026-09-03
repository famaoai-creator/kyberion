/**
 * DH-16: discover project-local Claude/Codex hook configuration.
 *
 * Discovery is deliberately separate from registration. Reading a config is
 * not permission to execute its commands: registration requires an explicit
 * trust decision and all paths must remain below the selected project root.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { parseSafeJsonObjectValue, readJson } from './foundation/json.js';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { assertProjectTrustApproval } from './project-trust.js';
import {
  registerExternalLifecycleHooks,
  type ExternalHookSource,
  type ExternalHookBridgeResult,
} from './external-hook-bridge.js';
import { getDefaultLifecycleHookEngine, LifecycleHookEngine } from './lifecycle-hook-engine.js';

export interface ExternalHookConfigCandidate {
  source: ExternalHookSource;
  path: string;
  scope?: 'project' | 'global';
}

export interface ExternalHookDiscoveryOptions {
  rootDir?: string;
  sources?: ExternalHookSource[];
  includeLocalClaudeSettings?: boolean;
  /** Explicit opt-in for user-level provider configuration. */
  includeGlobal?: boolean;
  /** Test/host override for the user config root; defaults to HOME. */
  globalHomeDir?: string;
  trustResolved: boolean;
  /** Hash-bound approval IDs keyed by absolute or repository-relative project config path. */
  projectTrustApprovalIds?: Readonly<Record<string, string>>;
  /** Separate trust decision required before registering global configs. */
  globalTrustResolved?: boolean;
}

export interface ExternalHookDiscoveryResult {
  discovered: ExternalHookConfigCandidate[];
  registered: number;
  skipped: Array<{ path: string; reason: string }>;
  dispose: () => Promise<void>;
}

const PROJECT_CANDIDATES: ReadonlyArray<ExternalHookConfigCandidate> = [
  { source: 'claude-code', path: '.claude/settings.json', scope: 'project' },
  { source: 'claude-code', path: '.claude/settings.local.json', scope: 'project' },
  { source: 'codex', path: '.codex/hooks.json', scope: 'project' },
];

const GLOBAL_CANDIDATES: ReadonlyArray<ExternalHookConfigCandidate> = [
  { source: 'claude-code', path: '.claude/settings.json', scope: 'global' },
  { source: 'codex', path: '.codex/hooks.json', scope: 'global' },
];

function isBelowRoot(filePath: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const target = path.resolve(filePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function isSafeConfigPath(filePath: string, rootDir: string): boolean {
  if (!isBelowRoot(filePath, rootDir)) return false;
  const root = path.resolve(rootDir);
  if (!safeExistsSync(root) || safeLstat(root).isSymbolicLink()) return false;
  const relative = path.relative(root, path.resolve(filePath)).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return false;
  }
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (!safeExistsSync(current)) return false;
    if (safeLstat(current).isSymbolicLink()) return false;
  }
  return true;
}

function projectTrustApprovalId(
  candidate: ExternalHookConfigCandidate,
  options: ExternalHookDiscoveryOptions
): string | undefined {
  if (candidate.scope !== 'project' || !options.projectTrustApprovalIds) return undefined;
  const absolute = path.resolve(candidate.path);
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  return options.projectTrustApprovalIds[absolute] || options.projectTrustApprovalIds[relative];
}

export function discoverExternalHookConfigs(
  options: Omit<ExternalHookDiscoveryOptions, 'trustResolved'> & { trustResolved?: boolean } = {}
): ExternalHookConfigCandidate[] {
  const rootDir = path.resolve(options.rootDir || pathResolver.rootDir());
  const sources = new Set(options.sources || (['claude-code', 'codex'] as ExternalHookSource[]));
  const includeLocal = options.includeLocalClaudeSettings !== false;
  const project = PROJECT_CANDIDATES.filter(
    (candidate) =>
      sources.has(candidate.source) &&
      (includeLocal || candidate.path !== '.claude/settings.local.json')
  )
    .map((candidate) => ({
      ...candidate,
      path: path.resolve(rootDir, candidate.path),
    }))
    .filter(
      (candidate) => isSafeConfigPath(candidate.path, rootDir) && safeExistsSync(candidate.path)
    );
  if (options.includeGlobal !== true) return project;

  const rawHomeDir = options.globalHomeDir || process.env.HOME;
  if (!rawHomeDir?.trim()) return project;
  const homeDir = path.resolve(rawHomeDir);
  const global = GLOBAL_CANDIDATES.filter((candidate) => sources.has(candidate.source)).map(
    (candidate) => ({ ...candidate, path: path.resolve(homeDir, candidate.path) })
  );
  return [...project, ...global.filter((candidate) => isSafeConfigPath(candidate.path, homeDir))];
}

/**
 * Discover and register project-local external hooks after trust resolution.
 * A malformed discovered config is reported and not partially registered.
 */
export function registerDiscoveredExternalLifecycleHooks(
  engine: LifecycleHookEngine,
  options: ExternalHookDiscoveryOptions
): ExternalHookDiscoveryResult {
  if (options.trustResolved !== true) {
    throw new Error(
      '[EXTERNAL_HOOK_TRUST_REQUIRED] project trust must be resolved before registration'
    );
  }
  const candidates = discoverExternalHookConfigs(options);
  if (
    candidates.some((candidate) => candidate.scope === 'global') &&
    options.globalTrustResolved !== true
  ) {
    throw new Error(
      '[EXTERNAL_HOOK_GLOBAL_TRUST_REQUIRED] global provider config requires a separate trust decision'
    );
  }
  const bridges: ExternalHookBridgeResult[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    try {
      if (candidate.scope === 'project') {
        const approvalId = projectTrustApprovalId(candidate, options);
        if (!approvalId) {
          throw new Error(
            `[EXTERNAL_HOOK_APPROVAL_REQUIRED] project hook config requires a hash-bound approval: ${candidate.path}`
          );
        }
        assertProjectTrustApproval(approvalId, candidate.path);
      }
      const parsed = parseSafeJsonObjectValue(
        readJson<unknown>(candidate.path),
        `external hook config ${candidate.path}`
      );
      bridges.push(registerExternalLifecycleHooks(engine, parsed, candidate.source));
    } catch (error) {
      skipped.push({
        path: candidate.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    discovered: candidates,
    registered: bridges.reduce((count, bridge) => count + bridge.registered, 0),
    skipped,
    dispose: async () => {
      for (const bridge of bridges.reverse()) await bridge.dispose();
    },
  };
}

/**
 * Register trusted external hooks on the process-wide lifecycle engine. The
 * trust and hash-bound approval requirements remain identical to the explicit
 * engine variant; only the engine selection is centralized for real runtime
 * bootstrap callers.
 */
export function registerDiscoveredExternalLifecycleHooksOnDefaultEngine(
  options: ExternalHookDiscoveryOptions
): ExternalHookDiscoveryResult {
  return registerDiscoveredExternalLifecycleHooks(getDefaultLifecycleHookEngine(), options);
}
