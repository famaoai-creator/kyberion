import { getRegisteredEnvText } from '../foundation/env.js';
import { readJsonLines } from '../foundation/json.js';
import { normalizeIso } from '../foundation/time.js';

import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import { withExecutionContext } from '../authority.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeRmSync } from '../secure-io.js';
import { isValidTenantSlug } from '../entity-scope.js';
import type { MeshTopicSubscription } from './mesh-hub-contract.js';

/**
 * Read side of the mesh topic subscription store (mesh-hub Task 4), used by
 * `inspectMeshHub`. The write and routing side — `subscribeMeshTopic` and
 * `resolveMeshTopicRecipients` — was retired on 2026-10-01 together with
 * `mesh-router.ts`: nothing subscribed peers and nothing routed topic
 * selectors through it. The full original module is kept at
 * `retired/libs-core/mesh/mesh-topic-registry.ts`; restore it with a real
 * subscriber entry point and broker topic routing, never alone.
 */

const DEFAULT_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub';
const DEFAULT_OBSERVABILITY_ROOT = 'active/shared/observability/mesh-hub';
const DEFAULT_WRITER_ROLE: GovernedArtifactRole = 'infrastructure_sentinel';

export interface MeshTopicSubscriptionFilter {
  tenant_id?: string;
  topic?: string;
  peer_id?: string;
}

function normalizeNamespace(namespace?: string): string {
  return String(namespace || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function meshHubRuntimeRoot(namespace?: string): string {
  const baseRoot = getRegisteredEnvText('KYBERION_MESH_HUB_RUNTIME_ROOT') || DEFAULT_RUNTIME_ROOT;
  const suffix = normalizeNamespace(namespace);
  return suffix ? `${baseRoot}/${suffix}` : baseRoot;
}

function meshHubObservabilityRoot(namespace?: string): string {
  const baseRoot =
    getRegisteredEnvText('KYBERION_MESH_HUB_OBSERVABILITY_ROOT') || DEFAULT_OBSERVABILITY_ROOT;
  const suffix = normalizeNamespace(namespace);
  return suffix ? `${baseRoot}/${suffix}` : baseRoot;
}

function tenantRoot(namespace: string | undefined, tenantId: string): string {
  if (!isValidTenantSlug(tenantId)) throw new Error(`mesh_topic_invalid_tenant_id:${tenantId}`);
  return `${meshHubRuntimeRoot(namespace)}/tenants/${tenantId}`;
}

function subscriptionsPath(namespace: string | undefined, tenantId: string): string {
  return `${tenantRoot(namespace, tenantId)}/subscriptions.jsonl`;
}

function readJsonl<T>(logicalPath: string): T[] {
  const safePath = assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return [];
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`mesh topic registry JSONL must be a regular file: ${safePath}`);
  }
  return readJsonLines<T>(safePath);
}

function loadSubscriptions(
  namespace: string | undefined,
  tenantId: string
): MeshTopicSubscription[] {
  return readJsonl<MeshTopicSubscription>(subscriptionsPath(namespace, tenantId));
}

function isActiveSubscription(subscription: MeshTopicSubscription, now: string): boolean {
  return subscription.expires_at > now;
}

export function listMeshTopicSubscriptions(
  filter: MeshTopicSubscriptionFilter = {},
  options: { namespace?: string; now?: string | Date; tenantId?: string } = {}
): MeshTopicSubscription[] {
  const namespace = options.namespace || '';
  const now = normalizeIso(options.now);
  const tenantId = options.tenantId || filter.tenant_id;
  if (!tenantId || !isValidTenantSlug(tenantId)) return [];
  return loadSubscriptions(namespace, tenantId)
    .filter((subscription) => isActiveSubscription(subscription, now))
    .filter((subscription) => {
      if (filter.tenant_id && subscription.tenant_id !== filter.tenant_id) return false;
      if (filter.topic && subscription.topic !== filter.topic) return false;
      if (filter.peer_id && subscription.peer_id !== filter.peer_id) return false;
      return true;
    })
    .sort((left, right) => left.subscription_id.localeCompare(right.subscription_id));
}

export function clearMeshTopicRegistryNamespace(namespace?: string): void {
  const normalized = normalizeNamespace(namespace);
  const root = normalized ? `${meshHubRuntimeRoot(normalized)}` : meshHubRuntimeRoot();
  const obsRoot = normalized
    ? `${meshHubObservabilityRoot(normalized)}`
    : meshHubObservabilityRoot();
  withExecutionContext(DEFAULT_WRITER_ROLE, () => {
    if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
    if (safeExistsSync(obsRoot)) safeRmSync(obsRoot, { recursive: true, force: true });
  });
}
