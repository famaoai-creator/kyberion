import { describe, expect, it, vi } from 'vitest';
import type express from 'express';
import {
  buildCorrectionContext,
  registerCorrectionContextRoute,
  type CorrectionContextDependencies,
} from './correction-context.js';
import { PresenceStudioViewerError, type PresenceStudioViewerContext } from './security.js';

const viewer: PresenceStudioViewerContext = {
  principalId: 'human:test',
  tenantSlugs: ['alpha'],
  source: 'loopback',
};
const entry = {
  entry_id: 'entry-1',
  artifact_paths: ['exact/file.md'],
  title: 'Report',
  verdict_note: 'Fix the total',
  status: 'rejected',
  tenant_slug: 'alpha',
  mission_id: 'private-mission',
  reviewed_by: 'private-reviewer',
};
const artifact = { artifact_id: 'artifact-1', path: 'exact/file.md', tenant_slug: 'alpha' };
function build(
  entries: Parameters<typeof buildCorrectionContext>[0]['entries'] = [entry],
  artifacts: Parameters<typeof buildCorrectionContext>[0]['artifacts'] = [artifact],
  scope = viewer
) {
  return buildCorrectionContext({
    entryId: 'entry-1',
    artifactId: 'artifact-1',
    entries,
    artifacts,
    viewer: scope,
  });
}

describe('correction context identity and scope', () => {
  it('returns only saved feedback and exact identities without mutating input', () => {
    const original = structuredClone({ entry, artifact });
    expect(build()).toEqual({
      entry_id: 'entry-1',
      artifact_id: 'artifact-1',
      title: 'Report',
      note: 'Fix the total',
      status: 'rejected',
    });
    expect({ entry, artifact }).toEqual(original);
  });
  it('also permits changes_requested and an empty saved note', () => {
    expect(build([{ ...entry, status: 'changes_requested', verdict_note: '' }])?.status).toBe(
      'changes_requested'
    );
  });
  it.each(['unread', 'read', 'accepted', 'unknown'])(
    'rejects stale/non-feedback status %s',
    (status) => {
      expect(build([{ ...entry, status }])).toBeNull();
    }
  );
  it('requires both exact IDs and the exact nonempty path relation', () => {
    expect(build([], [artifact])).toBeNull();
    expect(build([entry], [])).toBeNull();
    expect(build([{ ...entry, entry_id: 'artifact-1' }])).toBeNull();
    expect(build([entry], [{ ...artifact, artifact_id: 'entry-1' }])).toBeNull();
    expect(build([entry], [{ ...artifact, path: './exact/file.md' }])).toBeNull();
    expect(build([entry], [{ ...artifact, path: '' }])).toBeNull();
  });
  it('fails closed on duplicate identities', () => {
    expect(build([entry, entry])).toBeNull();
    expect(build([entry], [artifact, artifact])).toBeNull();
  });
  it('honors canonical organization and project scope on both sides', () => {
    const scope = { ...viewer, organizationIds: ['org-1'], projectIds: ['project-1'] };
    const context = { tenant_slug: 'alpha', organization_id: 'org-1', project_id: 'project-1' };
    const scopedEntry = { ...entry, ...context };
    const scopedArtifact = { ...artifact, ...context };
    expect(build([scopedEntry], [scopedArtifact], scope)).not.toBeNull();
    expect(build([{ ...scopedEntry, project_id: 'other' }], [scopedArtifact], scope)).toBeNull();
    expect(
      build([scopedEntry], [{ ...scopedArtifact, organization_id: 'other' }], scope)
    ).toBeNull();
  });
  it('checks each record independently against current viewer scope', () => {
    expect(build([{ ...entry, tenant_slug: 'beta' }])).toBeNull();
    expect(build([entry], [{ ...artifact, tenant_slug: 'beta' }])).toBeNull();
    expect(build([entry], [artifact], { ...viewer, organizationIds: ['org-1'] })).toBeNull();
    expect(build([entry], [artifact], { ...viewer, projectIds: ['project-1'] })).toBeNull();
  });
});

function harness(overrides: Partial<CorrectionContextDependencies> = {}) {
  let handler: express.RequestHandler | undefined;
  const app = {
    get: vi.fn((_path: string, fn: express.RequestHandler) => {
      handler = fn;
    }),
  };
  const deps: CorrectionContextDependencies = {
    resolveViewer: vi.fn(() => viewer),
    readEntries: vi.fn(() => [entry]),
    readArtifacts: vi.fn(() => [artifact]),
    ...overrides,
  };
  registerCorrectionContextRoute(app as unknown as express.Express, deps);
  const invoke = (query: Record<string, unknown> = { entry: 'entry-1' }) => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    handler!(
      { params: { artifactId: 'artifact-1' }, query } as unknown as express.Request,
      res as unknown as express.Response,
      vi.fn()
    );
    return res;
  };
  return { app, deps, invoke };
}

describe('read-only correction context route', () => {
  it('registers only GET and returns minimal no-store context with current viewer identity', () => {
    const h = harness();
    const res = h.invoke({ entry: 'entry-1', tenant: 'alpha', locale: 'ja' });
    expect(h.app.get).toHaveBeenCalledWith(
      '/api/progress/:artifactId/correction-context',
      expect.any(Function)
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      context: build(),
      viewer_scope_id: expect.any(String),
    });
    expect(h.deps.readEntries).toHaveBeenCalledWith('entry-1');
  });
  it.each([{}, { entry: ['entry-1', 'entry-2'] }, { entry: { id: 'entry-1' } }])(
    'rejects malformed selectors before reading data',
    (query) => {
      const h = harness();
      const res = h.invoke(query);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(h.deps.readEntries).not.toHaveBeenCalled();
    }
  );
  it.each([{ tenant: ['alpha'] }, { organizationId: { id: 'org-1' } }, { projectId: '' }])(
    'does not discard malformed narrowing selectors',
    (query) => {
      const h = harness();
      const res = h.invoke({ entry: 'entry-1', ...query });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(h.deps.readEntries).not.toHaveBeenCalled();
    }
  );
  it('denies widening before data reads and does not echo sensitive details', () => {
    const h = harness();
    const res = h.invoke({ entry: 'entry-1', tenant: 'beta' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(h.deps.readEntries).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'correction_context_denied' });
  });
  it('uses current authentication even with known IDs', () => {
    const h = harness({
      resolveViewer: () => {
        throw new PresenceStudioViewerError(401, 'private reason');
      },
    });
    const res = h.invoke();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(h.deps.readEntries).not.toHaveBeenCalled();
  });
  it('does not expose missing, mismatched, denied or stale records', () => {
    for (const entries of [
      [],
      [{ ...entry, tenant_slug: 'beta' }],
      [{ ...entry, status: 'accepted' }],
      [{ ...entry, artifact_paths: ['other'] }],
    ]) {
      const h = harness({ readEntries: () => entries });
      const res = h.invoke();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'correction_context_unavailable' });
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    }
  });
  it('hides internal store failure details', () => {
    const h = harness({
      readArtifacts: () => {
        throw new Error('/private/store/path');
      },
    });
    const res = h.invoke();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'correction_context_unavailable' });
  });
});
