import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

describe('Presence Studio OS control-plane route contract', () => {
  it('resolves server-side authority and propagates it to every OS operation', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');

    expect(source).toContain('resolvePresenceStudioViewerContext(req)');
    expect(source).toContain('cloudflareOsSurface.snapshot(');
    expect(source).toContain("res.setHeader('Cache-Control', 'private, no-store')");
    expect(source).toContain(
      "typeof rawMissionId === 'string' ? rawMissionId : undefined,\n      access"
    );
    expect(source).toContain('decideHeldAction(actionId, decision, access)');
    expect(source).toContain('applyHeldAction(actionId, access)');
    expect(source).toContain('res.status(502).json({');
    expect(source).not.toContain('error: error?.message || String(error)');
  });

  it('keeps the operator UI aware of failure status and external-effect confirmation', () => {
    const source = readRepoFile('presence/displays/presence-studio/static/index.html');

    expect(source).toContain('id="os-control-plane-status"');
    expect(source).toContain('function fetchOsMutation(url, options)');
    expect(source).toContain('if (!response.ok || body.ok === false)');
    expect(source).toContain('if (!osControlPlaneResponse.ok || osControlPlaneBody?.ok === false)');
    expect(source).toContain('window.confirm(uiText(');
    expect(source).toContain('item.failureRecorded');
    expect(source).not.toContain('item.applyError');
  });
});
