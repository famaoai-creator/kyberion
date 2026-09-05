import { logger } from './core.js';
import { loadAgentProfileIndex } from './mission-team-index.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeExistsSync,
  safeReaddir,
  safeLstat,
  safeStat,
} from './secure-io.js';
import { isRecord } from './foundation/text.js';
import { getRegisteredEnvText } from './foundation/env.js';
import * as path from 'node:path';
import type { AgentProvider } from './agent-registry.js';

/**
 * Agent Manifest Loader v1.0
 *
 * Reads declarative agent definitions from knowledge/product/agents/*.agent.md.
 * The manifest files are canonical agent definitions; provider/model selection
 * hints are merged from the product agent-profile index as a policy overlay.
 */

export interface AgentRequirements {
  env?: string[]; // Required environment variables
  services?: string[]; // Required services (slack, etc.)
  actuators?: string[]; // Required actuators
  files?: string[]; // Required files (relative to project root)
}

export interface AgentSelectionHints {
  preferred_provider?: AgentProvider;
  preferred_modelId?: string;
  provider_strategy?: 'strict' | 'preferred' | 'adaptive';
  fallback_providers?: string[];
}

export interface AgentManifest {
  agentId: string;
  selection_hints?: AgentSelectionHints;
  capabilities: string[];
  autoSpawn: boolean;
  trustRequired: number;
  requires: AgentRequirements;
  allowedActuators: string[]; // Whitelist — only these actuators can be used (empty = all)
  deniedActuators: string[]; // Blacklist — these actuators are explicitly blocked
  systemPrompt: string;
  filePath: string;
}

/**
 * Parse YAML-like frontmatter from a .agent.md file.
 * Simplified parser — handles the subset we use (scalars, arrays).
 */
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, unknown> = {};
  let currentParent: string | null = null;

  for (const line of match[1].split('\n')) {
    // Nested key (indented with spaces): "  env: [...]"
    const nested = line.match(/^  (\w+):\s*(.+)$/);
    if (nested && currentParent) {
      const parent = isRecord(meta[currentParent]) ? meta[currentParent] : {};
      parent[nested[1]] = parseValue(nested[2].trim());
      meta[currentParent] = parent;
      continue;
    }

    // Top-level key
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const trimmed = rawValue.trim();

    // If value is empty, this is a parent for nested keys
    if (!trimmed) {
      currentParent = key;
      continue;
    }

    currentParent = null;
    meta[key] = parseValue(trimmed);
  }

  return { meta, body: match[2].trim() };
}

function parseValue(raw: string): unknown {
  // Arrays: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => parseValue(s.trim()))
      .filter((value) => value !== '');
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (!isNaN(Number(raw)) && raw !== '') return Number(raw);
  return raw;
}

/**
 * Load agent selection-hint overlays from
 * knowledge/product/orchestration/agent-profiles/.
 *
 * This is intentionally separate from the manifest files themselves so the
 * execution contract stays in the agent manifest while provider/model policy
 * can evolve independently.
 */
