import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContextAsync } from '../authority.js';
import { safeReadFile, safeWriteFile, safeRmSync } from '../secure-io.js';
import { evaluateDotFeedTriggers, readDotFeedCoverage } from './dot-feed-source.js';
import {
  evaluateDotEventTriggers,
  readDotInboundEvents,
  ingestLocalEvent,
  dotEventVisibleToCharter,
  type EventIntakePolicy,
} from './dot-event-intake.js';
import { buildTrustedInformationAssetWakeProposals } from '../information-assets/collector-wake.js';
import { INFORMATION_ASSET_WORK_PIPELINE } from '../information-assets/recipes.js';
import type { InformationAssetLocation } from '../information-assets/types.js';
import type { DotCharter, DotFeedTrigger } from './dot-charter.js';

const fixture = vi.hoisted(() => ({
  location: undefined as InformationAssetLocation | undefined,
  revoked: false,
}));
vi.mock('../information-assets/catalog.js', async (original) => ({
  ...(await original<typeof import('../information-assets/catalog.js')>()),
  readInformationAssetCatalog: (scope: { tenant_slug: string; organization_id: string }) => {
    if (
      scope.tenant_slug !== fixture.location?.scope.tenant_slug ||
      scope.organization_id !== fixture.location?.scope.organization_id
    )
      throw new Error('scope mismatch');
    return { version: 1, scope, locations: [fixture.location] };
  },
  authorizeInformationAssetCapture: async (scope: { tenant_slug: string }, id: string) => {
    if (
      fixture.revoked ||
      scope.tenant_slug !== fixture.location?.scope.tenant_slug ||
      id !== fixture.location?.location_id
    )
      throw new Error('grant revoked');
    return structuredClone(fixture.location);
  },
}));
const ROOT = 'active/shared/tmp/dot-feed-collector-tests';
const NOW = new Date('2026-11-02T00:00:00Z');
const scope = { tenant_slug: 'acme', organization_id: 'engineering' };
const feed: DotFeedTrigger = {
  kind: 'feed',
  source: 'acme',
  service_id: 'github',
  action: 'list_pulls',
  collector: { location_id: 'review-inbox', max_pages: 1 },
};
function charter(): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: 'review-watch',
    version: '1.0.0',
    title: 'Review watcher',
    purpose: 'Review assigned pull requests.',
    status: 'active',
    scope: { tier: 'confidential', ...scope },
    goal: { statement: 'Complete code review requests.' },
    attention: { triggers: [feed, { kind: 'event', sources: ['acme'], types: ['feed'] }] },
    authority: {
      authority_role: 'operations_analyst',
      allowed_pipelines: [INFORMATION_ASSET_WORK_PIPELINE],
    },
    notification: { deliver_to: { surface: 'slack', channel: '#reviews' } },
    runtime: { heartbeat_id: 'review-watch' },
  };
}
const policy: EventIntakePolicy = {
  version: '1.0.0',
  sources: {
    acme: {
      enabled: false,
      signature_header: 'x-signature',
      prefix: 'sha256=',
      secret_key: 'EVENT_INTAKE_ACME_SECRET',
      event_type_header: 'x-event',
      delivery_id_header: 'x-delivery',
      tenant_slug: 'acme',
      max_body_bytes: 65536,
    },
  },
};
const scoped = <T>(fn: () => Promise<T>) =>
  withExecutionContextAsync('organization_operator', fn, undefined, 'acme', 'engineering');
