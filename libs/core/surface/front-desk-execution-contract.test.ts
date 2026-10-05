import { frontDeskExecutionArtifactPath } from './front-desk-execution-artifact.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FrontDeskExecutionMapping,
  FrontDeskExecutionBinding,
} from './front-desk-execution-contract.js';
const state = vi.hoisted(() => ({
  policy: { version: 1, mappings: [] } as unknown,
  pipeline: '',
  missingPipeline: false,
}));
vi.mock('../secure-io.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...original,
    safeReadFile: (path: string, options?: import('../secure-io.js').SafeReadOptions) => {
      if (path.endsWith('/pipelines/front-desk-request-receipt.json')) {
        if (state.missingPipeline) throw new Error('missing');
        return state.pipeline;
      }
      return original.safeReadFile(path, options);
    },
  };
});
vi.mock('../foundation/governed-catalog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../foundation/governed-catalog.js')>();
  return {
    ...original,
    defineCatalog: (
      options: import('../foundation/governed-catalog.js').GovernedCatalogOptions<unknown>
    ) => {
      const catalog = original.defineCatalog(options);
      return options.id === 'front-desk-execution-policy'
        ? {
            ...catalog,
            load: () => {
              try {
                return catalog.validate(state.policy);
              } catch {
                return { version: 1, mappings: [] };
              }
            },
          }
        : catalog;
    },
  };
});
import {
  loadFrontDeskExecutionPolicy,
  frontDeskMappingDigest,
  getFrontDeskExecutionMapping,
  frontDeskExecutionViewerMatches,
  frontDeskExecutionViewerFingerprint,
  frontDeskExecutionExpectedContent,
  parseFrontDeskExecutionBinding,
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
} from './front-desk-execution-contract.js';
const receiptPipeline = () => ({
  action: 'pipeline',
  pipeline_id: 'front-desk-request-receipt',
  version: '1.0.0',
  steps: [
    {
      id: 'write-request-receipt',
      role: 'sink',
      op: 'system:write_file',
      params: { path: '{{front_desk_output_path}}', content: '{{front_desk_artifact_content}}' },
    },
  ],
});
const mapping = (): FrontDeskExecutionMapping => ({
  id: 'receipt-a',
  dotId: 'dot-a',
  viewer: {
    principalId: 'human:alice',
    memberId: 'alice',
    role: 'localadmin',
    source: 'token',
    tenantSlugs: ['tenant-a'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['public'],
  },
  exactCommand: FRONT_DESK_RECEIPT_COMMAND,
  pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
});
const binding = (map = mapping()): FrontDeskExecutionBinding => ({
  mapping_id: map.id,
  config_digest: frontDeskMappingDigest(map),
  conversation_key: 'a'.repeat(64),
  request_id: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  request_digest: 'b'.repeat(64),
  work_item_id: 'WI-FD-' + 'c'.repeat(48),
});
beforeEach(() => {
  state.policy = { version: 1, mappings: [mapping()] };
  state.pipeline = JSON.stringify(receiptPipeline());
  state.missingPipeline = false;
});
describe('fail-closed bounded diagnostic policy', () => {
  it('loads only the exact versioned receipt contract', () => {
    expect(loadFrontDeskExecutionPolicy().mappings).toEqual([mapping()]);
  });
  it.each([
    { mappings: [] },
    { version: 1, mappings: [{ ...mapping(), exactCommand: 'Deploy my app' }] },
    {
      version: 1,
      mappings: [
        { ...mapping(), pipeline: { path: 'pipelines/other.json', version: 'receipt-v1' } },
      ],
    },
    {
      version: 1,
      mappings: [{ ...mapping(), pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: 'v2' } }],
    },
    {
      version: 1,
      mappings: [{ ...mapping(), viewer: { ...mapping().viewer, tenantSlugs: 'all' } }],
    },
    {
      version: 1,
      mappings: [
        { ...mapping(), viewer: { ...mapping().viewer, organizationIds: ['org-a', 'org-b'] } },
      ],
    },
    {
      version: 1,
      mappings: [{ ...mapping(), viewer: { ...mapping().viewer, source: 'anonymous' } }],
    },
    {
      version: 1,
      mappings: [{ ...mapping(), viewer: { ...mapping().viewer, principalId: undefined } }],
    },
    { version: 1, mappings: [{ ...mapping(), approved: true }] },
  ])('enables nothing for invalid schema %#', (policy) => {
    state.policy = policy;
    expect(loadFrontDeskExecutionPolicy()).toEqual({ version: 1, mappings: [] });
  });
  it('rejects duplicate mapping IDs and ambiguous equal viewers', () => {
    state.policy = {
      version: 1,
      mappings: [
        mapping(),
        { ...mapping(), viewer: { ...mapping().viewer, principalId: 'human:bob' } },
      ],
    };
    expect(loadFrontDeskExecutionPolicy().mappings).toEqual([]);
    state.policy = { version: 1, mappings: [mapping(), { ...mapping(), id: 'receipt-b' }] };
    expect(loadFrontDeskExecutionPolicy().mappings).toEqual([]);
  });
  it('binds current pipeline bytes and refuses stale or missing bytes', () => {
    const first = binding();
    expect(getFrontDeskExecutionMapping(first)).toEqual(mapping());
    state.pipeline += ' ';
    expect(getFrontDeskExecutionMapping(first)).toBeUndefined();
    state.missingPipeline = true;
    expect(getFrontDeskExecutionMapping(first)).toBeUndefined();
  });
  it('canonicalizes permission ordering while binding each viewer restriction', () => {
    const map = mapping();
    const reordered = {
      ...map,
      viewer: {
        ...map.viewer,
        tierAccess: ['public'] as typeof map.viewer.tierAccess,
      },
      pipeline: { version: FRONT_DESK_RECEIPT_VERSION, path: FRONT_DESK_RECEIPT_PIPELINE },
    };
    expect(frontDeskMappingDigest(map)).toBe(frontDeskMappingDigest(reordered));
    for (const change of [
      { principalId: 'human:bob' },
      { memberId: 'bob' },
      { role: 'readonly' },
      { source: 'loopback' },
      { tenantSlugs: ['tenant-b'] },
      { organizationIds: ['org-b'] },
      { projectIds: ['project-b'] },
    ]) {
      const other = { ...map.viewer, ...change } as typeof map.viewer;
      expect(frontDeskExecutionViewerMatches(other, map)).toBe(false);
      expect(frontDeskExecutionViewerFingerprint(other)).not.toBe(
        frontDeskExecutionViewerFingerprint(map.viewer)
      );
      expect(frontDeskMappingDigest({ ...map, viewer: other })).not.toBe(
        frontDeskMappingDigest(map)
      );
    }
  });
  it('accepts only bounded reference metadata, never request prose or approval fields', () => {
    const valid = binding();
    expect(parseFrontDeskExecutionBinding(valid)).toEqual(valid);
    for (const extra of [
      { request_text: 'private data' },
      { approved: true },
      { revision: 0 },
      { revision: 1.2 },
      { work_item_id: '../escape' },
      { request_id: 'not-a-uuid' },
      { config_digest: 'bad' },
    ])
      expect(parseFrontDeskExecutionBinding({ ...valid, ...extra })).toBeUndefined();
  });
  it('derives the scoped report path and immutable expected receipt without user paths', () => {
    const map = mapping(),
      bound = binding(map);
    const path = frontDeskExecutionArtifactPath(bound, map);
    expect(path).toBe(
      'active/shared/artifacts/public/tenant-a/report/front-desk/' +
        bound.conversation_key +
        '/' +
        bound.request_id +
        '-r1.json'
    );
    expect(
      JSON.parse(
        frontDeskExecutionExpectedContent(bound, map, 'concierge-' + bound.conversation_key)
      )
    ).toEqual({
      kind: 'front-desk-request-receipt',
      version: 'receipt-v1',
      request_id: bound.request_id,
      session_id: 'concierge-' + bound.conversation_key,
      revision: 1,
      request_digest: bound.request_digest,
      request_text: FRONT_DESK_RECEIPT_COMMAND,
    });
  });
});