function loadAgentProfileSelectionHints(rootDir: string): Record<string, AgentSelectionHints> {
  try {
    const profiles = loadAgentProfileIndex(rootDir);
    const result: Record<string, AgentSelectionHints> = {};
    for (const [agentId, entry] of Object.entries(profiles)) {
      result[agentId] = {
        preferred_provider: entry.selection_hints?.preferred_provider,
        preferred_modelId: entry.selection_hints?.preferred_modelId,
        provider_strategy: entry.provider_strategy,
        fallback_providers: entry.fallback_providers,
      };
    }
    return result;
  } catch (error: unknown) {
    logger.warn(
      `[AGENT_MANIFEST] Failed to load profile selection hints: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}

export function resolveAgentSelectionHints(
  manifest: AgentManifest,
  fallbackProvider?: AgentProvider
): { provider: AgentProvider; modelId: string } {
  const legacyProvider = (manifest as AgentManifest & { provider?: AgentProvider }).provider;
  const legacyModelId = (manifest as AgentManifest & { modelId?: string }).modelId;
  return resolveSelectionHints(
    manifest.selection_hints,
    fallbackProvider || legacyProvider,
    legacyModelId,
    manifest.agentId
  );
}

export function resolveSelectionHints(
  selectionHints: AgentSelectionHints | undefined,
  fallbackProvider?: AgentProvider,
  fallbackModelId?: string,
  agentId = 'unknown-agent'
): { provider: AgentProvider; modelId: string } {
  const provider = selectionHints?.preferred_provider || fallbackProvider;
  const modelId = selectionHints?.preferred_modelId || fallbackModelId;
  if (!provider) {
    throw new Error(`Missing provider selection hint for agent "${agentId}"`);
  }
  if (!modelId) {
    throw new Error(`Missing model selection hint for agent "${agentId}"`);
  }
  return { provider, modelId };
}

interface ManifestCacheEntry {
  manifests: AgentManifest[];
  loadedAt: number;
  dirMtimeMs: number;
}

const manifestCache = new Map<string, ManifestCacheEntry>();
const MANIFEST_CACHE_TTL_MS = 5_000;

function readDirMtime(dir: string): number {
  try {
    return safeStat(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Load all agent manifests from knowledge/product/agents/ and merge the
 * selection-hint overlay from knowledge/product/orchestration/agent-profiles/.
 *
 * Cached for {@link MANIFEST_CACHE_TTL_MS} ms per rootDir, invalidated when the
 * agents directory mtime changes. Without this cache, every API call in a
 * surface re-parses every manifest and emits a duplicate `[AGENT_MANIFEST]
 * Loaded N agent definitions` log line.
 */
export function loadAgentManifests(rootDir?: string): AgentManifest[] {
  const root = rootDir || findProjectRoot();
  const agentsDir = assertSafeRepositoryPath(path.join(root, 'knowledge', 'product', 'agents'), {
    allowMissingLeaf: true,
  });

  const cached = manifestCache.get(agentsDir);
  const now = Date.now();
  const currentMtime = readDirMtime(agentsDir);
  if (
    cached &&
    now - cached.loadedAt < MANIFEST_CACHE_TTL_MS &&
    cached.dirMtimeMs === currentMtime
  ) {
    return cached.manifests;
  }

  const profileSelectionHints = loadAgentProfileSelectionHints(root);

  if (!safeExistsSync(agentsDir)) {
    logger.warn(`[AGENT_MANIFEST] Directory not found: ${agentsDir}`);
    return [];
  }

  const files = safeReaddir(agentsDir).filter((f) => f.endsWith('.agent.md'));
  const manifests: AgentManifest[] = [];

  for (const file of files) {
    // Security: reject filenames with path traversal
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      logger.warn(`[AGENT_MANIFEST] Rejected suspicious filename: ${file}`);
      continue;
    }
    try {
      const filePath = assertSafeRepositoryPath(path.join(agentsDir, file));
      if (!safeLstat(filePath).isFile()) {
        logger.warn(`[AGENT_MANIFEST] Skipping ${file}: manifest must be a regular file`);
        continue;
      }
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const { meta, body } = parseFrontmatter(content);

      if (typeof meta.agentId !== 'string' || !meta.agentId) {
        logger.warn(`[AGENT_MANIFEST] Skipping ${file}: missing agentId`);
        continue;
      }

      // Validate agentId format
      if (!/^[a-z][a-z0-9-]*$/.test(meta.agentId)) {
        logger.warn(
          `[AGENT_MANIFEST] Skipping ${file}: invalid agentId "${meta.agentId}" (must be lowercase, hyphens only)`
        );
        continue;
      }

      const profileHints = profileSelectionHints[meta.agentId] || {};

      const req = isRecord(meta.requires) ? meta.requires : {};
      manifests.push({
        agentId: meta.agentId,
        selection_hints: profileHints,
        capabilities: stringArray(meta.capabilities),
        autoSpawn: optionalBoolean(meta.auto_spawn) ?? optionalBoolean(meta.autoSpawn) ?? false,
        trustRequired:
          optionalFiniteNumber(meta.trust_required) ??
          optionalFiniteNumber(meta.trustRequired) ??
          0,
        requires: {
          env: stringArray(req.env),
          services: stringArray(req.services),
          actuators: stringArray(req.actuators),
          files: stringArray(req.files),
        },
        allowedActuators: stringArray(meta.allowed_actuators),
        deniedActuators: stringArray(meta.denied_actuators),
        systemPrompt: body,
        filePath,
      });
    } catch (err: unknown) {
      logger.warn(
        `[AGENT_MANIFEST] Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.info(
    `[AGENT_MANIFEST] Loaded ${manifests.length} agent definitions: ${manifests.map((m) => m.agentId).join(', ')}`
  );
  manifestCache.set(agentsDir, { manifests, loadedAt: now, dirMtimeMs: currentMtime });
  return manifests;
}

/** Test/dev helper: clear the manifest cache (e.g. after editing a manifest). */
export function clearAgentManifestCache(): void {
  manifestCache.clear();
}

/**
 * Get a single agent manifest by ID.
 */
export function getAgentManifest(agentId: string, rootDir?: string): AgentManifest | undefined {
  return loadAgentManifests(rootDir).find((m) => m.agentId === agentId);
}

/**
 * Validate that an agent's requirements are met.
 * Returns { ok: true } or { ok: false, reasons: [...] }.
 */
export function validateRequirements(
  manifest: AgentManifest,
  rootDir?: string
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const root = rootDir || findProjectRoot();
  const req = manifest.requires;

  // Check environment variables
  for (const envVar of req.env || []) {
    if (!getRegisteredEnvText(envVar)) {
      reasons.push(`Missing env: ${envVar}`);
    }
  }

  // Check required files
  for (const file of req.files || []) {
    const filePath = path.resolve(root, file);
    if (!safeExistsSync(filePath)) {
      reasons.push(`Missing file: ${file}`);
    }
  }

  // Check actuators (verify directory exists)
  for (const actuator of req.actuators || []) {
    const actuatorDir = path.join(root, 'libs', 'actuators', actuator);
    if (!safeExistsSync(actuatorDir)) {
      reasons.push(`Missing actuator: ${actuator}`);
    }
  }

  // Services are validated by checking known service configs
  // For now, service check = env vars for that service exist
  const SERVICE_ENV_MAP: Record<string, string[]> = {
    slack: ['SLACK_BOT_TOKEN'],
    github: ['GITHUB_TOKEN'],
  };
  for (const service of req.services || []) {
    const requiredEnvs = SERVICE_ENV_MAP[service] || [];
    for (const envVar of requiredEnvs) {
      if (!getRegisteredEnvText(envVar)) {
        reasons.push(`Service "${service}" requires env: ${envVar}`);
      }
    }
  }

  if (reasons.length > 0) {
    logger.warn(
      `[AGENT_MANIFEST] Requirements not met for ${manifest.agentId}: ${reasons.join(', ')}`
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Check if an agent is allowed to use a specific actuator.
 */
export function isActuatorAllowed(manifest: AgentManifest, actuator: string): boolean {
  // Explicit deny always wins
  if (manifest.deniedActuators.length > 0 && manifest.deniedActuators.includes(actuator)) {
    return false;
  }
  // If whitelist is set, only listed actuators are allowed
  if (manifest.allowedActuators.length > 0) {
    return manifest.allowedActuators.includes(actuator);
  }
  // No restrictions
  return true;
}

function findProjectRoot(): string {
  return pathResolver.rootDir();
}
