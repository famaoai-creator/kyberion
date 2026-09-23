/**
 * DH-08: governed, reversible contributions from an approved plugin.
 *
 * A manifest declares the contribution names; plugin code can only register a
 * contribution whose name is declared. Every successful registration returns
 * a disposer and activation rolls all of them back if one contribution fails.
 * This keeps the existing provenance gate in front of dynamic behavior.
 *
 * EP-03: every executable contribution (op handler, hook, preflight
 * listener/guard, seam implementation, reasoning provider, and the
 * activation callback itself) runs under the plugin's permission grant via
 * `runWithPluginGrant` (see plugin-grant-runtime.ts) — cooperative
 * enforcement, not a boundary against malicious in-process code.
 *
 * EP-04: each successful registration is recorded in an ownership ledger;
 * a plugin can only dispose contributions it owns.
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
import { PLUGIN_RESERVED_SEAMS } from './plugin-permissions.js';
import { listPluginFacetContributions, registerPluginFacet } from './facet-registry.js';
import type { PluginPermissionGrant } from './plugin-permissions.js';
import {
  createPluginGrantBinding,
  resolvePluginExecutionGrant,
  type PluginGrantBinding,
  type ResolvedPluginExecutionGrant,
} from './plugin-grant-runtime.js';

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
  /**
   * EP-03: the approved grant, when the caller already resolved it. Absent =>
   * resolved from the managed record / manifest. Third-party plugins are
   * never unwrapped: null or absent falls back to the deny-by-default grant.
   */
  grant?: PluginPermissionGrant | null;
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
  /** EP-03: the grant wrapping this activation (`grant === null` = legacy unwrapped). */
  grant: PluginGrantBinding;
  grantResolution: ResolvedPluginExecutionGrant;
  dispose(): void;
}

export interface ActivatePluginContributionsOptions {
  /** Managed-plugins root used to look up the approved grant (tests only). */
  managedRoot?: string;
}

export type PluginContributionCategory = keyof PluginContributionDeclaration;

interface OwnershipEntry {
  pluginId: string;
  dispose: () => void;
}

const ownership = new Map<string, OwnershipEntry>();

function ownershipKey(category: PluginContributionCategory, name: string): string {
  return `${category}\u0000${name}`;
}

/**
 * Owner of a live contribution. `name` is the runtime identifier: the op
 * (`domain:action`), provider mode, `seamKey/providerId`, or
 * `pluginId:name` for hooks, prompt sections and facets.
 */
export function ownerOfContribution(
  category: PluginContributionCategory,
  name: string
): string | undefined {
  return ownership.get(ownershipKey(category, name))?.pluginId;
}

export function listOwnedContributions(
  pluginId: string
): Array<{ category: PluginContributionCategory; name: string }> {
  const owned: Array<{ category: PluginContributionCategory; name: string }> = [];
  for (const [key, entry] of ownership) {
    if (entry.pluginId !== pluginId) continue;
    const [category, name] = key.split('\u0000') as [PluginContributionCategory, string];
    owned.push({ category, name });
  }
  return owned.sort((a, b) =>
    a.category === b.category
      ? a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0
      : a.category < b.category
        ? -1
        : 1
  );
}

/** Dispose one contribution on behalf of `requesterPluginId`; refuses another plugin's. */
export function disposeOwnedContribution(
  requesterPluginId: string,
  category: PluginContributionCategory,
  name: string
): void {
  const entry = ownership.get(ownershipKey(category, name));
  if (!entry) {
    throw new Error(`[PLUGIN_OWNERSHIP_UNKNOWN] no live contribution ${category}:${name}`);
  }
  if (entry.pluginId !== requesterPluginId) {
    throw new Error(
      `[PLUGIN_OWNERSHIP_DENIED] plugin '${requesterPluginId}' cannot dispose ${category}:${name} owned by '${entry.pluginId}'`
    );
  }
  entry.dispose();
}

function claimOwnership(
  category: PluginContributionCategory,
  name: string,
  pluginId: string
): void {
  const existing = ownership.get(ownershipKey(category, name));
  if (existing && existing.pluginId !== pluginId) {
    throw new Error(
      `[PLUGIN_CONTRIBUTION_CONFLICT] ${category}:${name} is already owned by '${existing.pluginId}'`
    );
  }
}

function recordOwnership(
  category: PluginContributionCategory,
  name: string,
  pluginId: string,
  dispose: () => void
): () => void {
  const key = ownershipKey(category, name);
  let disposed = false;
  const owned = () => {
    if (disposed) return;
    disposed = true;
    if (ownership.get(key) === entry) ownership.delete(key);
    dispose();
  };
  const entry: OwnershipEntry = { pluginId, dispose: owned };
  ownership.set(key, entry);
  return owned;
}

/**
 * Seams a plugin may never provide: they replace approval decisions, op
 * resolution or the clock (test/eval-only overrides). Checked when the
 * declaration is activated and again at registration — fail closed.
 */
export { PLUGIN_RESERVED_SEAMS };

function reservedSeamError(seamKey: string): Error {
  return new Error(`[PLUGIN_CONTRIBUTION_INVALID] reserved seam: ${seamKey}`);
}

