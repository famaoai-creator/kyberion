import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';
import {
  FRONT_DESK_LINKED_DESTINATIONS,
  resolveFrontDeskDestination,
} from '@agent/core/front-desk-nav';
import { resolveHelpLinks } from '../src/app/help/help-links';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) =>
  String(safeReadFile(path.join(appDir, relativePath), { encoding: 'utf8' }));
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');

const SOURCES = [
  'src/app/work/requests-panel.tsx',
  'src/app/work/page.tsx',
  'src/lib/requests-view.ts',
  'src/lib/progress-request.ts',
  'src/lib/progress-server.ts',
  'src/app/api/progress/route.ts',
  'src/app/api/progress/[id]/route.ts',
  'src/app/work/work-inventory-panel.tsx',
  'src/lib/work-inventory-panel.ts',
  'src/app/api/work-inventory/candidates/route.ts',
];

// Carried over from presence-studio's FD-05 進み具合 static contract when the
// page moved to Concierge 仕事 › 依頼 (Kyberion server phase 2).
describe('仕事 › 依頼 (/work?tab=requests) contract', () => {
  it('is the progress destination on Concierge, so the dock and 使い方 follow it', () => {
    expect(FRONT_DESK_LINKED_DESTINATIONS.find((item) => item.id === 'progress')).toMatchObject({
      surface: 'concierge',
      path: '/work?tab=requests',
    });
    expect(resolveFrontDeskDestination('progress', { currentSurface: 'concierge' })?.href).toBe(
      '/work?tab=requests'
    );
    expect(resolveHelpLinks().progress).toBe('/work?tab=requests');
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain("resolveFrontDeskDestination('progress'");
    expect(layout).not.toContain("'/progress'");
    const dock = read('src/app/conversation-dock.tsx');
    expect(dock).toContain('requestLinkHref(progressHref');
    expect(dock).not.toContain("'?request='");
  });

  it('never opens a new tab, hardcodes a loopback host or port, or inlines copy', () => {
    const combined = SOURCES.map(read).join('\n');
    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    expect(combined).not.toMatch(/\b30(31|40|50)\b/);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(combined)).toBe(false);
    for (const file of [
      'src/app/work/requests-panel.tsx',
      'src/lib/requests-view.ts',
      'src/app/work/work-inventory-panel.tsx',
    ]) {
      expect(/[぀-ヿ一-鿿]/u.test(withoutComments(read(file))), file).toBe(false);
    }
  });

  it('decides nothing: delivered items link to 受信箱, with no accept / reject on this page', () => {
    const panel = withoutComments(read('src/app/work/requests-panel.tsx'));
    expect(panel).not.toMatch(/verdict|action_receive|action_revise|accepted'|rejected'/);
    expect(panel).not.toMatch(/method:\s*'POST'/);
    expect(panel).toContain('withSelectedTenant(REQUESTS_INBOX_PATH');
    expect(panel).toContain("t('ia_work_requests_inbox_decide')");
    // Only for a viewer who can open 受信箱 (the rail's own access answer).
    expect(panel).toContain('needsInboxDecision(item) && canOpenInbox');
    expect(panel).toContain('parseHelpAccess(body).inbox');
    expect(panel).toContain('React.useState(false)');
    expect(panel).toContain('frontDeskFetch as fetch');
  });

  it('is accessible: real headings, buttons for selection, the selected row marked, one live region', () => {
    const panel = withoutComments(read('src/app/work/requests-panel.tsx'));
    expect(panel).toContain('<button');
    expect(panel).toContain("aria-current={current ? 'true' : undefined}");
    expect(panel).toMatch(/<h2[\s\S]*?id="request-detail-heading"/);
    expect(panel).toContain('<h3');
    expect(panel.match(/role="status"/g)).toHaveLength(1);
    expect(panel).not.toContain('aria-live');
    // The phase estimate is labelled as one.
    expect(panel).toContain("ft('progress_phase_estimate')");
    expect(panel).toContain("t('ia_work_requests_percent'");
  });

  it('is where the work-inventory hearing hands off: the tab shows 業務の自動化候補', () => {
    const fromStudio = resolveFrontDeskDestination('progress', {
      currentSurface: 'presence-studio',
      urls: { concierge: 'https://desk.example.test' },
    });
    expect(fromStudio?.href).toBe('https://desk.example.test/work?tab=requests');
    const hearing = read('../presence-studio/hearing-routes.ts');
    expect(hearing).toMatch(/resolveFrontDeskDestination\('progress'/);
    const page = read('src/app/work/page.tsx');
    expect(page).toMatch(/tab === 'requests' \? \(\s*<RequestsPanel \/>/);
    const panel = read('src/app/work/requests-panel.tsx');
    expect(panel).toContain('<WorkInventoryPanel search={search} />');
    const inventory = read('src/app/work/work-inventory-panel.tsx');
    expect(inventory).toContain("ft('progress_work_inventory_title')");
    expect(inventory).toContain('workInventoryPanelPath(params)');
    // A personal-scope save: the hand-off selects the personal view, where the
    // panel lists the local owner's own personal inventory.
    const handoff = read('../presence-studio/work-inventory-routes.ts');
    expect(handoff).toContain("url.searchParams.set('tenant', CONCIERGE_PERSONAL_SELECTION)");
    expect(hearing).toContain(
      'workInventoryHandoffHref(hearingScopedUrl(progressItem.href, viewer)'
    );
    const candidates = read('src/app/api/work-inventory/candidates/route.ts');
    expect(candidates).toContain("const personalView = resolved.selection.mode === 'personal'");
    // The owner is the installation owner, never the credential source.
    expect(candidates).toContain(
      "resolveConciergeInstallationAccess(resolved.viewer, 'read', req)"
    );
    expect(inventory).toContain("t('ia_work_requests_inventory_choose_company')");
  });

  it('computes tenant-dependent hrefs after mount and wraps long text at 390px', () => {
    const panel = read('src/app/work/requests-panel.tsx');
    expect(panel).toMatch(
      /React\.useEffect\(\(\) => \{\s*setInboxHref\(withSelectedTenant\(REQUESTS_INBOX_PATH/
    );
    const css = read('src/app/work/requests.css');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/i);
    for (const selector of [
      '.requests-row__title',
      '.requests-row__meta',
      '.requests-text',
      '.requests-heading',
    ]) {
      const block = css.match(new RegExp(`\\${selector} \\{([\\s\\S]*?)\\}`))?.[1] ?? '';
      expect(block, selector).toContain('overflow-wrap: anywhere');
    }
    expect(css).toContain('grid-template-columns: minmax(0, 1fr);');
  });
});
