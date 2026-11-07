/**
 * Model cost registry — pricing data resolution for metrics accounting.
 * Model pricing is data, not code: it lives in a knowledge-tier registry so
 * models can be added / repriced without a source change or redeploy.
 */
import { defineCatalog } from '../foundation/governed-catalog.js';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync } from '../secure-io.js';

export interface CostRate {
  prompt: number;
  completion: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
}
export interface CostTier extends CostRate {
  /** Inclusive input-token threshold for this rate, stored per 1k tokens. */
  input_tokens_above: number;
}
export interface ModelCostEntry extends CostRate {
  tiers?: CostTier[];
}
export interface ModelCostRegistry {
  models: Record<string, ModelCostEntry>;
  aliases?: Record<string, string>;
  default: ModelCostEntry;
}

interface ModelCostRegistryFile extends ModelCostRegistry {
  version: string;
  currency: string;
  unit: string;
  note?: string;
}

// Model pricing is data, not code: it lives in a knowledge-tier registry so models
// can be added / repriced without a source change or redeploy. The file is the
// source of truth; an empty zero-rate registry keeps observability available when
// the primary registry is missing or malformed without maintaining a second copy
// of governance data. All rates are per-1k tokens.
const COST_REGISTRY_PATH = pathResolver.resolve(
  'knowledge/product/governance/model-cost-registry.json'
);
const COST_REGISTRY_SCHEMA_PATH = pathResolver.resolve(
  'knowledge/product/schemas/model-cost-registry.schema.json'
);
const EMPTY_COST_REGISTRY: ModelCostRegistry = {
  models: {},
  aliases: {},
  default: { prompt: 0, completion: 0 },
};

let _cachedCostRegistry: ModelCostRegistry | null = null;

const primaryCostRegistryCatalog = defineCatalog<ModelCostRegistryFile>({
  id: 'model-cost-registry',
  path: COST_REGISTRY_PATH,
  schema: COST_REGISTRY_SCHEMA_PATH,
});

function readCostRegistry(): ModelCostRegistry | null {
  try {
    if (!safeExistsSync(COST_REGISTRY_PATH)) return null;
    const parsed = primaryCostRegistryCatalog.load();
    return { models: parsed.models, aliases: parsed.aliases ?? {}, default: parsed.default };
  } catch {
    /* ignore */
  }
  return null;
}

/** Load (and cache) the single model-cost registry from the knowledge tier. */
export function loadModelCostRegistry(): ModelCostRegistry {
  if (_cachedCostRegistry) return _cachedCostRegistry;
  const primary = readCostRegistry();
  if (primary) {
    _cachedCostRegistry = {
      models: {
        ...(primary?.models ?? {}),
      },
      aliases: {
        ...(primary?.aliases ?? {}),
      },
      default: primary.default,
    };
    return _cachedCostRegistry;
  }
  _cachedCostRegistry = EMPTY_COST_REGISTRY;
  return _cachedCostRegistry;
}

/** Test/hot-reload hook: drop the cached registry so the next call re-reads the file. */
export function _resetModelCostRegistryCacheForTests(): void {
  _cachedCostRegistry = null;
  primaryCostRegistryCatalog.reset();
}

function selectTier(entry: ModelCostEntry, inputTokens: number): CostRate {
  if (!entry.tiers?.length) return entry;
  const threshold = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  return (
    [...entry.tiers]
      .filter((tier) => tier.input_tokens_above <= threshold)
      .sort((left, right) => right.input_tokens_above - left.input_tokens_above)[0] ?? entry
  );
}

/**
 * Compare model ids by their alphanumeric skeleton.
 *
 * Providers report display names ("Gemini 3.6 Flash (Medium)", "Claude Opus
 * 5") while the registry is keyed by model ids ("gemini-3.6-flash"). A plain
 * substring match never connects the two, so every such actor silently
 * resolved to the default rate. Stripping separators makes
 * "gemini36flashmedium" contain "gemini36flash" without loosening what counts
 * as a match: candidates are still tried longest-first, so a more specific id
 * (gpt-4o-mini) still wins over a shorter one it contains (gpt-4o).
 */
function costModelSkeleton(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolvePer1kRate(reg: ModelCostRegistry, model: string, inputTokens: number): CostRate {
  const id = (model || '').trim();
  if (!id) return selectTier(reg.default, inputTokens);
  if (reg.models[id]) return selectTier(reg.models[id], inputTokens);
  if (reg.aliases?.[id] && reg.models[reg.aliases[id]])
    return selectTier(reg.models[reg.aliases[id]], inputTokens);
  // Versioned ids and provider display names never exact-match; take the
  // longest model-id or alias contained in the given id.
  const skeleton = costModelSkeleton(id);
  const candidates = [...Object.keys(reg.models), ...Object.keys(reg.aliases ?? {})].sort(
    (a, b) => b.length - a.length
  );
  for (const key of candidates) {
    if (skeleton.includes(costModelSkeleton(key))) {
      const target = reg.models[key] ? key : reg.aliases?.[key];
      if (target && reg.models[target]) return selectTier(reg.models[target], inputTokens);
    }
  }
  return selectTier(reg.default, inputTokens);
}

/**
 * Which registry entry a model id resolved to, or `null` when nothing matched
 * and the registry default was used.
 *
 * `resolveCostRates` silently falls back to the default rate, which is right
 * for best-effort usage accounting but misleading anywhere the rate is
 * presented as *this actor's* price: a display name such as
 * "Gemini 3.6 Flash (Medium)" matches no registry key and would be reported
 * at the default rate as if it were measured. Callers that persist a price
 * record which one they got.
 */
export function resolveCostRateModelKey(
  model: string,
  reg = loadModelCostRegistry()
): string | null {
  const id = (model || '').trim();
  if (!id) return null;
  if (reg.models[id]) return id;
  if (reg.aliases?.[id] && reg.models[reg.aliases[id]]) return reg.aliases[id];
  const skeleton = costModelSkeleton(id);
  const candidates = [...Object.keys(reg.models), ...Object.keys(reg.aliases ?? {})].sort(
    (a, b) => b.length - a.length
  );
  for (const key of candidates) {
    if (skeleton.includes(costModelSkeleton(key))) {
      const target = reg.models[key] ? key : reg.aliases?.[key];
      if (target && reg.models[target]) return target;
    }
  }
  return null;
}

/**
 * Resolve per-TOKEN rates for a model id from the knowledge-tier cost registry.
 * Registry stores per-1k rates; returned rates are per-token (÷1000) for direct
 * multiplication by token counts in `record()`.
 */
export function resolveCostRatesFromRegistry(
  registry: ModelCostRegistry,
  model: string,
  inputTokens = 0
): CostRate {
  const perK = resolvePer1kRate(registry, model, inputTokens);
  return {
    prompt: perK.prompt / 1000,
    completion: perK.completion / 1000,
    ...(perK.cache_read === undefined ? {} : { cache_read: perK.cache_read / 1000 }),
    ...(perK.cache_write === undefined ? {} : { cache_write: perK.cache_write / 1000 }),
    ...(perK.cache_write_1h === undefined ? {} : { cache_write_1h: perK.cache_write_1h / 1000 }),
  };
}

export function resolveCostRates(model: string, inputTokens = 0): CostRate {
  return resolveCostRatesFromRegistry(loadModelCostRegistry(), model, inputTokens);
}
