import { describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  const { pathResolver } = await vi.importActual<typeof import('@agent/core/path-resolver')>(
    '@agent/core/path-resolver'
  );
  const personalThemePath = pathResolver.rootResolve(
    'knowledge/personal/design-patterns/media-templates/themes.json'
  );
  const personalThemeDir = pathResolver.rootResolve(
    'knowledge/personal/design-patterns/media-templates/themes'
  );
  const personalTheme = {
    version: '1.1.0',
    default_theme: 'test-roundtrip-theme',
    themes: {
      'test-roundtrip-theme': {
        name: 'Test Roundtrip Theme',
        colors: {
          primary: '#123456',
          secondary: '#234567',
          accent: '#345678',
          background: '#abcdef',
          text: '#112233',
        },
        fonts: {
          heading: 'Aptos, sans-serif',
          body: 'Aptos, sans-serif',
        },
      },
    },
  };
  return {
    ...actual,
    safeExistsSync: (targetPath: string) => {
      if (targetPath === personalThemePath) return true;
      if (targetPath === personalThemeDir) return false;
      return actual.safeExistsSync(targetPath);
    },
    safeReadFile: (targetPath: string, options?: { encoding?: string }) => {
      if (targetPath === personalThemePath) {
        return JSON.stringify(personalTheme);
      }
      return actual.safeReadFile(targetPath, options as any);
    },
    loadJson: <T>(targetPath: string) =>
      targetPath === personalThemePath ? (personalTheme as T) : actual.loadJson<T>(targetPath),
  };
});

import { handleAction } from './index.js';

describe('media-actuator personal theme overlay', () => {
  it('merges a personal overlay theme into the catalog used by apply_theme', async () => {
    const result = await handleAction({
      action: 'pipeline',
      context: {},
      steps: [
        {
          type: 'transform',
          op: 'apply_theme',
          params: {
            theme: 'test-roundtrip-theme',
          },
        },
      ],
    } as any);

    expect(result.status).toBe('succeeded');
    expect(result.context.active_theme_name).toBe('test-roundtrip-theme');
    expect(result.context.active_theme.colors).toEqual(
      expect.objectContaining({
        primary: '#123456',
        accent: '#345678',
      })
    );
  });
});
