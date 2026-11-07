/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FRONT_DESK_HELP_LINK,
  FRONT_DESK_LINKED_DESTINATIONS,
  resolveFrontDeskDestination,
} from '@agent/core/front-desk-nav';
import { buildFrontDeskNavPayload } from '../src/lib/front-desk-nav';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(appDir, relativePath), 'utf8');

const HELP_SOURCES = [
  'src/app/help/help-page.tsx',
  'src/app/help/help-links.ts',
  'src/app/help/page.tsx',
  'src/app/help/[track]/page.tsx',
  'src/lib/help-view.ts',
];

// Carried over from presence-studio's FD-08 help page static contract when
// the page moved to Concierge (Kyberion server phase 2).
describe('使い方 page (/help) contract', () => {
  it('is served by Concierge: the rail help link and the linked destination are same-origin', () => {
    expect(FRONT_DESK_HELP_LINK.surface).toBe('concierge');
    expect(FRONT_DESK_LINKED_DESTINATIONS.find((item) => item.id === 'help')?.surface).toBe(
      'concierge'
    );
    const payload = buildFrontDeskNavPayload({
      locale: 'ja',
      role: 'viewer',
      ports: { concierge: 3050, 'presence-studio': 3031 },
    });
    expect(payload.help.href).toBe('/help');
    expect(resolveFrontDeskDestination('help', { currentSurface: 'concierge' })?.href).toBe(
      '/help'
    );
  });

  it('never opens a new tab, hardcodes a loopback host or port, or shows internal vocabulary', () => {
    const combined = HELP_SOURCES.map(read).join('\n');
    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    expect(combined).not.toMatch(/\b30(31|50)\b/);
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(combined)).toBe(false);
    const page = read('src/app/help/help-page.tsx');
    // Every fixed string comes from the vocabulary catalog.
    expect(/[぀-ヿ一-鿿]/u.test(page.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, ''))).toBe(false);
  });

  it('reads the catalog and only the viewer’s own progress, and marks a lesson through /api/training/me', () => {
    const page = read('src/app/help/help-page.tsx');
    expect(page).toContain("fetch('/api/training/catalog'");
    expect(page).toContain("fetch('/api/training/me'");
    expect(page).toContain("method: 'POST'");
    expect(page).toContain("status: 'complete'");
    expect(page).toContain('frontDeskFetch as fetch');
    expect(page).not.toContain('member_id');
  });
});
