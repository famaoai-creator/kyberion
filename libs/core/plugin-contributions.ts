/**
 * DH-08: governed, reversible contributions from an approved plugin.
 *
 * A manifest declares the contribution names; plugin code can only register a
 * contribution whose name is declared. Every successful registration returns
 * a disposer and activation rolls all of them back if one contribution fails.
 * This keeps the existing provenance gate in front of dynamic behavior.
 */

import {
  registerPluginActuatorOperation,
  type ActuatorOperationHandler,
  type PipelineStepType,
} from './actuator-op-registry.js';
import {
  getReasoningProviderDescriptor,
  registerReasoningProvider,
  type ReasoningProviderConformanceEvidence,
  type ReasoningProviderFactory,
} from './reasoning-provider-registry.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import {
  getDefaultLifecycleHookEngine,
  type LifecycleHookRegistration,
} from './lifecycle-hook-engine.js';
import {
  registerOpGuard,
  registerOpPreflightListener,
  type OpPreflightGuard,
  type OpPreflightListener,
} from './op-preflight.js';
import { coreSeamCatalog } from './seam.js';
import { listPluginFacetContributions, registerPluginFacet } from './facet-registry.js';

export interface PluginContributionDeclaration {
  seams?: string[];
  ops?: string[];
  providers?: string[];
  hooks?: string[];
  prompt_sections?: string[];
  facets?: string[];
}

export interface PluginContributionProvenance {
  pluginId: string;
  sourcePath: string;
  trust: 'official' | 'third-party';
}

export interface PluginContributionApi {
  registerSeamProvider(seamKey: string, providerId: string, implementation: unknown): () => void;
  registerOperation(
    operation: string,
    input: {
      stepType: Exclude<PipelineStepType, 'control'>;
      modulePath?: string;
      timeoutMs?: number;
      handler: ActuatorOperationHandler;
    }
  ): () => void;
  registerReasoningProvider(
    mode: string,
    factory: ReasoningProviderFactory,
    conformance?: ReasoningProviderConformanceEvidence
  ): () => void;
  registerHook(name: string, hook: LifecycleHookRegistration): () => void;
  registerPreflightListener(name: string, listener: Omit<OpPreflightListener, 'id'>): () => void;
  registerPreflightGuard(name: string, guard: Omit<OpPreflightGuard, 'id'>): () => void;
  registerPromptSection(name: string, content: string): () => void;
  registerFacet(name: string, metadata?: Record<string, unknown>): () => void;
}

export interface PluginContributionModule {
  registerKyberionContributions?: (api: PluginContributionApi) => void | Promise<void>;
}

export interface PluginContributionActivation {
  provenance: PluginContributionProvenance;
  registered: PluginContributionDeclaration;
  dispose(): void;
}

const promptSections = new Map<
  string,
  { content: string; provenance: PluginContributionProvenance }
