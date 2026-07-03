/* eslint-disable no-restricted-imports -- IP-08 で safeExec へ移行予定 (docs/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { logger } from './core.js';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
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
  } catch {
    /* cache miss — non-fatal */
  }
  return null;
}

function writeDiskCache(providers: ProviderInfo[]): void {
  try {
    const dir = path.dirname(DISK_CACHE_PATH);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    safeWriteFile(DISK_CACHE_PATH, JSON.stringify({ ts: Date.now(), providers }), {
      encoding: 'utf8',
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Provider/model capability catalog.
 *
 * Capabilities are knowledge-driven (knowledge/product/orchestration/provider-capabilities.json)
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

const CAPABILITY_CATALOG_PATH = 'knowledge/product/orchestration/provider-capabilities.json';
const FALLBACK_CAPABILITY_CATALOG_PATH =
  'knowledge/product/orchestration/provider-capabilities.fallback.json';

let catalogCache: Record<string, ProviderCapabilityEntry> | null = null;

function isCapabilityEntry(value: unknown): value is ProviderCapabilityEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    Array.isArray(entry.models) &&
    Array.isArray(entry.capabilities) &&
    typeof entry.modelCapabilities === 'object' &&
    entry.modelCapabilities !== null
  );
}

function readCapabilityCatalog(filePath: string): ProviderCapabilityCatalog | null {
  try {
    const raw = safeReadFile(pathResolver.rootResolve(filePath), { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as ProviderCapabilityCatalog;
    if (parsed && parsed.providers && typeof parsed.providers === 'object') return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function mergeCatalogInto(
  target: Record<string, ProviderCapabilityEntry>,
  source: ProviderCapabilityCatalog | null,
  fallbackLabel: string
): void {
  if (!source?.providers || typeof source.providers !== 'object') return;
  for (const [provider, entry] of Object.entries(source.providers)) {
    if (isCapabilityEntry(entry)) {
      target[provider] = entry;
    } else {
      logger.warn(
        `[PROVIDER_DISCOVERY] capability entry for '${provider}' is malformed in ${fallbackLabel}`
      );
    }
  }
}

/**
 * Load the provider capability catalog from knowledge, merged over the built-in fallback.
 * Invalid or missing entries silently fall back so discovery never hard-fails on a bad edit.
 */
export function loadProviderCapabilityCatalog(
  forceRefresh = false
): Record<string, ProviderCapabilityEntry> {
  if (!forceRefresh && catalogCache) return catalogCache;
  const merged: Record<string, ProviderCapabilityEntry> = {};
  mergeCatalogInto(
    merged,
    readCapabilityCatalog(FALLBACK_CAPABILITY_CATALOG_PATH),
    FALLBACK_CAPABILITY_CATALOG_PATH
  );

  const primary = readCapabilityCatalog(CAPABILITY_CATALOG_PATH);
  if (primary) {
    mergeCatalogInto(merged, primary, CAPABILITY_CATALOG_PATH);
  } else {
    logger.info(
      '[PROVIDER_DISCOVERY] provider-capabilities.json unavailable — using built-in capability fallback catalog'
    );
  }
  catalogCache = merged;
  return merged;
}

function capabilityEntryFor(provider: string): ProviderCapabilityEntry {
  return (
    loadProviderCapabilityCatalog()[provider] || {
      models: [],
      capabilities: [],
      modelCapabilities: {},
    }
  );
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
  opts: { updatedBy?: string; note?: string; mode?: 'union' | 'replace'; timestamp?: string } = {}
): ProviderCapabilityCatalog {
  const mode = opts.mode || 'union';
  const timestamp = opts.timestamp || new Date().toISOString();
  const updatedBy = opts.updatedBy || 'probe';

  // Read the raw on-disk catalog (NOT merged with fallback) so we preserve its exact structure.
  let catalog: ProviderCapabilityCatalog = { version: '1.0', providers: {} };
  try {
    const raw = safeReadFile(pathResolver.rootResolve(CAPABILITY_CATALOG_PATH), {
      encoding: 'utf8',
    }) as string;
    const parsed = JSON.parse(raw) as ProviderCapabilityCatalog;
    if (parsed && parsed.providers && typeof parsed.providers === 'object') catalog = parsed;
  } catch {
    /* start from an empty catalog */
  }

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
    catalog.providers[provider]!.provenance = {
      source: 'probe',
      updated_by: updatedBy,
      updated_at: timestamp,
    };
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

  logger.info(
    `[PROVIDER_DISCOVERY] Merged probe results into ${CAPABILITY_CATALOG_PATH} for: ${Object.keys(probed).join(', ')}`
  );
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
  if (!which.ok)
    return {
      provider: 'gemini',
      installed: false,
      version: null,
      protocol: 'acp',
      models: [],
      healthy: false,
    };

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
  if (!which.ok)
    return {
      provider: 'claude',
      installed: false,
      version: null,
      protocol: 'print-json',
      models: [],
      healthy: false,
    };

  // Use --version only — probeShellClaudeCliAvailability() makes a live LLM call
  // which is too expensive for discovery. Credential validity is checked at use-time.
  const ver = run('claude', ['--version']);
  const entry = capabilityEntryFor('claude');
  return {
    provider: 'claude',
    installed: true,
    version: ver.ok ? ver.stdout || null : null,
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
  if (!help.ok)
    return {
      provider: 'copilot',
      installed: false,
      version: null,
      protocol: 'acp',
      models: [],
      healthy: false,
    };

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
  const protocol: ProviderInfo['protocol'] =
    mode === 'exec' || mode === 'legacy' ? 'exec' : 'json-rpc';
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
  if (!which.ok)
    return {
      provider: 'agy',
      installed: false,
      version: null,
      protocol: 'print-json',
      models: [],
      healthy: false,
    };

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
  if (!forceRefresh && cachedProviders && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedProviders;
  }

  // 2. Disk cache (survives process restarts — avoids re-probing on every pipeline run)
  if (!forceRefresh) {
    const disk = readDiskCache();
    if (disk) {
      cachedProviders = disk;
      cacheTimestamp = Date.now();
      logger.info(
        `[PROVIDER_DISCOVERY] Loaded from cache: ${disk
          .filter((p) => p.installed)
          .map((p) => p.provider)
          .join(', ')}`
      );
      return disk;
    }
  }

  // 3. Full discovery
  logger.info('[PROVIDER_DISCOVERY] Scanning available providers...');
  const providers = [checkGemini(), checkClaude(), checkCopilot(), checkCodex(), checkAgy()];

  const available = providers.filter((p) => p.installed);
  logger.info(
    `[PROVIDER_DISCOVERY] Found ${available.length}/${providers.length}: ${available.map((p) => p.provider).join(', ')}`
  );

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
  try {
    safeUnlinkSync(DISK_CACHE_PATH);
  } catch {
    /* non-fatal */
  }
}

/**
 * Get only installed providers.
 */
export function getAvailableProviders(): ProviderInfo[] {
  return discoverProviders().filter((p) => p.installed);
}
