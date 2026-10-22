import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';

export const ROUTING_OPTIMIZE_FOR_ENV = 'KYBERION_ROUTING_OPTIMIZE_FOR';

export type RoutingOptimizeMode = 'cost' | 'balance' | 'intelligence';

export type RoutingFanoutPolicy =
  'never' | 'explicit_only' | 'explicit_or_uncertain' | 'explicit_or_heavy';

export interface CognitiveRoutingPaletteMode {
  heavy_marker_min: number;
  heavy_risk_threshold: number;
  heavy_uncertainty_threshold: number;
  fanout: RoutingFanoutPolicy;
}

export interface CognitiveRoutingPaletteFile {
  version: string;
  default_mode: RoutingOptimizeMode;
  modes: Record<RoutingOptimizeMode, CognitiveRoutingPaletteMode>;
}

const POLICY_PATH = pathResolver.knowledge('product/governance/cognitive-routing-palette.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/cognitive-routing-palette.schema.json');

const paletteCatalog = defineCatalog<CognitiveRoutingPaletteFile>({
  id: 'cognitive-routing-palette',
  path: POLICY_PATH,
  schema: SCHEMA_PATH,
});

export function loadCognitiveRoutingPalette(): CognitiveRoutingPaletteFile {
  return paletteCatalog.load();
}

export function resetCognitiveRoutingPaletteCache(): void {
  paletteCatalog.reset();
}

export function normalizeRoutingOptimizeMode(value: unknown): RoutingOptimizeMode | null {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (raw === 'cost') return 'cost';
  if (raw === 'balance' || raw === 'balanced') return 'balance';
  if (raw === 'intelligence' || raw === 'intel') return 'intelligence';
  return null;
}

export function resolveRoutingOptimizeMode(
  override?: string | null,
  env: Record<string, string | undefined> = process.env
): RoutingOptimizeMode {
  const palette = loadCognitiveRoutingPalette();
  const fromOverride = normalizeRoutingOptimizeMode(override);
  if (fromOverride) return fromOverride;
  const fromEnv = normalizeRoutingOptimizeMode(
    getRegisteredEnvText(ROUTING_OPTIMIZE_FOR_ENV, { env })
  );
  if (fromEnv) return fromEnv;
  return palette.default_mode;
}

export function resolveCognitiveRoutingPaletteMode(
  optimizeFor?: string | null,
  env: Record<string, string | undefined> = process.env
): { mode: RoutingOptimizeMode; palette: CognitiveRoutingPaletteMode; version: string } {
  const file = loadCognitiveRoutingPalette();
  const mode = resolveRoutingOptimizeMode(optimizeFor, env);
  return { mode, palette: file.modes[mode], version: file.version };
}