/** Throws when a declaration names a reserved seam (usable by manifest validators). */
export function assertNoReservedPluginSeams(declaration: PluginContributionDeclaration): void {
  const reserved = (declaration.seams ?? [])
    .map((seam) => String(seam).trim())
    .find((seam) => PLUGIN_RESERVED_SEAMS.includes(seam));
  if (reserved) throw reservedSeamError(reserved);
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
  module: PluginContributionModule,
  options: ActivatePluginContributionsOptions = {}
): Promise<PluginContributionActivation> {
  assertNoReservedPluginSeams(declaration);
  const declared = normalizedDeclarations(declaration);
  const registered = normalizedDeclarations({});
  const disposers: Array<() => void> = [];
  const pluginId = provenance.pluginId;
  const grantResolution = resolvePluginExecutionGrant(provenance, options);
  const binding = createPluginGrantBinding(pluginId, grantResolution.grant);
  // Every registration goes through the ownership ledger so lifecycle
  // operations can attribute and refuse cross-plugin disposal.
  const own = (
    category: PluginContributionCategory,
    name: string,
    register: () => () => void
  ): (() => void) => {
    claimOwnership(category, name, pluginId);
    const dispose = recordOwnership(category, name, pluginId, register());
    disposers.push(dispose);
    return dispose;
  };
  const api: PluginContributionApi = {
    registerSeamProvider(seamKey, providerId, implementation) {
      if (PLUGIN_RESERVED_SEAMS.includes(String(seamKey).trim())) throw reservedSeamError(seamKey);
      requireDeclared('seams', seamKey, declared);
      const seam = coreSeamCatalog.get(seamKey);
      if (!seam) throw new Error(`[PLUGIN_CONTRIBUTION_INVALID] unknown seam: ${seamKey}`);
      const dispose = own('seams', `${seamKey}/${providerId}`, () =>
        seam.register(providerId, binding.wrapObject(implementation), {
          provenance: 'plugin',
          source: pluginId,
        })
      );
      markRegistered(registered, 'seams', seamKey);
      return dispose;
    },
    registerOperation(operation, input) {
      requireDeclared('ops', operation, declared);
      const { domain, action } = parseOperation(operation);
      const dispose = own('ops', operation, () =>
        registerPluginActuatorOperation({
          domain,
          action,
          stepType: input.stepType,
          pluginId,
          modulePath: input.modulePath || provenance.sourcePath,
          handler: binding.wrapFunction(input.handler),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        })
      );
      markRegistered(registered, 'ops', operation);
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
      const wrappedFactory: ReasoningProviderFactory = (context) => {
        const bundle = binding.run(() => factory(context));
        if (!bundle || binding.grant === null) return bundle;
        return {
          ...bundle,
          backend: binding.wrapObject(bundle.backend),
          ...(bundle.intentExtractor
            ? { intentExtractor: binding.wrapObject(bundle.intentExtractor) }
            : {}),
          ...(bundle.voiceBridge ? { voiceBridge: binding.wrapObject(bundle.voiceBridge) } : {}),
        };
      };
      const dispose = own('providers', mode, () =>
        registerReasoningProvider(descriptor, binding.grant === null ? factory : wrappedFactory, {
          conformance,
          requireConformance: descriptor.mode !== 'stub',
        })
      );
      markRegistered(registered, 'providers', mode);
      return dispose;
    },
    registerHook(name, hook) {
      requireDeclared('hooks', name, declared);
      const dispose = own('hooks', `${pluginId}:${name}`, () =>
        getDefaultLifecycleHookEngine().register({
          ...hook,
          ...(hook.handler ? { handler: binding.wrapFunction(hook.handler) } : {}),
          id: `${pluginId}:${name}:${hook.id}`,
        })
      );
      markRegistered(registered, 'hooks', name);
      return dispose;
    },
    registerPreflightListener(name, listener) {
      requireDeclared('hooks', name, declared);
      const dispose = own('hooks', `${pluginId}:${name}`, () =>
        registerOpPreflightListener({
          ...listener,
          run: binding.wrapFunction(listener.run),
          id: `${pluginId}:${name}`,
        })
      );
      markRegistered(registered, 'hooks', name);
      return dispose;
    },
    registerPreflightGuard(name, guard) {
      requireDeclared('hooks', name, declared);
      const dispose = own('hooks', `${pluginId}:${name}`, () =>
        registerOpGuard({
          ...guard,
          check: binding.wrapFunction(guard.check),
          id: `${pluginId}:${name}`,
        })
      );
      markRegistered(registered, 'hooks', name);
      return dispose;
    },
    registerPromptSection(name, content) {
      requireDeclared('prompt_sections', name, declared);
      if (!content.trim())
        throw new Error(`[PLUGIN_CONTRIBUTION_INVALID] empty prompt section: ${name}`);
      const key = `${pluginId}:${name}`;
      if (promptSections.has(key))
        throw new Error(`[PLUGIN_CONTRIBUTION_CONFIG] duplicate prompt section: ${key}`);
      const dispose = own('prompt_sections', key, () => {
        promptSections.set(key, { content, provenance });
        return () => {
          if (promptSections.get(key)?.provenance === provenance) promptSections.delete(key);
        };
      });
      markRegistered(registered, 'prompt_sections', name);
      return dispose;
    },
    registerFacet(name, metadata = {}) {
      requireDeclared('facets', name, declared);
      const dispose = own('facets', `${pluginId}:${name}`, () =>
        registerPluginFacet({
          name,
          metadata: { ...metadata },
          provenance,
        })
      );
      markRegistered(registered, 'facets', name);
      return dispose;
    },
  };

  try {
    const register = module.registerKyberionContributions;
    if (register) await binding.run(() => register.call(module, api));
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
    return {
      provenance,
      registered,
      grant: binding,
      grantResolution,
      dispose: () => disposeAll(disposers),
    };
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
