import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  loadMediaThemeRolePolicyCatalog,
  resolveThemeColorRole,
  resolveThemeHexRole,
} from './media-theme-role-policy.js';

describe('media-theme-role-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/media-theme-role-policy.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_POLICY');
  });

  it('resolves theme roles from knowledge', () => {
    const catalog = loadMediaThemeRolePolicyCatalog();

    expect(catalog.theme_color_roles.accent).toBe('accent');
    expect(resolveThemeColorRole('accent', 'fallback')).toBe('accent');
    expect(resolveThemeHexRole('success', '#000000')).toBe('success');
  });
});
