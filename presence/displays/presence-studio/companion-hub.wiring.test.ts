import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

describe('companion hub surface wiring', () => {
  it('routes hub pages from presence-studio runtime data', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'presence/displays/presence-studio/presence-studio-runtime-data.ts'
        ),
        { encoding: 'utf8' }
      )
    );
    expect(source).toContain("sendFile(path.join(staticDir, 'hub.html'))");
    expect(source).toContain("sendFile(path.join(staticDir, 'learn.html'))");
    expect(source).toContain("sendFile(path.join(staticDir, 'discover.html'))");
    expect(source).toContain("app.get('/work'");
    expect(source).toContain('/api/companion/learn');
    expect(source).toContain('/api/companion/discover');
  });

  it('keeps OAuth begin on Concierge setup ownership', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/concierge/src/app/api/oauth/begin/route.ts'),
        { encoding: 'utf8' }
      )
    );
    expect(source).toContain('beginInteractiveServiceOAuth');
    expect(source).toContain('oauth_callback_surface');
    expect(source).toContain('requireConciergeMutationAccess');
  });
});
