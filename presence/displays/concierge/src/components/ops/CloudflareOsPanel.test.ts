import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('Chronos Cloudflare OS panel contract', () => {
  it('uses the read-only scoped route and does not expose mutation controls', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'presence/displays/concierge/src/components/ops/CloudflareOsPanel.tsx'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('fetch(opsApiPath(`/os/control-plane${query}`)');
    expect(source).toContain('AbortController');
    expect(source).toContain('requestSequence');
    expect(source).toContain("uxText('chronos_os_control_plane'");
    expect(source).toContain('parseCloudflareOsResponse');
    expect(source).toContain('payload.snapshot.heldActions');
    expect(source).not.toContain('/decision');
    expect(source).not.toContain('/apply');
    expect(source).not.toContain('applyError');
  });
});
