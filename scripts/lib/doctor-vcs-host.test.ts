import { describe, expect, it, vi } from 'vitest';
import type { VcsHostSelection } from '@agent/core/vcs/vcs-host';
import { collectVcsHostDoctorLines } from './doctor-vcs-host.js';

const GH_SELECTED: VcsHostSelection = {
  selected: 'gh-cli',
  chain: ['gh-cli', 'github-rest'],
  source: 'builtin',
  candidates: [
    { id: 'gh-cli', registered: true, available: true },
    { id: 'github-rest', registered: true, available: false },
  ],
};

describe('doctor vcs-host section', () => {
  it('reports the selection offline and never probes auth by default', async () => {
    const authStatus = vi.fn(async () => {
      throw new Error('auth must not be probed without --vcs-auth');
    });
    const lines = await collectVcsHostDoctorLines({}, { inspect: () => GH_SELECTED, authStatus });
    expect(lines).toEqual([
      'VCS host: gh-cli (order: gh-cli → github-rest, source: builtin); gh-cli=available, github-rest=no GH_TOKEN; auth not probed (pass --vcs-auth)',
    ]);
    expect(authStatus).not.toHaveBeenCalled();
  });

  it('names a non-builtin source and the token-only provider', async () => {
    const lines = await collectVcsHostDoctorLines(
      {},
      {
        inspect: () => ({
          selected: 'github-rest',
          chain: ['github-rest', 'gh-cli'],
          source: 'env:KYBERION_SEAM_DEFAULTS',
          candidates: [
            { id: 'github-rest', registered: true, available: true },
            { id: 'gh-cli', registered: true, available: false },
          ],
        }),
      }
    );
    expect(lines[0]).toContain(
      'VCS host: github-rest (order: github-rest → gh-cli, source: env:KYBERION_SEAM_DEFAULTS)'
    );
    expect(lines[0]).toContain('github-rest=GH_TOKEN registered, gh-cli=gh not found');
  });

  it('says how to fix a host with no provider', async () => {
    const lines = await collectVcsHostDoctorLines(
      { probeAuth: true },
      {
        inspect: () => ({
          chain: ['gh-cli', 'github-rest', 'custom'],
          source: 'policy',
          candidates: [
            { id: 'gh-cli', registered: true, available: false },
            { id: 'github-rest', registered: true, available: false },
            { id: 'custom', registered: false, available: false },
          ],
        }),
        authStatus: vi.fn(),
      }
    );
    expect(lines).toEqual([
      'VCS host: none available (order: gh-cli → github-rest → custom, source: policy); gh-cli=gh not found, github-rest=no GH_TOKEN, custom=not registered — install gh or register GH_TOKEN (PR operations will fail)',
    ]);
  });

  it('probes the selected provider with --vcs-auth and reports success or the failure', async () => {
    const ok = vi.fn(async (provider: string) => ({ provider, ok: true }));
    expect(
      await collectVcsHostDoctorLines(
        { probeAuth: true },
        { inspect: () => GH_SELECTED, authStatus: ok }
      )
    ).toEqual([expect.stringMatching(/; auth ok$/u)]);
    expect(ok).toHaveBeenCalledWith('gh-cli', 10_000);

    const failed = vi.fn(async (provider: string) => ({ provider, ok: false, detail: 'auth' }));
    expect(
      (
        await collectVcsHostDoctorLines(
          { probeAuth: true },
          { inspect: () => GH_SELECTED, authStatus: failed }
        )
      )[0]
    ).toMatch(/; auth failed \(auth\)$/u);
  });

  it('bounds the auth probe with a timeout', async () => {
    const hung = vi.fn(() => new Promise<never>(() => {}));
    const lines = await collectVcsHostDoctorLines(
      { probeAuth: true },
      { inspect: () => GH_SELECTED, authStatus: hung, timeoutMs: 5 }
    );
    expect(lines[0]).toMatch(/; auth probe failed \(timed out after 5ms\)$/u);
  });

  it('degrades to a single line when inspection itself fails', async () => {
    const lines = await collectVcsHostDoctorLines(
      {},
      {
        inspect: () => {
          throw new Error('[VCS_CWD_SCOPE_DENIED] nope');
        },
      }
    );
    expect(lines).toEqual(['VCS host: inspection unavailable ([VCS_CWD_SCOPE_DENIED] nope)']);
  });
});