beforeEach(() => {
  fixture.revoked = false;
  fixture.location = {
    location_id: 'review-inbox',
    asset_type: 'code.review_request',
    scope,
    service_id: 'github',
    binding_id: 'github-acme',
    collector_id: 'github.review_requests',
    selectors: { owner: 'acme', repo: 'app', enrich_reviews: false },
    tier: 'confidential',
    authoritative: true,
    freshness_seconds: 300,
    enabled: true,
    version: 1,
    updated_at: NOW.toISOString(),
  };
  for (const relative of [
    'knowledge/product/orchestration/information-intake-recipes.json',
    'knowledge/product/schemas/information-intake-recipes.schema.json',
  ])
    safeWriteFile(path.join(ROOT, relative), safeReadFile(relative));
});
afterEach(() => {
  safeRmSync(ROOT, { recursive: true, force: true });
});
describe('collector feeds reuse trusted event intake and the existing event wake', () => {
  it('emits a bounded reference scoped to the organization and resolves recipe proposals from accepted archive', async () => {
    const c = charter();
    const legacy = vi.fn();
    const result = await scoped(() =>
      evaluateDotFeedTriggers(c, {
        rootDir: ROOT,
        policy,
        now: () => NOW,
        serviceCall: legacy,
        collectorServiceCall: async () => [
          {
            number: 1,
            updated_at: NOW.toISOString(),
            head: { sha: 'head-1' },
            requested_reviewers: [{ login: 'alice' }],
          },
        ],
      })
    );
    expect(result[0]).toMatchObject({ status: 'polled', ingested: 1 });
    expect(legacy).not.toHaveBeenCalled();
    const events = readDotInboundEvents('acme', { rootDir: ROOT });
    expect(events).toHaveLength(1);
    expect(events[0]!.organization_id).toBe('engineering');
    expect(events[0]!.payload).toHaveProperty('information_asset_ref');
    expect(events[0]!.payload).not.toHaveProperty('data');
    const due = evaluateDotEventTriggers(c, { rootDir: ROOT, now: () => NOW });
    expect(due).toHaveLength(1);
    const proposals = await scoped(() =>
      buildTrustedInformationAssetWakeProposals(c, due[0], ROOT)
    );
    expect(proposals?.map((proposal) => proposal.information_asset_work!.recipe_id)).toEqual([
      'github.review_request',
    ]);
    expect(readDotFeedCoverage(c, { rootDir: ROOT, now: () => NOW })[0]!.collection?.status).toBe(
      'complete'
    );
    const foreign = { ...c, scope: { ...c.scope, organization_id: 'other' } };
    expect(evaluateDotEventTriggers(foreign, { rootDir: ROOT, now: () => NOW })).toEqual([]);
  });
  it('does not trust a webhook body claiming an archived information asset reference', async () => {
    const c = charter();
    const event = ingestLocalEvent({
      source: 'acme',
      type: 'feed',
      deliveryId: 'forged',
      body: { information_asset_ref: { event_id: 'a'.repeat(64), location_id: 'review-inbox' } },
      organizationId: 'engineering',
      rootDir: ROOT,
      policy,
      now: NOW,
    });
    const due = evaluateDotEventTriggers(c, { rootDir: ROOT, now: () => NOW });
    expect(due[0]!.key).toBe('event:' + event.event_id);
    expect(
      await scoped(() => buildTrustedInformationAssetWakeProposals(c, due[0], ROOT))
    ).toBeUndefined();
  });
  it('rejects source binding and revoked capture grants before calling any provider', async () => {
    const c = charter();
    const transport = vi.fn(async () => []);
    const foreignPolicy = {
      ...policy,
      sources: { acme: { ...policy.sources.acme!, tenant_slug: 'other' } },
    };
    expect(
      (
        await scoped(() =>
          evaluateDotFeedTriggers(c, {
            rootDir: ROOT,
            policy: foreignPolicy,
            collectorServiceCall: transport,
            now: () => NOW,
          })
        )
      )[0]!.status
    ).toBe('failed');
    fixture.revoked = true;
    const later = new Date(NOW.getTime() + 3600000);
    expect(
      (
        await scoped(() =>
          evaluateDotFeedTriggers(c, {
            rootDir: ROOT,
            policy,
            collectorServiceCall: transport,
            now: () => later,
          })
        )
      )[0]!.status
    ).toBe('failed');
    expect(transport).not.toHaveBeenCalled();
  });
  it('limits project events to the exact project charter in both ordinary and durable visibility', () => {
    const c = charter();
    const event = ingestLocalEvent({
      source: 'acme',
      type: 'feed',
      deliveryId: 'project-event',
      body: {},
      organizationId: 'engineering',
      projectId: 'app',
      rootDir: ROOT,
      policy,
      now: NOW,
    }).event;
    expect(
      dotEventVisibleToCharter(event, { ...c, scope: { ...c.scope, project_id: 'app' } })
    ).toBe(true);
    expect(
      dotEventVisibleToCharter(event, { ...c, scope: { ...c.scope, project_id: 'other' } })
    ).toBe(false);
    expect(evaluateDotEventTriggers(c, { rootDir: ROOT, now: () => NOW })).toEqual([]);
  });
});
