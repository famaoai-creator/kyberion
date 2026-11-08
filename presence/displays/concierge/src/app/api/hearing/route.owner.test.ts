import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyHearingTurn, createHearingRecord } from '@agent/core/surface/hearing';
import {
  call,
  hr,
  sessionId,
  setUpHearing,
  storedHearing,
  tearDownHearing,
} from '../../../../test/hearing-route-harness';

// R1: the personal hearing store (a viewer with no single tenant) belongs to
// the owner of this machine. On Concierge the owner is the installation owner
// (`resolveConciergeInstallationAccess`) — here signed in with a browser
// session, so the viewer's credential source is `token`, never `loopback`.
// Both members hold the same tenant membership; `tenant=personal`
// (Concierge's personal view) narrows each to no tenant and opens the one
// personal namespace (`all`, as for a viewer without a single tenant and for
// Studio's loopback owner); only the owner reaches it.
beforeAll(() => setUpHearing(), 120_000);
afterAll(() => tearDownHearing());

describe('concierge /api/hearing personal store', { timeout: 120_000 }, () => {
  it('lets the signed-in installation owner read and write the personal hearing store', async () => {
    const id = sessionId();
    const answer = await call(
      'answer',
      'POST',
      `/api/hearing/${id}/answer?tenant=personal`,
      { session: id },
      {
        body: { text: 'goal: my own hearing' },
      }
    );
    expect(answer.status).toBe(200);
    const read = await call('record', 'GET', `/api/hearing/${id}?tenant=personal`, { session: id });
    expect(read.status).toBe(200);
    expect(read.body.persisted).toBe(true);
    // One personal store: the same `all` namespace as Studio's loopback owner.
    const namespace = hr.runtime.hearingNamespace('all');
    const stored = storedHearing(namespace, id);
    expect(stored?.session_id).toBe(id);
  });

  it('refuses the personal store to a signed-in member who is not the owner, read or write', async () => {
    const id = sessionId();
    await call(
      'answer',
      'POST',
      `/api/hearing/${id}/answer?tenant=personal`,
      { session: id },
      {
        body: { text: 'goal: the owner only' },
      }
    );
    const read = await call(
      'record',
      'GET',
      `/api/hearing/${id}?tenant=personal`,
      { session: id },
      {
        token: hr.memberToken,
      }
    );
    expect(read.status).toBe(403);
    expect(read.body).not.toHaveProperty('record');
    const canvas = await call(
      'canvas',
      'GET',
      `/api/hearing/${id}/canvas?tenant=personal`,
      { session: id },
      {
        token: hr.memberToken,
      }
    );
    expect(canvas.status).toBe(403);
    const write = await call(
      'answer',
      'POST',
      `/api/hearing/${id}/answer?tenant=personal`,
      { session: id },
      {
        token: hr.memberToken,
        body: { text: 'goal: overwritten' },
      }
    );
    expect(write.status).toBe(403);
  });

  it('refuses the owner without the attested loopback peer a write (step-up), but still lets it read', async () => {
    const id = sessionId();
    const write = await call(
      'answer',
      'POST',
      `/api/hearing/${id}/answer?tenant=personal`,
      { session: id },
      {
        peer: false,
        body: { text: 'goal: from another machine' },
      }
    );
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ error_code: 'installation_step_up_required' });
    const read = await call(
      'record',
      'GET',
      `/api/hearing/${id}?tenant=personal`,
      { session: id },
      {
        peer: false,
      }
    );
    expect(read.status).toBe(200);
    expect(read.body.persisted).toBe(false);
  });

  it('carries the personal selection on canvas_url so the follow-up opens the same store', async () => {
    const id = sessionId();
    const answer = await call(
      'answer',
      'POST',
      `/api/hearing/${id}/answer?tenant=personal`,
      {
        session: id,
      },
      { body: { text: 'goal: my canvas' } }
    );
    expect(answer.status).toBe(200);
    const canvasUrl = String(answer.body.canvas_url);
    expect(canvasUrl).toBe(
      `/api/hearing/${id}/canvas?scenario_id=web_app_build&version=v1&locale=en&tenant=personal`
    );
    const canvas = await call('canvas', 'GET', canvasUrl, { session: id });
    expect(canvas.status).toBe(200);
    expect(canvas.headers.get('content-type')).toContain('text/html');
    const read = await call('record', 'GET', `/api/hearing/${id}?tenant=personal`, { session: id });
    expect(read.body.canvas_url).toBe(canvasUrl);
    // The member who is not the owner is refused the same URL.
    const member = await call(
      'canvas',
      'GET',
      canvasUrl,
      { session: id },
      { token: hr.memberToken }
    );
    expect(member.status).toBe(403);
  });

  it('serves one personal namespace: a viewer without a single tenant reaches the same record', async () => {
    vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '1');
    hr.owner.resetInstallationBootstrapCache();
    try {
      const id = sessionId();
      // The credential-free local operator (escape hatch, no server tenant): no selection.
      const answer = await call(
        'answer',
        'POST',
        `/api/hearing/${id}/answer`,
        { session: id },
        {
          token: null,
          body: { text: 'goal: no selection' },
        }
      );
      expect(answer.status).toBe(200);
      const canvasUrl = String(answer.body.canvas_url);
      expect(canvasUrl).toBe(
        `/api/hearing/${id}/canvas?scenario_id=web_app_build&version=v1&locale=en`
      );
      const canvas = await call('canvas', 'GET', canvasUrl, { session: id }, { token: null });
      expect(canvas.status).toBe(200);
      // The signed-in owner's personal view is the same store and the same version.
      const owner = await call('record', 'GET', `/api/hearing/${id}?tenant=personal`, {
        session: id,
      });
      expect(owner.status).toBe(200);
      expect(owner.body.persisted).toBe(true);
      expect((owner.body.record as { canvas_versions: string[] }).canvas_versions).toEqual(['v1']);
      const ownerCanvas = await call('canvas', 'GET', String(owner.body.canvas_url), {
        session: id,
      });
      expect(ownerCanvas.status).toBe(200);
      expect(ownerCanvas.text).toBe(canvas.text);
    } finally {
      vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '');
      hr.owner.resetInstallationBootstrapCache();
    }
  });

  it('keys hand-off snapshots by the store it opens: the personal view and the no-tenant viewer agree', async () => {
    vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '1');
    hr.owner.resetInstallationBootstrapCache();
    try {
      const id = sessionId();
      const namespace = hr.runtime.hearingNamespace('all');
      let record = createHearingRecord(id, '2026-11-08T00:00:00.000Z');
      for (const item of record.requirements)
        record = applyHearingTurn(
          record,
          { text: `answer for ${item.id}`, request_id: `turn-${item.id}` },
          '2026-11-08T00:00:00.000Z'
        );
      hr.authority.withExecutionContext('ecosystem_architect', () =>
        hr.runtime.saveHearingRecord(namespace, {
          ...record,
          decided_by: { kind: 'human', id: 'user:owner', role: 'owner' },
          decided_at: '2026-11-08T00:00:00.000Z',
        })
      );
      const token = async (query: string) => {
        const res = await call(
          'record',
          'GET',
          `/api/hearing/${id}${query}`,
          { session: id },
          {
            token: null,
          }
        );
        expect(res.status, query).toBe(200);
        return (res.body.record as { handoff_snapshot?: unknown }).handoff_snapshot;
      };
      const plain = await token('');
      expect(plain).toEqual({ version: 1, token: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(await token('?tenant=personal')).toEqual(plain);
    } finally {
      vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '');
      hr.owner.resetInstallationBootstrapCache();
    }
  });
});
