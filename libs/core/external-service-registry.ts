/**
 * External Service Registry
 *
 * Manages the lifecycle of user-onboarded external data sources.
 * When a user provides a URL for an unknown topic (e.g., weather data),
 * it is registered here so future requests can auto-resolve the source.
 *
 * Storage:
 *   Seed (read-only): knowledge/public/orchestration/external-service-registry.json
 *   Runtime (mutable): active/shared/runtime/external-service-registry.json
 */

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExternalServiceEntry {
  service_id: string;
  topic: string;
  url: string;
  registered_at: string;
  last_success_at?: string;
  success_count: number;
  failure_count: number;
}

interface ExternalServiceRegistry {
  version: string;
  services: ExternalServiceEntry[];
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Org-wide defaults (Kyberion-managed, read-only). */
const PUBLIC_SEED_PATH = pathResolver.knowledge('public/orchestration/external-service-registry.json');

/**
 * Personal overrides (user-managed, read-only at runtime).
 * Place entries here to persist preferred sources across sessions without
 * touching public knowledge. File need not exist.
 */
const PERSONAL_SEED_PATH = pathResolver.knowledge('personal/orchestration/external-service-registry.json');

/**
 * Runtime store (auto-accumulated as new services are registered via chat).
 * Highest priority — overrides both seed layers.
 */
const RUNTIME_PATH = pathResolver.shared('runtime/external-service-registry.json');

// ─── Internal Helpers ───────────────────────────────────────────────────────

function parseRegistry(filePath: string): ExternalServiceRegistry | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ExternalServiceRegistry;
  } catch {
    return null;
  }
}

/**
 * 3-tier merge: public seed → personal override → runtime.
 * Later tiers win on same service_id. Priority: runtime > personal > public.
 */
function loadMerged(): ExternalServiceRegistry {
  const fallback: ExternalServiceRegistry = { version: '1.0.0', services: [] };
  const publicSeed  = parseRegistry(PUBLIC_SEED_PATH)  ?? fallback;
  const personalSeed = parseRegistry(PERSONAL_SEED_PATH) ?? fallback;
  const runtime     = parseRegistry(RUNTIME_PATH)      ?? fallback;

  const byId = new Map<string, ExternalServiceEntry>();
  // Apply in ascending priority order (later writes win)
  for (const entry of publicSeed.services)  byId.set(entry.service_id, entry);
  for (const entry of personalSeed.services) byId.set(entry.service_id, entry);
  for (const entry of runtime.services)     byId.set(entry.service_id, entry);

  return {
    version: runtime.version || personalSeed.version || publicSeed.version || '1.0.0',
    services: Array.from(byId.values()),
  };
}

