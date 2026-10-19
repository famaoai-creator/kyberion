/**
 * PG-03: the capability catalog of the Grant model
 * (`knowledge/product/governance/grant-capability-policy.json`).
 *
 * Each capability declares who decides it (`kind`) and the rules a grant must
 * satisfy: required scope keys, whether granting needs a hash-bound human
 * approval (`external_io`), the maximum standing-grant lifetime and whether a
 * use inside a mission is recorded in the mission evidence. Loaded through the
 * governed catalog boundary (schema-validated); a missing or invalid policy
 * throws, so every caller fails closed.
 */
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';

export interface StandingGrantCapabilityPolicy {
  kind: 'standing_grant';
  description?: string;
  /** `meeting` = at least one of `meeting_series_ids` / `meeting_urls`. */
  scope_keys: Array<'tenant_slug' | 'meeting'>;
  external_io: boolean;
  max_ttl_days: number;
  mission_binding: 'auto' | 'none';
}

export interface PerMissionCapabilityPolicy {
  kind: 'per_mission';
  description?: string;
  adapter: 'voice_consent';
}

export interface OsPermissionCapabilityPolicy {
  kind: 'os_permission';
  description?: string;
  probe_key: 'microphone' | 'camera' | 'screen_recording';
}

export type GrantCapabilityPolicyEntry =
  StandingGrantCapabilityPolicy | PerMissionCapabilityPolicy | OsPermissionCapabilityPolicy;

export interface GrantCapabilityPolicy {
  version: string;
  description?: string;
  capabilities: Record<string, GrantCapabilityPolicyEntry>;
}

const grantCapabilityPolicyCatalog = defineCatalog<GrantCapabilityPolicy>({
  id: 'grant-capability-policy',
  path: () => pathResolver.knowledge('product/governance/grant-capability-policy.json'),
  schema: pathResolver.knowledge('product/schemas/grant-capability-policy.schema.json'),
});

export function loadGrantCapabilityPolicy(): GrantCapabilityPolicy {
  return grantCapabilityPolicyCatalog.load();
}

/** The policy entry of one capability, or null when the catalog does not declare it. */
export function getGrantCapabilityPolicy(capability: string): GrantCapabilityPolicyEntry | null {
  const { capabilities } = loadGrantCapabilityPolicy();
  // Own keys only: `toString`, `__proto__` and friends are never capabilities.
  if (!Object.hasOwn(capabilities, capability)) return null;
  return capabilities[capability] ?? null;
}

export function listGrantCapabilities(): string[] {
  return Object.keys(loadGrantCapabilityPolicy().capabilities).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
}

export function resetGrantCapabilityPolicyCache(): void {
  grantCapabilityPolicyCatalog.reset();
}
