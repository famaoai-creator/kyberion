import { describe, expect, it, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildConciergeHeadlessManifest,
  buildConciergeHomeA2UI,
} from '../src/lib/headless-projections';
import { resolveConciergeViewerContext } from '../src/lib/viewer-context';

describe('Concierge headless boundary', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('publishes a read-only home resource with an A2UI projection', () => {
    const manifest = buildConciergeHeadlessManifest();
    expect(manifest.surface).toBe('concierge');
    expect(manifest.resources).toEqual([
      expect.objectContaining({ resource: 'home', a2ui_path: '/api/headless/a2ui/home' }),
    ]);
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
    const local = resolveConciergeViewerContext(
      new NextRequest('http://localhost:3033/api/headless/manifest')
    );
    expect(local).toMatchObject({ role: 'localadmin', source: 'loopback', tenantSlugs: 'all' });

    expect(() =>
      resolveConciergeViewerContext(
        new NextRequest('https://concierge.example/api/headless/manifest')
      )
    ).toThrow(/viewer principal/);
  });
});
