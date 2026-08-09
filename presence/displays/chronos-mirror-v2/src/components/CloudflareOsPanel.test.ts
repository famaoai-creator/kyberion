import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('Chronos Cloudflare OS panel contract', () => {
  it('uses the read-only scoped route and does not expose mutation controls', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'presence/displays/chronos-mirror-v2/src/components/CloudflareOsPanel.tsx'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('fetch(`/api/os/control-plane${query}`');
    expect(source).toContain('AbortController');
    expect(source).toContain('requestSequence');
    expect(source).toContain("uxText('chronos_os_control_plane'");
    expect(source).toContain('!response.ok || payload.ok === false');
    expect(source).not.toContain('/decision');
    expect(source).not.toContain('/apply');
    expect(source).not.toContain('applyError');
  });
});
