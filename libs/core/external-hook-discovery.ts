/**
 * DH-16: discover project-local Claude/Codex hook configuration.
 *
 * Discovery is deliberately separate from registration. Reading a config is
 * not permission to execute its commands: registration requires an explicit
 * trust decision and all paths must remain below the selected project root.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  registerExternalLifecycleHooks,
  type ExternalHookSource,
  type ExternalHookBridgeResult,
} from './external-hook-bridge.js';
import { LifecycleHookEngine } from './lifecycle-hook-engine.js';

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
    .filter((candidate) => isBelowRoot(candidate.path, rootDir) && safeExistsSync(candidate.path));
  if (options.includeGlobal !== true) return project;

  const rawHomeDir = options.globalHomeDir || process.env.HOME;
  if (!rawHomeDir?.trim()) return project;
  const homeDir = path.resolve(rawHomeDir);
  const global = GLOBAL_CANDIDATES.filter((candidate) => sources.has(candidate.source)).map(
    (candidate) => ({ ...candidate, path: path.resolve(homeDir, candidate.path) })
  );
  return [...project, ...global.filter((candidate) => safeExistsSync(candidate.path))];
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
      const raw = String(safeReadFile(candidate.path, { encoding: 'utf8' }) || '');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config root must be an object');
      }
      bridges.push(
        registerExternalLifecycleHooks(engine, parsed as Record<string, unknown>, candidate.source)
      );
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
