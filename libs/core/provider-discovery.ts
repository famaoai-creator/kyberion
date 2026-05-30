import { logger } from './core.js';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeUnlinkSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

/**
 * Provider Discovery v1.0
 *
 * Detects which LLM agent providers are installed and available.
 * Results are cached to avoid repeated shell calls.
 *
 * Cache strategy:
 *   1. In-memory (per-process, reset on restart)
 *   2. Disk cache under active/shared/runtime/ (survives process restarts)
 */

export interface ProviderInfo {
  provider: string;
  installed: boolean;
  version: string | null;
  protocol: 'acp' | 'print-json' | 'exec' | 'json-rpc';
  models: string[];
  capabilities?: string[];
  modelCapabilities?: Record<string, string[]>;
  healthy: boolean;
}

let cachedProviders: ProviderInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 300000; // 5 min

const DISK_CACHE_PATH = pathResolver.rootResolve('active/shared/runtime/provider-cache.json');

function readDiskCache(): ProviderInfo[] | null {
  try {
    if (!safeExistsSync(DISK_CACHE_PATH)) return null;
    const raw = safeReadFile(DISK_CACHE_PATH, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as { ts: number; providers: ProviderInfo[] };
    if (Date.now() - parsed.ts < CACHE_TTL) return parsed.providers;
  } catch { /* cache miss — non-fatal */ }
  return null;
}

function writeDiskCache(providers: ProviderInfo[]): void {
  try {
    const dir = path.dirname(DISK_CACHE_PATH);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(DISK_CACHE_PATH, JSON.stringify({ ts: Date.now(), providers }), { encoding: 'utf8' });
  } catch { /* non-fatal */ }
}

/**
 * Provider/model capability catalog.
 *
 * Capabilities are knowledge-driven (knowledge/public/orchestration/provider-capabilities.json)
 * rather than hardcoded, so they can evolve — by hand or by dynamic probing — without code
 * changes. FALLBACK_CATALOG below is the conservative built-in baseline used only when the
 * knowledge file is missing or malformed, so discovery still works offline.
 */
export interface ProviderCapabilityEntry {
  models: string[];
  capabilities: string[];
  modelCapabilities: Record<string, string[]>;
  /** Optional per-entry provenance, stamped when a probe writes this entry. */
  provenance?: Record<string, unknown>;
}

interface ProviderCapabilityCatalog {
  version?: string;
  provenance?: Record<string, unknown>;
  providers: Record<string, ProviderCapabilityEntry>;
}

const CAPABILITY_CATALOG_PATH = 'knowledge/public/orchestration/provider-capabilities.json';

const FALLBACK_CATALOG: Record<string, ProviderCapabilityEntry> = {
  gemini: {
    models: [
      'auto-gemini-3', 'auto-gemini-2.5',
      'gemini-3.1-pro-preview', 'gemini-3-flash-preview',
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    ],
    capabilities: [
      'reasoning', 'planning', 'coordination', 'analysis', 'code', 'review',
      'architecture', 'a2a', 'structured_json', 'surface', 'conversation',
      'realtime', 'low_latency', 'routing', 'delegation', 'dashboard', 'a2ui',
    ],
    modelCapabilities: {
      'auto-gemini-3': ['reasoning', 'planning', 'coordination', 'analysis', 'structured_json', 'code', 'review', 'architecture', 'a2a'],
      'auto-gemini-2.5': ['reasoning', 'planning', 'coordination', 'analysis', 'structured_json', 'low_latency', 'code', 'review', 'architecture', 'a2a'],
      'gemini-3.1-pro-preview': ['reasoning', 'planning', 'analysis', 'structured_json', 'long_context', 'code', 'review', 'architecture'],
      'gemini-3-flash-preview': ['low_latency', 'conversation', 'structured_json', 'surface'],
      'gemini-2.5-pro': ['reasoning', 'planning', 'analysis', 'structured_json', 'long_context', 'a2a', 'code', 'review', 'architecture'],
      'gemini-2.5-flash': ['structured_json', 'surface', 'conversation', 'realtime', 'low_latency', 'routing', 'delegation', 'dashboard', 'a2ui', 'slack', 'presence', 'onboarding', 'gateway'],
      'gemini-2.5-flash-lite': ['structured_json', 'conversation', 'low_latency', 'surface', 'slack'],
    },
  },
  claude: {
    models: [
      'sonnet', 'opus', 'haiku',
      'claude-sonnet-4-6', 'claude-opus-4-6',
      'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001',
    ],
    capabilities: ['reasoning', 'planning', 'coordination', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
    modelCapabilities: {
      sonnet: ['reasoning', 'planning', 'coordination', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
      opus: ['reasoning', 'planning', 'coordination', 'analysis', 'review', 'code', 'long_context', 'structured_json', 'deep_reasoning'],
      haiku: ['conversation', 'summarization', 'low_latency', 'structured_json'],
      'claude-sonnet-4-6': ['reasoning', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
      'claude-opus-4-6': ['reasoning', 'analysis', 'review', 'code', 'long_context', 'structured_json', 'deep_reasoning'],
      'claude-sonnet-4-20250514': ['reasoning', 'analysis', 'review', 'code', 'long_context', 'structured_json'],
      'claude-haiku-4-5-20251001': ['conversation', 'summarization', 'low_latency', 'structured_json'],
    },
  },
  copilot: {
    models: [
      'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-sonnet-4',
      'claude-opus-4.6', 'claude-opus-4.6-fast', 'claude-opus-4.5',
      'claude-haiku-4.5', 'gemini-3-pro-preview', 'gpt-5.4', 'gpt-5.3-codex',
    ],
    capabilities: ['code', 'implementation', 'refactoring', 'review', 'reasoning', 'structured_json'],
    modelCapabilities: {
      'claude-sonnet-4.6': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-sonnet-4.5': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-sonnet-4': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-opus-4.6': ['reasoning', 'analysis', 'review', 'code', 'structured_json', 'deep_reasoning'],
      'claude-opus-4.6-fast': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-opus-4.5': ['reasoning', 'analysis', 'review', 'code', 'structured_json'],
      'claude-haiku-4.5': ['conversation', 'summarization', 'low_latency', 'structured_json'],
      'gemini-3-pro-preview': ['reasoning', 'planning', 'analysis', 'structured_json'],
      'gpt-5.4': ['code', 'implementation', 'refactoring', 'review', 'reasoning', 'structured_json'],
      'gpt-5.3-codex': ['code', 'implementation', 'refactoring', 'review', 'reasoning', 'structured_json'],
    },
  },
  codex: {
    models: ['codex'],
    capabilities: ['code', 'implementation', 'refactoring', 'patch', 'terminal', 'debugging', 'structured_json'],
    modelCapabilities: {
      codex: ['code', 'implementation', 'refactoring', 'patch', 'terminal', 'debugging', 'structured_json'],
    },
  },
  agy: {
    models: ['agy'],
    capabilities: ['reasoning', 'planning', 'coordination', 'analysis', 'code', 'review', 'architecture', 'structured_json'],
    modelCapabilities: {
      agy: ['reasoning', 'planning', 'coordination', 'analysis', 'code', 'review', 'architecture', 'structured_json'],
    },
  },
};

let catalogCache: Record<string, ProviderCapabilityEntry> | null = null;

function isCapabilityEntry(value: unknown): value is ProviderCapabilityEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return Array.isArray(entry.models)
    && Array.isArray(entry.capabilities)
    && typeof entry.modelCapabilities === 'object' && entry.modelCapabilities !== null;
}

/**
 * Load the provider capability catalog from knowledge, merged over the built-in fallback.
 * Invalid or missing entries silently fall back so discovery never hard-fails on a bad edit.
 */
export function loadProviderCapabilityCatalog(forceRefresh = false): Record<string, ProviderCapabilityEntry> {
  if (!forceRefresh && catalogCache) return catalogCache;
  const merged: Record<string, ProviderCapabilityEntry> = { ...FALLBACK_CATALOG };
  try {
    const raw = safeReadFile(pathResolver.rootResolve(CAPABILITY_CATALOG_PATH), { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as ProviderCapabilityCatalog;
    if (parsed && parsed.providers && typeof parsed.providers === 'object') {
      for (const [provider, entry] of Object.entries(parsed.providers)) {
        if (isCapabilityEntry(entry)) {
          merged[provider] = entry;
        } else {
          logger.warn(`[PROVIDER_DISCOVERY] capability entry for '${provider}' is malformed — keeping built-in baseline`);
        }
      }
    } else {
      logger.warn('[PROVIDER_DISCOVERY] provider-capabilities.json missing `providers` map — using built-in baseline');
    }
  } catch {
    logger.info('[PROVIDER_DISCOVERY] provider-capabilities.json unavailable — using built-in capability baseline');
  }
  catalogCache = merged;
  return merged;
}

function capabilityEntryFor(provider: string): ProviderCapabilityEntry {
  return loadProviderCapabilityCatalog()[provider]
    || FALLBACK_CATALOG[provider]
    || { models: [], capabilities: [], modelCapabilities: {} };
}

export interface ProbedProviderCapabilities {
  models?: string[];
  capabilities?: string[];
  modelCapabilities?: Record<string, string[]>;
}

function unionArrays(existing: string[] = [], incoming: string[] = []): string[] {
  return Array.from(new Set([...existing, ...incoming]));
}

/**
 * Merge probe-detected capabilities back into the knowledge catalog (the probe -> knowledge loop).
 *
 * Union by default: never destroys manually-curated models/capabilities — a probe can only ADD.
 * Use `mode: 'replace'` to overwrite a provider's entry wholesale. Top-level provenance is stamped
 * so it is auditable who/what last wrote the catalog, and each touched provider gets a per-entry
 * provenance note. Returns the catalog that was written.
 *
 * This is the reusable primitive a CLI-prober (e.g. `agy plugin list`) calls when it detects a new
 * model or plugin: the capability becomes selectable by the broker immediately, no code change.
 */
export function mergeProbedCapabilitiesIntoCatalog(
  probed: Record<string, ProbedProviderCapabilities>,
  opts: { updatedBy?: string; note?: string; mode?: 'union' | 'replace'; timestamp?: string } = {},
): ProviderCapabilityCatalog {
  const mode = opts.mode || 'union';
  const timestamp = opts.timestamp || new Date().toISOString();
  const updatedBy = opts.updatedBy || 'probe';

  // Read the raw on-disk catalog (NOT merged with fallback) so we preserve its exact structure.
  let catalog: ProviderCapabilityCatalog = { version: '1.0', providers: {} };
  try {
    const raw = safeReadFile(pathResolver.rootResolve(CAPABILITY_CATALOG_PATH), { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as ProviderCapabilityCatalog;
    if (parsed && parsed.providers && typeof parsed.providers === 'object') catalog = parsed;
  } catch { /* start from an empty catalog */ }

  for (const [provider, entry] of Object.entries(probed)) {
    const current = catalog.providers[provider];
    if (!current || mode === 'replace') {
      catalog.providers[provider] = {
        models: entry.models || [],
        capabilities: entry.capabilities || [],
        modelCapabilities: entry.modelCapabilities || {},
      };
    } else {
      const mergedModelCaps: Record<string, string[]> = { ...current.modelCapabilities };
      for (const [model, caps] of Object.entries(entry.modelCapabilities || {})) {
        mergedModelCaps[model] = unionArrays(mergedModelCaps[model], caps);
      }
      catalog.providers[provider] = {
        models: unionArrays(current.models, entry.models),
        capabilities: unionArrays(current.capabilities, entry.capabilities),
        modelCapabilities: mergedModelCaps,
      };
    }
    catalog.providers[provider]!.provenance = { source: 'probe', updated_by: updatedBy, updated_at: timestamp };
  }

  catalog.version = catalog.version || '1.0';
  catalog.provenance = {
    ...(catalog.provenance || {}),
    source: 'probe',
    updated_by: updatedBy,
    updated_at: timestamp,
    ...(opts.note ? { note: opts.note } : {}),
  };

  const filePath = pathResolver.rootResolve(CAPABILITY_CATALOG_PATH);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(catalog, null, 2), { encoding: 'utf8' });

  // Invalidate caches so the next discovery reflects the freshly-written catalog.
  catalogCache = null;
  cachedProviders = null;
  cacheTimestamp = 0;

  logger.info(`[PROVIDER_DISCOVERY] Merged probe results into ${CAPABILITY_CATALOG_PATH} for: ${Object.keys(probed).join(', ')}`);
  return catalog;
}

function run(cmd: string, args: string[], timeoutMs = 10000): { ok: boolean; stdout: string } {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: process.env,
      shell: false,
    });
    return { ok: res.status === 0, stdout: (res.stdout || '').trim() };
  } catch (_) {
    return { ok: false, stdout: '' };
  }
}

function checkGemini(): ProviderInfo {
  const which = run('which', ['gemini']);
  if (!which.ok) return { provider: 'gemini', installed: false, version: null, protocol: 'acp', models: [], healthy: false };

  const ver = run('gemini', ['--version']);
  const entry = capabilityEntryFor('gemini');
  return {
    provider: 'gemini',
    installed: true,
    version: ver.stdout || null,
    protocol: 'acp',
    models: entry.models,
    capabilities: entry.capabilities,
    modelCapabilities: entry.modelCapabilities,
    healthy: true,
  };
}

function checkClaude(): ProviderInfo {
  const which = run('which', ['claude']);
  if (!which.ok) return { provider: 'claude', installed: false, version: null, protocol: 'print-json', models: [], healthy: false };

  // Use --version only — probeShellClaudeCliAvailability() makes a live LLM call
  // which is too expensive for discovery. Credential validity is checked at use-time.
  const ver = run('claude', ['--version']);
  const entry = capabilityEntryFor('claude');
  return {
    provider: 'claude',
    installed: true,
    version: ver.ok ? (ver.stdout || null) : null,
    protocol: 'print-json',
    models: entry.models,
    capabilities: entry.capabilities,
    modelCapabilities: entry.modelCapabilities,
    healthy: ver.ok,
  };
}

function checkCopilot(): ProviderInfo {
  // Check if gh copilot is available (--help is more reliable than --version)
  const help = run('gh', ['copilot', '--', '--help'], 15000);
  if (!help.ok) return { provider: 'copilot', installed: false, version: null, protocol: 'acp', models: [], healthy: false };

  const entry = capabilityEntryFor('copilot');
  return {
    provider: 'copilot',
    installed: true,
    version: 'available',
    protocol: 'acp',
    models: entry.models,
    capabilities: entry.capabilities,
    modelCapabilities: entry.modelCapabilities,
    healthy: true,
  };
}

function checkCodex(): ProviderInfo {
  const which = run('which', ['codex']);
  const installed = which.ok;
  const mode = (process.env.KYBERION_CODEX_MODE || 'app-server').toLowerCase();
  const protocol: ProviderInfo['protocol'] = (mode === 'exec' || mode === 'legacy') ? 'exec' : 'json-rpc';
  const entry = capabilityEntryFor('codex');

  return {
    provider: 'codex',
    installed,
    version: null,
    protocol,
    models: entry.models,
    capabilities: entry.capabilities,
    modelCapabilities: entry.modelCapabilities,
    healthy: installed,
  };
}

function checkAgy(): ProviderInfo {
  const which = run('which', ['agy']);
  if (!which.ok) return { provider: 'agy', installed: false, version: null, protocol: 'print-json', models: [], healthy: false };

  const entry = capabilityEntryFor('agy');
  return {
    provider: 'agy',
    installed: true,
    version: 'available',
    protocol: 'print-json',
    models: entry.models,
    capabilities: entry.capabilities,
    modelCapabilities: entry.modelCapabilities,
    healthy: true,
  };
}

/**
 * Discover all available providers. Cached for 5 minutes.
 */
export function discoverProviders(forceRefresh = false): ProviderInfo[] {
  // 1. In-memory cache
  if (!forceRefresh && cachedProviders && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedProviders;
  }

  // 2. Disk cache (survives process restarts — avoids re-probing on every pipeline run)
  if (!forceRefresh) {
    const disk = readDiskCache();
    if (disk) {
      cachedProviders = disk;
      cacheTimestamp = Date.now();
      logger.info(`[PROVIDER_DISCOVERY] Loaded from cache: ${disk.filter(p => p.installed).map(p => p.provider).join(', ')}`);
      return disk;
    }
  }

  // 3. Full discovery
  logger.info('[PROVIDER_DISCOVERY] Scanning available providers...');
  const providers = [
    checkGemini(),
    checkClaude(),
    checkCopilot(),
    checkCodex(),
    checkAgy(),
  ];

  const available = providers.filter(p => p.installed);
  logger.info(`[PROVIDER_DISCOVERY] Found ${available.length}/${providers.length}: ${available.map(p => p.provider).join(', ')}`);

  cachedProviders = providers;
  cacheTimestamp = Date.now();
  writeDiskCache(providers);
  return providers;
}

export function refreshProviderDiscoveryCache(): ProviderInfo[] {
  return discoverProviders(true);
}

export function clearProviderDiscoveryCache(): void {
  cachedProviders = null;
  cacheTimestamp = 0;
  catalogCache = null;
  try { safeUnlinkSync(DISK_CACHE_PATH); } catch { /* non-fatal */ }
}

/**
 * Get only installed providers.
 */
export function getAvailableProviders(): ProviderInfo[] {
  return discoverProviders().filter(p => p.installed);
}
