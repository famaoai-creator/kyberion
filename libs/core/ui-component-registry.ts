/**
 * UI component registry — the business-flow components the front-desk host
 * assembles (A2UI COMPONENT HOST PLAN 2026-09-15 §2.2).
 *
 * One entry is one flow (stateful, e.g. hearing) or one view (read-only
 * projection). The registry says *what exists, where it is placed, who may
 * see it, and which headless operations it owns*. It never carries display
 * text (labels are vocabulary keys), never HTML, never tenant logic.
 *
 * Governed data: `knowledge/product/orchestration/ui-component-registry.json`
 * (schema `ui-component-registry.schema.json`, catalog integrity registered).
 */
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export type UiComponentKind = 'flow' | 'view';
export type UiComponentStatus = 'a2ui' | 'page' | 'planned';
export type UiComponentHost = 'presence-studio' | 'concierge';
export type UiComponentMenuGroup = 'home' | 'ask' | 'decide' | 'progress' | 'settings';
export type UiComponentRole = 'viewer' | 'approver' | 'owner';

export interface UiComponentInput {
  operation_id: string;
  placeholder_key: string;
}

export interface UiComponentEntry {
  a2ui_path?: string;
  page_path?: string;
  page_surface?: UiComponentHost;
  input?: UiComponentInput;
}

export interface UiComponent {
  id: string;
  kind: UiComponentKind;
  status: UiComponentStatus;
  title_key: string;
  summary_key: string;
  host: UiComponentHost;
  entry?: UiComponentEntry;
  menu: { group: UiComponentMenuGroup; order: number };
  required_role: UiComponentRole;
  operations: string[];
}

export interface UiComponentRegistry {
  version: string;
  components: UiComponent[];
}

const catalog = defineCatalog<UiComponentRegistry & { $schema?: string }>({
  id: 'ui-component-registry',
  path: pathResolver.rootResolve('knowledge/product/orchestration/ui-component-registry.json'),
  schema: pathResolver.rootResolve('knowledge/product/schemas/ui-component-registry.schema.json'),
});

export function loadUiComponentRegistry(): UiComponentRegistry {
  const { $schema: _schema, ...value } = catalog.load();
  void _schema;
  return value;
}

export function findUiComponent(id: string): UiComponent | undefined {
  return loadUiComponentRegistry().components.find((component) => component.id === id);
}

const ROLE_RANK: Record<UiComponentRole, number> = { viewer: 0, approver: 1, owner: 2 };

/** `owner` sees everything, `approver` what needs at most approver, `viewer` only viewer-level. */
export function roleCanSee(role: UiComponentRole, required: UiComponentRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Components a viewer with `role` may see, in menu order (group order follows the five human verbs). */
export function listUiComponents(
  role: UiComponentRole,
  options: { host?: UiComponentHost; group?: UiComponentMenuGroup } = {}
): UiComponent[] {
  const groupOrder: UiComponentMenuGroup[] = ['home', 'ask', 'decide', 'progress', 'settings'];
  return loadUiComponentRegistry()
    .components.filter((component) => roleCanSee(role, component.required_role))
    .filter((component) => !options.host || component.host === options.host)
    .filter((component) => !options.group || component.menu.group === options.group)
    .sort(
      (a, b) =>
        groupOrder.indexOf(a.menu.group) - groupOrder.indexOf(b.menu.group) ||
        a.menu.order - b.menu.order ||
        a.id.localeCompare(b.id)
    );
}

/**
 * Registry ↔ manifest coherence: every operation a component claims must be
 * a real headless operation. Pure; the host's contract test feeds it the
 * surface manifest's operation ids.
 */
export function unknownComponentOperations(
  registry: UiComponentRegistry,
  knownOperationIds: ReadonlySet<string>
): Array<{ component: string; operation_id: string }> {
  const missing: Array<{ component: string; operation_id: string }> = [];
  for (const component of registry.components) {
    for (const operationId of component.operations) {
      if (!knownOperationIds.has(operationId)) {
        missing.push({ component: component.id, operation_id: operationId });
      }
    }
    const input = component.entry?.input?.operation_id;
    if (input && !knownOperationIds.has(input)) {
      missing.push({ component: component.id, operation_id: input });
    }
  }
  return missing;
}
