import type {
  KbStatus,
  KbStatusDomain,
  KbStatusTone,
  KyberionBaseAlias,
  KyberionBaseComponentType,
} from '@agent/core/a2ui-catalog';
import {
  KB_ALIASES as KB_ALIASES_SOURCE,
  KB_RENDERED_TYPES,
  KB_STATUS_MESSAGE_KEYS as KB_STATUS_MESSAGE_KEYS_SOURCE,
  resolveType,
  statusLabel as statusLabelVanilla,
  type KbTranslate,
} from '../vanilla/kyberion-ui.js';

/**
 * Client-safe mirror of the runtime constants in `@agent/core/a2ui-catalog`.
 *
 * The core module compiles the catalog JSON schema with ajv and reads it from
 * disk, so it must never be bundled into a browser. Only its *types* are
 * imported here.
 *
 * The component type list, alias map, status message keys and `resolveKbType`
 * itself are NOT duplicated here: `libs/shared-ui/vanilla/kyberion-ui.js` is
 * the single source (so both renderers stay in lock-step by construction),
 * re-exported under this package's stronger public types. Values are pinned
 * to the `@agent/core` originals by `renderer.test.tsx`.
 */

export const KB_COMPONENT_TYPES: readonly KyberionBaseComponentType[] =
  KB_RENDERED_TYPES as readonly KyberionBaseComponentType[];

export const KB_ALIASES: Readonly<Record<KyberionBaseAlias, KyberionBaseComponentType>> =
  KB_ALIASES_SOURCE as Readonly<Record<KyberionBaseAlias, KyberionBaseComponentType>>;

/** Action id dispatched through `A2UIActionProvider` when a button tab is chosen without `onSelect`. */
export const TABS_SELECT_ACTION = 'ui:tabs.select';

/** Resolve a catalog type or legacy alias; `null` when the type is outside the catalog. */
export function resolveKbType(type: string): KyberionBaseComponentType | null {
  return resolveType(type) as KyberionBaseComponentType | null;
}

export const KB_STATUS_TONE_MAP: Readonly<Record<KbStatus, KbStatusTone>> = Object.freeze({
  ready: 'success',
  fully_automatable: 'success',
  connected: 'success',
  available: 'success',
  done: 'success',
  completed: 'success',
  recovered: 'success',
  running: 'success',
  active: 'info',
  connecting: 'info',
  working: 'info',
  busy: 'info',
  review: 'info',
  distilling: 'info',
  needs_clarification: 'warning',
  needs_external_assets: 'warning',
  needs_assets: 'warning',
  needs_setup: 'warning',
  missing_runtime_prerequisites: 'warning',
  needs_runtime_prerequisites: 'warning',
  pending: 'warning',
  degraded: 'warning',
  fallback: 'warning',
  paused: 'warning',
  stale: 'warning',
  blocked: 'danger',
  missing: 'danger',
  error: 'danger',
  unavailable: 'danger',
  failed: 'danger',
  disconnected: 'danger',
  offline: 'danger',
  'n/a': 'neutral',
  planned: 'neutral',
  archived: 'neutral',
  stopped: 'neutral',
});

/**
 * Vocabulary message key (`ui:status_*` in user-facing-vocabulary.json) for
 * every status; the text comes from the locale bundle (`KbI18nProvider`).
 * Sourced from `libs/shared-ui/vanilla/kyberion-ui.js` (single source).
 */
export const KB_STATUS_MESSAGE_KEYS: Readonly<Record<KbStatus, string>> =
  KB_STATUS_MESSAGE_KEYS_SOURCE as Readonly<Record<KbStatus, string>>;

export function isKbStatus(value: unknown): value is KbStatus {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(KB_STATUS_TONE_MAP, value)
  );
}

export function statusTone(status: string): KbStatusTone {
  return isKbStatus(status) ? KB_STATUS_TONE_MAP[status] : 'neutral';
}

/**
 * Localized label for a status through `translate` (see `useKbI18n().t`);
 * domain wording first. Unknown values are shown verbatim rather than hidden.
 */
export function statusLabel(
  status: string,
  domain: KbStatusDomain | undefined,
  translate: KbTranslate
): string {
  return statusLabelVanilla(status, domain, undefined, translate);
}
