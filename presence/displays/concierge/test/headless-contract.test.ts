import { describe, expect, it, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const bootstrap = vi.hoisted(() => ({ open: true }));
vi.mock('@agent/core/surface/first-run-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/first-run-setup')>()),
  readFirstRunStatus: () => ({
    state: bootstrap.open ? 'unclaimed' : 'claimed',
    code_active: false,
  }),
}));
import { resetInstallationBootstrapCache } from '@agent/core/surface/installation-owner-access';
import {
  buildConciergeHeadlessManifest,
  buildConciergeHomeA2UI,
} from '../src/lib/headless-projections';
import { resolveConciergeViewerContext } from '../src/lib/viewer-context';
import { withLocalPeerRequest } from './local-peer-fixture';

describe('Concierge headless boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bootstrap.open = true;
    resetInstallationBootstrapCache();
  });

  it('publishes a read-only home resource with an A2UI projection', () => {
    const manifest = buildConciergeHeadlessManifest();
    expect(manifest.surface).toBe('concierge');
    expect(manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: 'home', a2ui_path: '/api/headless/a2ui/home' }),
        expect.objectContaining({ resource: 'settings', a2ui_path: '/api/headless/a2ui/settings' }),
      ])
    );
    expect(
      manifest.operations.find((operation) => operation.operation_id.endsWith('.a2ui'))
        ?.input_schema.properties
    ).toHaveProperty('tenant');
    expect(manifest.operations.every((operation) => operation.effect === 'read')).toBe(true);

    const messages = buildConciergeHomeA2UI({
      generated_at: '2026-08-24T00:00:00.000Z',
      briefing: {
        sentence_ja: '本日は確認事項はございません。',
        counts: { active_missions: 0, pending_approvals: 0, unread_outcomes: 0, exceptions: 0 },
      },
      intent_inbox: [],
      approval_queue: [],
      outcome_feed: [],
      exception_feed: [],
    });
    expect(messages).toHaveLength(3);
    expect(messages[1]?.updateComponents?.components.map((item) => item.id)).toEqual([
      'concierge-briefing',
      'concierge-intent-inbox',
      'concierge-approval-queue',
      'concierge-outcome-feed',
      'concierge-exception-feed',
    ]);
  });

  it('derives local viewer authority from loopback and does not accept arbitrary remote access', () => {
    const local = withLocalPeerRequest(
      new NextRequest('http://localhost:3033/api/headless/manifest'),
      resolveConciergeViewerContext
    );
    expect(local).toMatchObject({ role: 'localadmin', source: 'loopback', tenantSlugs: 'all' });

    // Once an owner is bound, a credential-less loopback client must sign in
    // (headless automation authenticates, or opts into the escape hatch).
    bootstrap.open = false;
    resetInstallationBootstrapCache();
    expect(() =>
      withLocalPeerRequest(
        new NextRequest('http://localhost:3033/api/headless/manifest'),
        resolveConciergeViewerContext
      )
    ).toThrow(/viewer principal/);
    vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '1');
    expect(
      withLocalPeerRequest(
        new NextRequest('http://localhost:3033/api/headless/manifest'),
        resolveConciergeViewerContext
      )
    ).toMatchObject({ role: 'localadmin', source: 'loopback' });

    expect(() =>
      resolveConciergeViewerContext(
        new NextRequest('https://concierge.example/api/headless/manifest')
      )
    ).toThrow(/viewer principal/);
  });
});
