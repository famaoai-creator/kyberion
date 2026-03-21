import { logger } from './core.js';
import { safeReadFile, safeExistsSync, safeReaddir } from './secure-io.js';
import * as path from 'node:path';
import type { AgentProvider } from './agent-registry.js';

/**
 * Agent Manifest Loader v1.0
 *
 * Reads declarative agent definitions from knowledge/agents/*.agent.md
 * Each file has YAML frontmatter (config) + Markdown body (system prompt).
 */

export interface AgentRequirements {
  env?: string[];             // Required environment variables
  services?: string[];        // Required services (slack, etc.)
  actuators?: string[];       // Required actuators
  files?: string[];           // Required files (relative to project root)
}

export interface AgentManifest {
  agentId: string;
  provider: AgentProvider;
  modelId: string;
  capabilities: string[];
  autoSpawn: boolean;
  trustRequired: number;
  requires: AgentRequirements;
  allowedActuators: string[];   // Whitelist — only these actuators can be used (empty = all)
  deniedActuators: string[];    // Blacklist — these actuators are explicitly blocked
  systemPrompt: string;
  filePath: string;
}

/**
 * Parse YAML-like frontmatter from a .agent.md file.
 * Simplified parser — handles the subset we use (scalars, arrays).
 */
function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, any> = {};
  let currentParent: string | null = null;

  for (const line of match[1].split('\n')) {
    // Nested key (indented with spaces): "  env: [...]"
    const nested = line.match(/^  (\w+):\s*(.+)$/);
    if (nested && currentParent) {
      if (!meta[currentParent]) meta[currentParent] = {};
      meta[currentParent][nested[1]] = parseValue(nested[2].trim());
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

function parseValue(raw: string): any {
  // Arrays: [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (!isNaN(Number(raw)) && raw !== '') return Number(raw);
  return raw;
}

/**
 * Load all agent manifests from knowledge/agents/
 */
export function loadAgentManifests(rootDir?: string): AgentManifest[] {
  const root = rootDir || findProjectRoot();
  const agentsDir = path.join(root, 'knowledge', 'agents');

  if (!safeExistsSync(agentsDir)) {
    logger.warn(`[AGENT_MANIFEST] Directory not found: ${agentsDir}`);
    return [];
  }

  const files = safeReaddir(agentsDir).filter(f => f.endsWith('.agent.md'));
  const manifests: AgentManifest[] = [];

  for (const file of files) {
    // Security: reject filenames with path traversal
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      logger.warn(`[AGENT_MANIFEST] Rejected suspicious filename: ${file}`);
      continue;
    }
    try {
      const filePath = path.join(agentsDir, file);
      // Verify resolved path stays within agents directory
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(agentsDir))) {
        logger.warn(`[AGENT_MANIFEST] Path traversal detected: ${file}`);
        continue;
      }
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const { meta, body } = parseFrontmatter(content);

      if (!meta.agentId || !meta.provider) {
        logger.warn(`[AGENT_MANIFEST] Skipping ${file}: missing agentId or provider`);
        continue;
      }

      // Validate agentId format
      if (!/^[a-z][a-z0-9-]*$/.test(meta.agentId)) {
        logger.warn(`[AGENT_MANIFEST] Skipping ${file}: invalid agentId "${meta.agentId}" (must be lowercase, hyphens only)`);
        continue;
      }

      // Validate provider
      const validProviders = ['gemini', 'claude', 'codex', 'copilot'];
      if (!validProviders.includes(meta.provider)) {
        logger.warn(`[AGENT_MANIFEST] Skipping ${file}: invalid provider "${meta.provider}" (must be: ${validProviders.join(', ')})`);
        continue;
      }

      const req = meta.requires || {};
      manifests.push({
        agentId: meta.agentId,
        provider: meta.provider,
        modelId: meta.modelId || meta.provider,
        capabilities: Array.isArray(meta.capabilities) ? meta.capabilities : [],
        autoSpawn: meta.auto_spawn ?? meta.autoSpawn ?? false,
        trustRequired: meta.trust_required ?? meta.trustRequired ?? 0,
        requires: {
          env: Array.isArray(req.env) ? req.env : [],
          services: Array.isArray(req.services) ? req.services : [],
          actuators: Array.isArray(req.actuators) ? req.actuators : [],
          files: Array.isArray(req.files) ? req.files : [],
        },
        allowedActuators: Array.isArray(meta.allowed_actuators) ? meta.allowed_actuators : [],
        deniedActuators: Array.isArray(meta.denied_actuators) ? meta.denied_actuators : [],
        systemPrompt: body,
        filePath,
      });
    } catch (err: any) {
      logger.warn(`[AGENT_MANIFEST] Failed to parse ${file}: ${err.message}`);
    }
  }

  logger.info(`[AGENT_MANIFEST] Loaded ${manifests.length} agent definitions: ${manifests.map(m => m.agentId).join(', ')}`);
  return manifests;
}

/**
 * Get a single agent manifest by ID.
 */
export function getAgentManifest(agentId: string, rootDir?: string): AgentManifest | undefined {
  return loadAgentManifests(rootDir).find(m => m.agentId === agentId);
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
    if (!process.env[envVar]) {
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
      if (!process.env[envVar]) {
        reasons.push(`Service "${service}" requires env: ${envVar}`);
      }
    }
  }

  if (reasons.length > 0) {
    logger.warn(`[AGENT_MANIFEST] Requirements not met for ${manifest.agentId}: ${reasons.join(', ')}`);
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
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (safeExistsSync(path.join(dir, 'AGENTS.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