describe('fixed diagnostic pipeline topology', () => {
  it('permits optional description and whitespace only with a new byte-bound digest', () => {
    const previous = binding();
    state.pipeline =
      JSON.stringify(
        { ...receiptPipeline(), description: 'Harmless operator description' },
        null,
        2
      ) + '\n';
    expect(frontDeskMappingDigest(mapping())).not.toBe(previous.config_digest);
    expect(getFrontDeskExecutionMapping(previous)).toBeUndefined();
    expect(getFrontDeskExecutionMapping(binding())).toEqual(mapping());
  });
  it.each([
    { action: 'execute' },
    { pipeline_id: 'another-pipeline' },
    { version: '2.0.0' },
    { schedule: '* * * * *' },
    { runtime: {} },
    { context: {} },
    { inputs: {} },
    { description: { op: 'external:send' } },
    { steps: [] },
    { steps: [...receiptPipeline().steps, ...receiptPipeline().steps] },
  ])('rejects changed top-level structure %# even for fresh approval', (change) => {
    const previous = binding();
    state.pipeline = JSON.stringify({ ...receiptPipeline(), ...change });
    expect(() => frontDeskMappingDigest(mapping())).toThrow();
    expect(getFrontDeskExecutionMapping(previous)).toBeUndefined();
  });
  it.each([
    { id: 'external-step' },
    { role: 'source' },
    { op: 'slack:send_message' },
    { op: 'system:exec' },
    { when: true },
    { context: {} },
    { schedule: '* * * * *' },
    { runtime: {} },
    { description: 'additional metadata' },
    { params: { path: 'outside.json', content: '{{front_desk_artifact_content}}' } },
    { params: { path: '{{front_desk_output_path}}', content: 'different content' } },
    {
      params: {
        path: '{{front_desk_output_path}}',
        content: '{{front_desk_artifact_content}}',
        append: true,
      },
    },
    { params: { path: '{{front_desk_output_path}}' } },
  ])('rejects changed step or effect parameters %#', (change) => {
    const previous = binding();
    state.pipeline = JSON.stringify({
      ...receiptPipeline(),
      steps: [{ ...receiptPipeline().steps[0], ...change }],
    });
    expect(() => frontDeskMappingDigest(mapping())).toThrow();
    expect(getFrontDeskExecutionMapping(previous)).toBeUndefined();
  });
  it.each(['not JSON', '[]', 'null', '{"__proto__":{}}', '{"constructor":{}}'])(
    'uses safe JSON validation for %s',
    (raw) => {
      state.pipeline = raw;
      expect(() => frontDeskMappingDigest(mapping())).toThrow();
    }
  );
});

describe('protected mappings are never downgraded', () => {
  it.each([
    { tiers: ['confidential'] },
    { tiers: ['personal'] },
    { tiers: ['public', 'confidential'] },
    { tiers: ['public', 'personal'] },
  ])('rejects protected scopes %j at policy, digest and artifact boundaries', ({ tiers }) => {
    const bound = binding();
    const protectedMapping = {
      ...mapping(),
      viewer: {
        ...mapping().viewer,
        tierAccess: tiers as FrontDeskExecutionMapping['viewer']['tierAccess'],
      },
    };
    state.policy = { version: 1, mappings: [protectedMapping] };
    expect(loadFrontDeskExecutionPolicy().mappings).toEqual([]);
    expect(() => frontDeskMappingDigest(protectedMapping)).toThrow('front_desk_contract_invalid');
    expect(() => frontDeskExecutionArtifactPath(bound, protectedMapping)).toThrow(
      'front_desk_scope_invalid'
    );
    expect(frontDeskExecutionViewerMatches(protectedMapping.viewer, protectedMapping)).toBe(false);
    expect(frontDeskExecutionViewerFingerprint(protectedMapping.viewer)).not.toBe(
      frontDeskExecutionViewerFingerprint(mapping().viewer)
    );
  });
});