function saveRuntime(registry: ExternalServiceRegistry): void {
  safeWriteFile(RUNTIME_PATH, JSON.stringify(registry, null, 2), { mkdir: true });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Look up a registered service by topic string.
 * Normalizes the topic before comparison (trim + lowercase).
 */
export function findServiceByTopic(topic: string): ExternalServiceEntry | undefined {
  const normalized = topic.trim().toLowerCase();
  const registry = loadMerged();
  return registry.services.find((entry) => {
    const entryTopic = entry.topic.trim().toLowerCase();
    // Exact match or one contains the other
    return entryTopic === normalized ||
      entryTopic.includes(normalized) ||
      normalized.includes(entryTopic);
  });
}

/**
 * Look up a registered service by its ID.
 */
export function findServiceById(serviceId: string): ExternalServiceEntry | undefined {
  return loadMerged().services.find((e) => e.service_id === serviceId);
}

/**
 * Register a new external service. If an entry with the same service_id already
 * exists in the runtime registry, it will be overwritten.
 */
export function registerService(params: {
  service_id: string;
  topic: string;
  url: string;
}): ExternalServiceEntry {
  const runtime = parseRegistry(RUNTIME_PATH) ?? { version: '1.0.0', services: [] };
  const now = new Date().toISOString();

  const entry: ExternalServiceEntry = {
    service_id: params.service_id,
    topic: params.topic,
    url: params.url,
    registered_at: now,
    success_count: 0,
    failure_count: 0,
  };

  const idx = runtime.services.findIndex((e) => e.service_id === params.service_id);
  if (idx >= 0) {
    runtime.services[idx] = { ...runtime.services[idx], ...entry };
  } else {
    runtime.services.push(entry);
  }

  saveRuntime(runtime);
  return entry;
}

/**
 * Update success/failure stats for a registered service.
 */
export function updateServiceStats(serviceId: string, success: boolean): void {
  const runtime = parseRegistry(RUNTIME_PATH) ?? { version: '1.0.0', services: [] };
  const idx = runtime.services.findIndex((e) => e.service_id === serviceId);

  if (idx < 0) {
    // Service not in runtime yet — load from seed and promote
    const merged = loadMerged();
    const entry = merged.services.find((e) => e.service_id === serviceId);
    if (!entry) return;
    runtime.services.push({
      ...entry,
      success_count: success ? 1 : 0,
      failure_count: success ? 0 : 1,
      ...(success ? { last_success_at: new Date().toISOString() } : {}),
    });
  } else {
    const prev = runtime.services[idx];
    runtime.services[idx] = {
      ...prev,
      success_count: prev.success_count + (success ? 1 : 0),
      failure_count: prev.failure_count + (success ? 0 : 1),
      ...(success ? { last_success_at: new Date().toISOString() } : {}),
    };
  }

  saveRuntime(runtime);
}

/**
 * Remove a service from the runtime registry by ID.
 */
export function deregisterService(serviceId: string): boolean {
  const runtime = parseRegistry(RUNTIME_PATH) ?? { version: '1.0.0', services: [] };
  const before = runtime.services.length;
  runtime.services = runtime.services.filter((e) => e.service_id !== serviceId);
  if (runtime.services.length < before) {
    saveRuntime(runtime);
    return true;
  }
  return false;
}

/**
 * List all registered services (merged seed + runtime).
 */
export function listServices(): ExternalServiceEntry[] {
  return loadMerged().services;
}

/**
 * Convert an arbitrary topic string to a slug suitable for use as service_id.
 */
export function topicToServiceId(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'external-service';
}

// ─── Provider Catalog ────────────────────────────────────────────────────────

interface ServiceProvider {
  id: string;
  aliases: string[];
  topics: string[];
  url_template: string;
  notes?: string;
}

interface ServiceProviderCatalog {
  version: string;
  providers: ServiceProvider[];
}

const PUBLIC_PROVIDER_CATALOG_PATH = pathResolver.knowledge('public/orchestration/service-provider-catalog.json');
const PERSONAL_PROVIDER_CATALOG_PATH = pathResolver.knowledge('personal/orchestration/service-provider-catalog.json');

function loadProviderCatalog(): ServiceProvider[] {
  const load = (p: string): ServiceProvider[] => {
    if (!safeExistsSync(p)) return [];
    try {
      const parsed = JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string) as ServiceProviderCatalog;
      return parsed.providers || [];
    } catch {
      return [];
    }
  };

  const publicProviders = load(PUBLIC_PROVIDER_CATALOG_PATH);
  const personalProviders = load(PERSONAL_PROVIDER_CATALOG_PATH);

  // Personal overrides public by id
  const byId = new Map<string, ServiceProvider>();
  for (const p of publicProviders) byId.set(p.id, p);
  for (const p of personalProviders) byId.set(p.id, p);
  return Array.from(byId.values());
}

function fillUrlTemplate(template: string, topic: string, location: string): string {
  const query = [topic, location].filter(Boolean).join(' ');
  const encodedTopic = encodeURIComponent(topic);
  const encodedLocation = encodeURIComponent(location);
  const encodedQuery = encodeURIComponent(query);
  // location fallback: use topic as location for services like wttr.in
  const effectiveLocation = location || topic;
  const encodedEffectiveLocation = encodeURIComponent(effectiveLocation);

  return template
    .replace(/\{query\}/g, encodedQuery)
    .replace(/\{topic\}/g, encodedTopic)
    .replace(/\{location\}/g, encodedEffectiveLocation)
    .replace(/\{location_raw\}/g, effectiveLocation);
}

/**
 * Resolve a human-readable provider name (e.g. "Yahoo Japan", "ヤフー") to a URL.
 * Returns undefined if no matching provider is found.
 *
 * @param providerName  - e.g. "Yahoo Japan" extracted from utterance
 * @param topic         - data topic, e.g. "天気"
 * @param location      - location, e.g. "秋葉原"
 */
export function resolveProviderUrl(
  providerName: string,
  topic: string,
  location: string,
): { url: string; providerId: string } | undefined {
  const normalizedName = providerName.trim().toLowerCase();
  const normalizedTopic = topic.trim().toLowerCase();
  const providers = loadProviderCatalog();

  const matched = providers.find((provider) => {
    const aliasMatch = provider.aliases.some(
      (alias) => alias.toLowerCase() === normalizedName || normalizedName.includes(alias.toLowerCase())
    );
    if (!aliasMatch) return false;

    // Check topic compatibility
    if (provider.topics.includes('*')) return true;
    return provider.topics.some((t) => t.toLowerCase() === normalizedTopic || normalizedTopic.includes(t.toLowerCase()));
  });

  if (!matched) return undefined;

  return {
    url: fillUrlTemplate(matched.url_template, topic, location),
    providerId: matched.id,
  };
}

/**
 * Extract a provider name from an utterance.
 * Looks for patterns like "XxxJapanで", "Xxxを使って", "Xxxから" before the topic.
 * Returns undefined if no known provider is found.
 */
export function extractProviderFromUtterance(
  utterance: string,
): string | undefined {
  const providers = loadProviderCatalog();

  // Try to match each provider alias against the utterance
  for (const provider of providers) {
    for (const alias of provider.aliases) {
      // Case-insensitive search for the alias anywhere in the utterance
      if (utterance.toLowerCase().includes(alias.toLowerCase())) {
        return alias;
      }
    }
  }
  return undefined;
}

