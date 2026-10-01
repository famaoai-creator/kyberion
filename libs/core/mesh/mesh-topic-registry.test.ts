import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendGovernedArtifactJsonl, pathResolver, safeRmSync } from '../index.js';
import {
  clearMeshTopicRegistryNamespace,
  listMeshTopicSubscriptions,
} from './mesh-topic-registry.js';
import type { MeshTopicSubscription } from './mesh-hub-contract.js';

const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-topic-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(pathResolver.rootDir(), TEST_RUNTIME_ROOT);

function seed(subscription: Partial<MeshTopicSubscription> & { subscription_id: string }) {
  appendGovernedArtifactJsonl(
    'infrastructure_sentinel',
    `${TEST_RUNTIME_ROOT}/tenants/tenant-acme/subscriptions.jsonl`,
    {
      kind: 'mesh-topic-subscription',
      tenant_id: 'tenant-acme',
      topic: 'release.review',
      peer_id: 'peer-a1',
      filters: { request_kinds: ['notification.publish'], payload_classifications: ['public'] },
      expires_at: '2026-06-24T01:00:00.000Z',
      policy_version: '1.0.0',
      ...subscription,
    }
  );
}

describe('mesh-topic-registry (read side)', () => {
  beforeEach(() => {
    process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = TEST_RUNTIME_ROOT;
    process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT = TEST_RUNTIME_ROOT.replace(
      'runtime',
      'observability'
    );
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
  });

  afterEach(() => {
    clearMeshTopicRegistryNamespace();
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
  });

  it('lists only active subscriptions, filtered and sorted', () => {
    seed({ subscription_id: 'sub-b', peer_id: 'peer-b' });
    seed({ subscription_id: 'sub-a' });
    seed({ subscription_id: 'sub-expired', expires_at: '2026-06-23T00:00:00.000Z' });

    const now = '2026-06-24T00:00:00.000Z';
    expect(
      listMeshTopicSubscriptions({}, { tenantId: 'tenant-acme', now }).map(
        (entry) => entry.subscription_id
      )
    ).toEqual(['sub-a', 'sub-b']);
    expect(
      listMeshTopicSubscriptions({ tenant_id: 'tenant-acme', peer_id: 'peer-b' }, { now })
    ).toHaveLength(1);
  });

  it('never reads tier or partition names as tenants', () => {
    for (const tenantId of ['public', 'confidential', 'personal', 'shared']) {
      expect(listMeshTopicSubscriptions({}, { tenantId })).toEqual([]);
    }
  });
});
