import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_APP_REQUIREMENTS,
  buildDiscoverDraft,
  discoverDraftPath,
  discoverScopeKey,
  loadCompanionLearnCatalog,
  saveDiscoverDraft,
  readDiscoverDraft,
} from './companion-hub.js';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as path from 'node:path';

describe('companion hub', () => {
  it('loads the learn catalog with gallery and guides', () => {
    const catalog = loadCompanionLearnCatalog();
    expect(catalog.gallery.length).toBeGreaterThan(0);
    expect(catalog.guides.length).toBeGreaterThan(0);
    expect(catalog.gallery[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      summary: expect.any(String),
      kind: expect.any(String),
    });
  });

  it('builds the default web-app discover template', () => {
    const draft = buildDiscoverDraft({ site_url: 'https://example.com', notes: 'demo' });
    expect(draft.scenario).toBe('web_app_build');
    expect(draft.site_url).toBe('https://example.com');
    expect(draft.requirements).toEqual(DEFAULT_WEB_APP_REQUIREMENTS);
    expect(draft.alignment_hint).toContain('8137');
    expect(() => buildDiscoverDraft({ site_url: 'javascript:alert(1)' })).toThrow(
      'site_url must use http or https'
    );
  });

  it('keeps discover drafts separated by server-resolved viewer scope', () => {
    const tenantA = discoverScopeKey({ principalId: 'human:a', tenantSlugs: ['tenant-a'] });
    const tenantB = discoverScopeKey({ principalId: 'human:a', tenantSlugs: ['tenant-b'] });
    expect(discoverDraftPath('current', tenantA)).not.toBe(discoverDraftPath('current', tenantB));
  });

  it('saves and reads a discover draft under shared tmp', () => {
    const sessionId = `test-${Date.now()}`;
    const saved = saveDiscoverDraft({
      session_id: sessionId,
      site_url: 'https://example.org',
      notes: 'hearing note',
      requirements: DEFAULT_WEB_APP_REQUIREMENTS.map((item, index) => ({
        ...item,
        checked: index === 0,
      })),
    });
    expect(safeExistsSync(saved.path)).toBe(true);
    const loaded = readDiscoverDraft(sessionId);
    expect(loaded?.site_url).toBe('https://example.org');
    expect(loaded?.requirements[0]?.checked).toBe(true);
    safeRmSync(saved.path, { force: true });
    const dir = pathResolver.sharedTmp('companion-discover');
    // Keep the directory; only remove the test file.
    void path.join(dir, 'keep');
  });
});
