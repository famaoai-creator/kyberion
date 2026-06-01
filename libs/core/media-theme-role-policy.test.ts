import { describe, expect, it } from 'vitest';
import {
  loadMediaThemeRolePolicyCatalog,
  resolveThemeColorRole,
  resolveThemeHexRole,
} from './media-theme-role-policy.js';

describe('media-theme-role-policy', () => {
  it('resolves theme roles from knowledge', () => {
    const catalog = loadMediaThemeRolePolicyCatalog();

    expect(catalog.theme_color_roles.accent).toBe('accent');
    expect(resolveThemeColorRole('accent', 'fallback')).toBe('accent');
    expect(resolveThemeHexRole('success', '#000000')).toBe('success');
  });
});
