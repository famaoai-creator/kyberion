import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { loadMobileAppProfileIndex, loadWebAppProfileIndex } from './app-profile-index-loader.js';

const profileResourceExists = (relativePath: string): boolean =>
  safeExistsSync(pathResolver.rootResolve(relativePath));

describe('app profile index loaders', () => {
  it('loads and validates the mobile profile index through the catalog boundary', () => {
    const index = loadMobileAppProfileIndex(
      pathResolver.knowledge('product/orchestration/mobile-app-profiles/index.json'),
      profileResourceExists
    );

    expect(index.profiles).toHaveLength(2);
    expect(index.profiles.every((profile) => ['android', 'ios'].includes(profile.platform))).toBe(
      true
    );
  });

  it('loads and validates the web profile index through the catalog boundary', () => {
    const index = loadWebAppProfileIndex(
      pathResolver.knowledge('product/orchestration/web-app-profiles/index.json'),
      profileResourceExists
    );

    expect(index.profiles).toHaveLength(1);
    expect(index.profiles[0]?.platform).toBe('browser');
  });
});
