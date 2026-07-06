import { resolveLatinFontFamily } from '@agent/core/design-fonts';
import { safeExistsSync, safeReadFile } from '@agent/core';
import * as path from 'node:path';

export function buildMermaidConfig(theme: any, backgroundColor?: string): Record<string, any> {
  const colors = theme?.colors || {};
  const fonts = theme?.fonts || {};
  const textColor = colors.text || colors.secondary || '#1e293b';
  const primaryColor = colors.accent || '#38bdf8';
  const lineColor = colors.primary || '#0f172a';

  return {
    theme: 'base',
    look: 'classic',
    background: backgroundColor || colors.background || '#ffffff',
    themeVariables: {
      background: backgroundColor || colors.background || '#ffffff',
      primaryColor,
      primaryTextColor: textColor,
      primaryBorderColor: lineColor,
      lineColor,
      secondaryColor: colors.secondary || '#334155',
      tertiaryColor: colors.background || '#ffffff',
      mainBkg: colors.background || '#ffffff',
      textColor,
      fontFamily: fonts.body || fonts.heading || resolveLatinFontFamily(undefined),
    },
  };
}

export function resolveGraphDefinition(
  rootDir: string,
  params: any,
  ctx: any,
  resolve: Function
): any {
  if (params.from && ctx[params.from]) {
    return ctx[params.from];
  }

  const inlineGraph = resolve(params.graph);
  if (inlineGraph && typeof inlineGraph === 'object') {
    return inlineGraph;
  }

  if (params.input_path) {
    const inputPath = path.resolve(rootDir, resolve(params.input_path));
    return JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string);
  }

  throw new Error('drawio_from_graph requires params.from, params.graph, or params.input_path');
}

export function resolveDrawioIconMap(rootDir: string, params: any, resolve: Function): any {
  const mapPath = params.icon_map_path
    ? path.resolve(rootDir, resolve(params.icon_map_path))
    : path.resolve(
        rootDir,
        'knowledge/public/design-patterns/media-templates/aws-drawio-icon-map.json'
      );

  if (!safeExistsSync(mapPath)) {
    return { resources: {} };
  }

  return JSON.parse(safeReadFile(mapPath, { encoding: 'utf8' }) as string);
}

export function loadFallbackDrawioTheme(
  rootDir: string,
  preferredTheme?: string,
  loadThemeCatalog?: (rootDir: string) => any
): any {
  const themes = loadThemeCatalog ? loadThemeCatalog(rootDir) : null;
  if (!themes || typeof themes !== 'object' || !themes.themes) {
    return {
      colors: {
        primary: '#232f3e',
        secondary: '#4b5563',
        accent: '#ff9900',
        background: '#ffffff',
        text: '#111827',
      },
      fonts: {
        heading: resolveLatinFontFamily(undefined),
        body: resolveLatinFontFamily(undefined),
      },
    };
  }
  return (
    themes.themes?.[preferredTheme || ''] ||
    themes.themes?.['aws-architecture'] ||
    themes.themes?.['kyberion-sovereign'] ||
    themes.themes?.['kyberion-standard']
  );
}
