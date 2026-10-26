/**
 * Dot extension registry — ordered hooks, one array per seam in
 * `dot-extensions.ts`. The cores iterate them in array order (prompt sections
 * sort by their own `order`).
 *
 * This module is a dependency leaf: it imports no extension module, so the
 * cores (`dot-runtime`, `dot-dispatch`) can read the arrays without forming a
 * runtime import cycle with the extensions (which import the cores). The
 * Built-ins are populated by `dot-extension-bootstrap.ts`. New capabilities
 * use registerDotExtension at their composition boundary. Mutable arrays stay
 * available for legacy consumers and test harnesses; direct mutation bypasses
 * duplicate checking, ordering and provenance and is not the extension API.
 */

import type {
  DotDecisionRelaxer,
  DotDigestSection,
  DotDispositionOverride,
  DotFloorContributor,
  DotPreGateCheck,
  DotPromptSection,
  DotStatusSection,
  DotWakeTool,
} from './dot-extensions.js';
import type { SeamProviderMetadata } from '../seam.js';
import { DOT_PROPOSE_TOOL_NAME, DOT_PROPOSALS_FENCE } from './dot-extensions.js';

export const DOT_PROMPT_SECTIONS: DotPromptSection[] = [];
export const DOT_FLOOR_CONTRIBUTORS: DotFloorContributor[] = [];
export const DOT_PRE_GATE_CHECKS: DotPreGateCheck[] = [];
export const DOT_DECISION_RELAXERS: DotDecisionRelaxer[] = [];
export const DOT_DISPOSITION_OVERRIDES: DotDispositionOverride[] = [];
export const DOT_WAKE_TOOLS: DotWakeTool[] = [];
export const DOT_STATUS_SECTIONS: DotStatusSection[] = [];
export const DOT_DIGEST_SECTIONS: DotDigestSection[] = [];

export interface DotExtensionHooks {
  promptSections?: readonly DotPromptSection[];
  floorContributors?: readonly DotFloorContributor[];
  preGateChecks?: readonly DotPreGateCheck[];
  decisionRelaxers?: readonly DotDecisionRelaxer[];
  dispositionOverrides?: readonly DotDispositionOverride[];
  wakeTools?: readonly DotWakeTool[];
  statusSections?: readonly DotStatusSection[];
  digestSections?: readonly DotDigestSection[];
}

export interface DotExtensionRegistration {
  id: string;
  /** Lower orders execute first; ties retain registration order. Prompt sections also use their own order. */
  order: number;
  metadata: SeamProviderMetadata;
  hooks: DotExtensionHooks;
}

export interface DotExtensionSnapshot {
  id: string;
  order: number;
  metadata: SeamProviderMetadata;
}

const registrations = new Map<string, DotExtensionSnapshot>();
// A multi-interface object may participate in different seams independently.
const hookOrders = new WeakMap<object, WeakMap<object, number>>();

/** Register a capability atomically. Registration is composition, never an authority grant. */
export function registerDotExtension(registration: DotExtensionRegistration): () => void {
  const { id, order } = registration;
  if (!id.trim() || !Number.isFinite(order) || !registration.metadata.source?.trim())
    throw new Error('Dot extension requires an id, finite order, and provenance source');
  if (registrations.has(id)) throw new Error(`Duplicate dot extension: ${id}`);
  const prepared: Array<{ apply: () => void; remove: () => void }> = [];
  function prepare<T extends object>(
    target: T[],
    hooks: readonly T[] | undefined,
    identity: (hook: T) => string,
    label: string
  ): void {
    const incoming = [...(hooks ?? [])];
    let orders = hookOrders.get(target);
    if (!orders) {
      orders = new WeakMap<object, number>();
      hookOrders.set(target, orders);
    }
    const targetOrders = orders;
    const seen = new Set(target.map(identity));
    for (const hook of incoming) {
      const key = identity(hook);
      if (!key.trim() || seen.has(key)) throw new Error(`Duplicate or empty dot ${label}: ${key}`);
      seen.add(key);
    }
    prepared.push({
      apply() {
        const index = target.findIndex((hook) => (targetOrders.get(hook) ?? 0) > order);
        for (const hook of incoming) targetOrders.set(hook, order);
        target.splice(index < 0 ? target.length : index, 0, ...incoming);
      },
      remove() {
        for (const hook of incoming) {
          const index = target.indexOf(hook);
          if (index >= 0) target.splice(index, 1);
          targetOrders.delete(hook);
        }
      },
    });
  }
  const hooks = registration.hooks;
  prepare(DOT_PROMPT_SECTIONS, hooks.promptSections, (hook) => hook.id, 'prompt section');
  prepare(DOT_FLOOR_CONTRIBUTORS, hooks.floorContributors, (hook) => hook.id, 'floor contributor');
  prepare(DOT_PRE_GATE_CHECKS, hooks.preGateChecks, (hook) => hook.id, 'pre-gate check');
  prepare(DOT_DECISION_RELAXERS, hooks.decisionRelaxers, (hook) => hook.id, 'decision relaxer');
  prepare(
    DOT_DISPOSITION_OVERRIDES,
    hooks.dispositionOverrides,
    (hook) => hook.id,
    'disposition override'
  );
  prepare(DOT_WAKE_TOOLS, hooks.wakeTools, (hook) => hook.name, 'wake tool name');
  // Fences are a second tool identity on delegated reasoning backends.
  const fences = new Set(DOT_WAKE_TOOLS.map((tool) => tool.fence));
  for (const tool of hooks.wakeTools ?? []) {
    if (tool.name === DOT_PROPOSE_TOOL_NAME || tool.fence === DOT_PROPOSALS_FENCE)
      throw new Error('Dot wake tool uses a reserved core proposal identity');
    if (tool.definition.name !== tool.name)
      throw new Error('Dot wake tool definition name must match its registered name');
    if (!tool.fence.trim() || fences.has(tool.fence))
      throw new Error(`Duplicate or empty dot wake tool fence: ${tool.fence}`);
    fences.add(tool.fence);
  }
  prepare(DOT_STATUS_SECTIONS, hooks.statusSections, (hook) => hook.id, 'status section');
  prepare(DOT_DIGEST_SECTIONS, hooks.digestSections, (hook) => hook.id, 'digest section');
  // All validation happens before any array changes, including cross-seam collisions.
  const snapshot: DotExtensionSnapshot = {
    id,
    order,
    metadata: { ...registration.metadata },
  };
  for (const entry of prepared) entry.apply();
  registrations.set(id, snapshot);
  return () => {
    if (registrations.get(id) !== snapshot) return;
    for (const entry of prepared) entry.remove();
    registrations.delete(id);
  };
}

/** Review the active composition without exposing mutable registration metadata. */
export function listDotExtensions(): DotExtensionSnapshot[] {
  return [...registrations.values()]
    .sort((left, right) => left.order - right.order)
    .map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
}
