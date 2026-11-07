import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { iaListHref, resolveIaRedirect, resolveIaTab, IA_WORK_TABS } from './ia-routes';
import { proxy } from '../proxy';

describe('MSN-SHELL-IA §1 redirects', () => {
  it.each([
    ['/w', '', '/'],
    ['/w/', '', '/'],
    ['/w/mission', '', '/work'],
    ['/w/task', '', '/work'],
    ['/w/work_item', '', '/work?tab=items'],
    ['/w/approval', '', '/inbox'],
    ['/w/organization', '', '/org'],
    ['/w/tenant', '', '/org'],
    ['/w/project', '', '/org?tab=projects'],
    ['/w/actor', '', '/org?tab=people'],
    ['/ops', '?section=approvals', '/inbox'],
    ['/ops', '?section=governance', '/inbox'],
    ['/ops', '?section=home', '/'],
    ['/ops', '?section=missions', '/work'],
    ['/ops', '?section=work-items', '/work?tab=items'],
    ['/ops', '?section=organization', '/org'],
    ['/ops', '?section=deliverables', '/library'],
    ['/ops', '?section=knowledge', '/library?tab=knowledge'],
    ['/ingest', '', '/library?tab=ingest'],
    ['/setup', '', '/settings'],
  ])('%s%s -> %s', (path, search, expected) => {
    expect(resolveIaRedirect(path, search)).toBe(expected);
  });

  it('preserves the query and drops only the retired section', () => {
    expect(resolveIaRedirect('/w/mission', '?tenant=acme&status=active')).toBe(
      '/work?tenant=acme&status=active'
    );
    expect(resolveIaRedirect('/ops', '?section=knowledge&tenant=acme&project_id=p1')).toBe(
      '/library?tenant=acme&project_id=p1&tab=knowledge'
    );
    expect(resolveIaRedirect('/ops', '?section=missions&mission=MSN-A-1&tenant=acme')).toBe(
      '/w/mission/MSN-A-1?tenant=acme'
    );
    expect(resolveIaRedirect('/ops', '?section=missions&mission=../x')).toBe(
      '/work?mission=..%2Fx'
    );
    // The target names the tab even when the old URL carried another one.
    expect(resolveIaRedirect('/w/work_item', 'tab=missions&q=x')).toBe('/work?tab=items&q=x');
  });

  it('leaves detail pages, remaining ops sections and new routes alone', () => {
    for (const [path, search] of [
      ['/w/mission/MSN-1', ''],
      ['/w/task/MSN-1%2Ft1', ''],
      ['/w/unknown', ''],
      ['/ops', ''],
      ['/ops', '?section=operations'],
      ['/ops', '?section=diagnostics'],
      ['/ops', '?section=surface-control'],
      ['/ops', '?section=discussion'],
      ['/ops/discussion', ''],
      ['/setup/sso', ''],
      ['/setup/first-run', ''],
      ['/', ''],
      ['/work', ''],
      ['/api/v1/workspace/list', ''],
    ]) {
      expect(resolveIaRedirect(path, search), path + search).toBeNull();
    }
  });

  it('answers a retired route with 308 before any login bounce', () => {
    const res = proxy(
      new NextRequest('https://app.example/ops?section=approvals&tenant=acme', {
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      })
    );
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://app.example/inbox?tenant=acme');
  });

  it('maps list kinds to their new hrefs and resolves tabs', () => {
    expect(iaListHref('mission')).toBe('/work');
    expect(iaListHref('actor')).toBe('/org?tab=people');
    expect(iaListHref('nope')).toBeNull();
    expect(resolveIaTab(IA_WORK_TABS, 'items')).toBe('items');
    expect(resolveIaTab(IA_WORK_TABS, 'requests')).toBe('requests');
    expect(resolveIaTab(IA_WORK_TABS, 'bogus')).toBe('missions');
    expect(resolveIaTab(IA_WORK_TABS, null)).toBe('missions');
  });
});
