// PA-05 review layer browser helpers (review-layer-client.js): the served kit
// URL is pinned to the page origin (a report's `<base href>` cannot redirect
// the import), and local snapshots are keyed per report.
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { sameOriginModuleUrl, snapshotKeys } from './review-layer-client.js';
import { buildReviewLayerData, reviewLayerReportId } from './review-layer.js';

const LOCAL = { origin: 'http://127.0.0.1:8137', pathname: '/' };

describe('sameOriginModuleUrl', () => {
  it('resolves the renderer path against the page origin, not the document base', () => {
    const renderer = String(buildReviewLayerData({ assets: 'served' }).renderer);
    expect(sameOriginModuleUrl(renderer, LOCAL)).toBe(
      'http://127.0.0.1:8137/shared-ui/kyberion-ui.js'
    );
  });

  it('rejects anything that is not a same-origin absolute path', () => {
    for (const value of [
      'https://other.example/shared-ui/kyberion-ui.js',
      '//other.example/x.js',
      'shared-ui/kyberion-ui.js',
      './kyberion-ui.js',
      'javascript:alert(1)',
      42,
      undefined,
    ]) {
      expect(sameOriginModuleUrl(value, LOCAL), String(value)).toBeNull();
    }
    expect(sameOriginModuleUrl('/x.js', { origin: 'null' })).toBeNull();
  });

  it('the layer never imports the renderer value as-is', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/report-review/review-layer-client.js'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/import\(\s*data\.renderer\s*\)/);
    expect(source).toContain('sameOriginModuleUrl(data.renderer, window.location)');
  });
});

describe('snapshotKeys', () => {
  it('keys by the report id; the shared server root never falls back to rvedit:/', () => {
    const a = reviewLayerReportId('reports/a.html');
    const b = reviewLayerReportId('reports/b.html');
    expect(a).toMatch(/^[a-f0-9]{16}$/);
    expect(a).not.toBe(b);
    expect(snapshotKeys({ reportId: a }, LOCAL)).toEqual({ key: `rvedit:${a}`, legacy: null });
    expect(snapshotKeys({ reportId: b }, LOCAL).key).not.toBe(
      snapshotKeys({ reportId: a }, LOCAL).key
    );
  });

  it('reads the legacy path key only where the path names this report (file://)', () => {
    const id = reviewLayerReportId('/abs/report.html');
    const file = { origin: 'null', pathname: '/abs/report.html' };
    expect(snapshotKeys({ reportId: id }, file)).toEqual({
      key: `rvedit:${id}`,
      legacy: 'rvedit:/abs/report.html',
    });
    // Old layers without an id keep their old key.
    expect(snapshotKeys({}, file)).toEqual({ key: 'rvedit:/abs/report.html', legacy: null });
    // A malformed id is ignored.
    expect(snapshotKeys({ reportId: '../x' }, file).key).toBe('rvedit:/abs/report.html');
  });

  it('the layer data carries the hashed id, never the raw identity', () => {
    const data = buildReviewLayerData({ reportId: 'knowledge/confidential/acme/report.html' });
    expect(data.reportId).toBe(reviewLayerReportId('knowledge/confidential/acme/report.html'));
    expect(JSON.stringify(data)).not.toContain('acme/report.html');
    expect(buildReviewLayerData({}).reportId).toBeUndefined();
  });
});