>();
function normalizedDeclarations(
  input: PluginContributionDeclaration
): Required<PluginContributionDeclaration> {
  const normalize = (values: string[] | undefined): string[] =>
    [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort();
  return {
    seams: normalize(input.seams),
    ops: normalize(input.ops),
    providers: normalize(input.providers),
    hooks: normalize(input.hooks),
    prompt_sections: normalize(input.prompt_sections),
    facets: normalize(input.facets),
  };
}

function requireDeclared(
  category: keyof PluginContributionDeclaration,
  name: string,
  declared: Required<PluginContributionDeclaration>
): void {
  if (!declared[category].includes(name)) {
    throw new Error(
      `[PLUGIN_CONTRIBUTION_DENIED] ${category} '${name}' was not declared by the manifest`
    );
  }
}

function parseOperation(operation: string): { domain: string; action: string } {
  const [domain, ...rest] = operation.split(':');
  const action = rest.join(':');
  if (!domain || !action || rest.length !== 1) {
    throw new Error(`[PLUGIN_CONTRIBUTION_INVALID] operation must be domain:action: ${operation}`);
  }
  return { domain, action };
}

function markRegistered(
  registered: Required<PluginContributionDeclaration>,
  category: keyof PluginContributionDeclaration,
  name: string
): void {
  if (registered[category].includes(name)) {
    throw new Error(`[PLUGIN_CONTRIBUTION_CONFIG] duplicate registration: ${category}:${name}`);
  }
  registered[category].push(name);
}

/** Activate one already-authorized module; never call this before provenance authorization. */
export async function activatePluginContributions(
  declaration: PluginContributionDeclaration,
  provenance: PluginContributionProvenance,
  module: PluginContributionModule
): Promise<PluginContributionActivation> {
  const declared = normalizedDeclarations(declaration);
  const registered = normalizedDeclarations({});
  const disposers: Array<() => void> = [];
  const api: PluginContributionApi = {
    registerSeamProvider(seamKey, providerId, implementation) {
      requireDeclared('seams', seamKey, declared);
      const seam = coreSeamCatalog.get(seamKey);
      if (!seam) throw new Error(`[PLUGIN_CONTRIBUTION_INVALID] unknown seam: ${seamKey}`);
      const dispose = seam.register(providerId, implementation, {
        provenance: 'plugin',
        source: provenance.pluginId,
      });
      markRegistered(registered, 'seams', seamKey);
      disposers.push(dispose);
      return dispose;
    },
    registerOperation(operation, input) {
      requireDeclared('ops', operation, declared);
      const { domain, action } = parseOperation(operation);
      const dispose = registerPluginActuatorOperation({
        domain,
        action,
        stepType: input.stepType,
        pluginId: provenance.pluginId,
        modulePath: input.modulePath || provenance.sourcePath,
        handler: input.handler,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      markRegistered(registered, 'ops', operation);
      disposers.push(dispose);
      return dispose;
    },
    registerReasoningProvider(mode, factory, conformance) {
      requireDeclared('providers', mode, declared);
      const descriptor = getReasoningProviderDescriptor(mode as ReasoningBackendMode);
      if (!descriptor) {
        throw new Error(
          `[PLUGIN_CONTRIBUTION_DENIED] reasoning provider mode is not governed: ${mode}`
        );
      }
      const dispose = registerReasoningProvider(descriptor, factory, {
        conformance,
        requireConformance: descriptor.mode !== 'stub',
      });
      markRegistered(registered, 'providers', mode);
      disposers.push(dispose);
      return dispose;
    },
    registerHook(name, hook) {
      requireDeclared('hooks', name, declared);
      const dispose = getDefaultLifecycleHookEngine().register({
        ...hook,
        id: `${provenance.pluginId}:${name}:${hook.id}`,
      });
      markRegistered(registered, 'hooks', name);
      disposers.push(dispose);
      return dispose;
    },
    registerPreflightListener(name, listener) {
      requireDeclared('hooks', name, declared);
      const dispose = registerOpPreflightListener({
        ...listener,
        id: `${provenance.pluginId}:${name}`,
      });
      markRegistered(registered, 'hooks', name);
      disposers.push(dispose);
      return dispose;
    },
    registerPreflightGuard(name, guard) {
      requireDeclared('hooks', name, declared);
      const dispose = registerOpGuard({ ...guard, id: `${provenance.pluginId}:${name}` });
      markRegistered(registered, 'hooks', name);
      disposers.push(dispose);
      return dispose;
    },
    registerPromptSection(name, content) {
      requireDeclared('prompt_sections', name, declared);
      if (!content.trim())
        throw new Error(`[PLUGIN_CONTRIBUTION_INVALID] empty prompt section: ${name}`);
      const key = `${provenance.pluginId}:${name}`;
      if (promptSections.has(key))
        throw new Error(`[PLUGIN_CONTRIBUTION_CONFIG] duplicate prompt section: ${key}`);
      promptSections.set(key, { content, provenance });
      const dispose = () => {
        if (promptSections.get(key)?.provenance === provenance) promptSections.delete(key);
      };
      markRegistered(registered, 'prompt_sections', name);
      disposers.push(dispose);
      return dispose;
    },
    registerFacet(name, metadata = {}) {
      requireDeclared('facets', name, declared);
      const dispose = registerPluginFacet({
        name,
        metadata: { ...metadata },
        provenance,
      });
      markRegistered(registered, 'facets', name);
      disposers.push(dispose);
      return dispose;
    },
  };

  try {
    if (module.registerKyberionContributions) await module.registerKyberionContributions(api);
    // Facets are manifest-backed files and are therefore valid without a
    // module callback. Every executable contribution must be registered by
    // code, so a typo cannot silently produce a partial tool surface.
    for (const category of ['seams', 'ops', 'providers', 'hooks', 'prompt_sections'] as const) {
      const missing = declared[category].filter((name) => !registered[category].includes(name));
      if (missing.length > 0) {
        throw new Error(`[PLUGIN_CONTRIBUTION_INCOMPLETE] ${category}: ${missing.join(', ')}`);
      }
    }
    for (const name of declared.facets) {
      if (!registered.facets.includes(name)) api.registerFacet(name);
    }
    return { provenance, registered, dispose: () => disposeAll(disposers) };
  } catch (error) {
    disposeAll(disposers);
    throw error;
  }
}

function disposeAll(disposers: Array<() => void>): void {
  for (const dispose of [...disposers].reverse()) dispose();
  disposers.length = 0;
}

export function listPluginPromptSections(): Array<{
  name: string;
  content: string;
  provenance: PluginContributionProvenance;
}> {
  return [...promptSections.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ name: key, ...value }));
}

/** Render approved plugin prompt sections for the runtime instruction layer. */
export function renderPluginPromptSections(): string[] {
  return listPluginPromptSections().map(
    (section) => `Plugin contribution [${section.name}]: ${section.content}`
  );
}

export function listPluginFacets(): Array<{
  name: string;
  metadata: Record<string, unknown>;
  provenance: PluginContributionProvenance;
}> {
  return listPluginFacetContributions().map((entry) => ({
    name: `${entry.provenance.pluginId}:${entry.name}`,
    metadata: entry.metadata,
    provenance: entry.provenance,
  }));
}
