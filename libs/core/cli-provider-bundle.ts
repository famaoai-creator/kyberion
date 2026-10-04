/**
 * Named seam for CLI/ACP provider runtime bundles (DS-01).
 *
 * Each governed reasoning mode registers one bundle factory under its mode id.
 * `buildCliProviderBundle` resolves the factory from the seam instead of a
 * hand-maintained switch, so adding a provider is a single self-registering
 * file under `provider-bundles/` rather than a new switch case.
 */

import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';
import { getRegisteredEnvText } from './foundation/env.js';
import type { ReasoningBackendMode } from './reasoning/reasoning-backend-policy.js';
import {
  getReasoningProviderDescriptor,
  resolveReasoningProviderEnvironment,
  type ReasoningProviderRuntimeBundle,
} from './reasoning/reasoning-provider-registry.js';

export interface CliProviderBuildOptions {
  mode: ReasoningBackendMode;
  provider?: string;
  model?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type CliProviderBundleFactory = (
  options: CliProviderBuildOptions
) => ReasoningProviderRuntimeBundle | null;

export function cliProviderEnv(options: CliProviderBuildOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

export function cliProviderEnvText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

const cliProviderBundleSeam = createSeam<CliProviderBundleFactory>({
  key: 'cli-provider-bundle',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

export function registerCliProviderBundle(
  mode: ReasoningBackendMode,
  factory: CliProviderBundleFactory,
  metadata?: Partial<SeamProviderMetadata>
): () => void {
  return cliProviderBundleSeam.register(mode, factory, {
    provenance: 'builtin',
    source: `cli-provider-bundle:${mode}`,
    reason: `runtime bundle factory for reasoning mode '${mode}'`,
    ...metadata,
  });
}

/**
 * Returns undefined for modes with no registered bundle factory and null for
 * a governed CLI mode that cannot be built. This preserves the bootstrap's
 * existing chain semantics.
 */
export function buildCliProviderBundle(
  options: CliProviderBuildOptions
): ReasoningProviderRuntimeBundle | null | undefined {
  const factory = cliProviderBundleSeam.getOptional(options.mode);
  if (!factory) return undefined;
  const descriptor = getReasoningProviderDescriptor(options.mode);
  const env = options.env ?? process.env;
  return factory({
    ...options,
    env: descriptor ? resolveReasoningProviderEnvironment(descriptor, env) : env,
  });
}

export function listCliProviderBundleModes(): string[] {
  return cliProviderBundleSeam.list().map((record) => record.id);
}
