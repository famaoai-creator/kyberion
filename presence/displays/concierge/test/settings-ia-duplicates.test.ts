import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

const redirect = vi.fn((url: string) => {
  throw Object.assign(new Error('NEXT_REDIRECT'), { url });
});
vi.mock('next/navigation', () => ({ permanentRedirect: redirect }));

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) =>
  String(safeReadFile(path.join(appDir, file), { encoding: 'utf8' }) ?? '');

/** MSN-SHELL-IA-20261105 §4: one place per setting; old entry points redirect or link. */
describe('settings IA: single homes and redirects', () => {
  it('/setup/sso redirects to the SSO card and keeps the IdP callback query', async () => {
    const { default: page } = await import('../src/app/setup/sso/page');
    await expect(page({ searchParams: Promise.resolve({ linked: '1' }) })).rejects.toThrow(
      'NEXT_REDIRECT'
    );
    expect(redirect).toHaveBeenLastCalledWith('/settings?linked=1#settings-sso');
    await expect(page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenLastCalledWith('/settings#settings-sso');
  });

  it('decides approvals only in /inbox: settings governance shows the count and a link', () => {
    const governance = read('src/app/settings/sections/GovernanceSection.tsx');
    expect(governance).toContain('<NeedsYouLink reason="approval"');
    expect(governance).not.toContain('decideWithPasskey');
    expect(governance).not.toContain('pending_approvals');
  });

  it('keeps the unclaimed-install bootstrap at /setup/first-run', () => {
    expect(safeExistsSync(path.join(appDir, 'src/app/setup/first-run/page.tsx'))).toBe(true);
    expect(read('src/app/setup/first-run/page.tsx')).not.toContain('redirect(');
  });

  it('chooses the reasoning engine and model in one card only', () => {
    expect(read('src/app/settings/sections/ServicesSection.tsx')).not.toContain(
      '<ReasoningSection'
    );
    const advanced = read('src/app/settings/sections/AdvancedSection.tsx');
    expect(advanced).not.toContain("'management.agent_provider'");
    expect(advanced).not.toContain("'management.agent_model_id'");
    expect(advanced).toContain("onJumpToSection('#settings-reasoning')");
    expect(read('src/components/ops/AgentPanel.tsx')).toContain('/settings#settings-reasoning');
    const page = read('src/app/settings/page.tsx');
    expect(page.match(/<ReasoningSection/g)).toHaveLength(1);
  });

  it('renders language and theme once inside settings (the 表示 card), not nested in profile', () => {
    const page = read('src/app/settings/page.tsx');
    expect(page.match(/<DisplaySection/g)).toHaveLength(1);
    const profileCase = page.slice(
      page.indexOf("case 'setup-profile':"),
      page.indexOf("case 'settings-members':")
    );
    expect(profileCase).not.toContain('<DisplaySection');
  });

  it('links the company setup page back to its settings card', () => {
    expect(read('src/app/setup/company/page.tsx')).toContain('/settings#settings-company');
    expect(read('src/app/settings/sections/MembersSection.tsx')).toContain(
      '/settings#settings-sso'
    );
  });

  it('serves the checklist through the shared v1 route with concierge charter mediation only', () => {
    const route = read('src/app/api/v1/[...operation]/route.ts');
    expect(route).toContain(
      "...(id === 'setup.checklist' ? { setupReaders: conciergeSetupChecklistReaders } : {})"
    );
    const readers = read('src/lib/setup-checklist-server.ts');
    expect(readers).toContain("withExecutionContext('sovereign_concierge'");
    expect(readers.match(/withExecutionContext\(/g)).toHaveLength(1);
  });
});
