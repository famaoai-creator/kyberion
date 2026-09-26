import { resolveThemeColorRole as resolveThemeColorRolePolicy } from '@agent/core/media-theme-role-policy';
import type { DocxDesignProtocol } from '@agent/core/types/docx-protocol';
import type { PdfDesignProtocol } from '@agent/core/types/pdf-protocol';
import type { DocumentCompositionPresetResolver, MediaTheme } from './media-document-helpers.js';
import type { MediaPptxPalette } from './media-layout-design-tokens.js';

export interface MediaReportPipelineDeps {
  resolveNamedTheme: (rootDir: string, preferredTheme?: string) => MediaTheme | null;
  resolveDocumentCompositionPreset: DocumentCompositionPresetResolver;
  resolveDocumentLayoutTemplate: (
    rootDir: string,
    brief: any
  ) => { templateId: string; template: any };
  resolveSemanticComponentRule: (
    rootDir: string,
    semanticType: string | undefined,
    medium: string,
    component: string
  ) => any;
  themeToDocxStyleHints: (
    theme: any,
    locale?: string
  ) => { headingFont: string; bodyFont: string; accent: string };
  themeToPptxPalette: (theme: MediaTheme | null) => MediaPptxPalette;
  normalizeFontFamily: (input: string) => string;
}

type MediaPdfAesthetic = NonNullable<PdfDesignProtocol['aesthetic']>;

export interface MediaReportPdfProtocol extends Omit<PdfDesignProtocol, 'metadata' | 'aesthetic'> {
  metadata: {
    title?: string;
    subject?: string;
    author?: string;
    creationDate?: string;
    composition: unknown;
    generationBoundary: unknown;
    recommendedTheme: string;
    branding: Record<string, unknown>;
    sectionSemantics: unknown[];
  };
  aesthetic: MediaPdfAesthetic & {
    branding?: NonNullable<MediaPdfAesthetic['branding']> & Record<string, unknown>;
    templateId?: string;
  };
}

export interface MediaReportDocxProtocol extends DocxDesignProtocol {
  metadata: {
    composition: unknown;
    generationBoundary: unknown;
    recommendedTheme: string;
    branding: Record<string, unknown>;
    sectionSemantics: unknown[];
  };
}

export function resolveThemeColorRole(
  palette: MediaPptxPalette,
  accentHex: string,
  role?: string
): string {
  const resolvedRole = resolveThemeColorRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return accentHex || palette.accent1 || '2563EB';
    case 'primary':
      return palette.dk1 || '111827';
    default:
      return palette.dk2 || palette.dk1 || accentHex || '334155';
  }
}

export function hexToPdfRgb(
  hex: string | undefined,
  fallback: [number, number, number]
): [number, number, number] {
  if (!hex || typeof hex !== 'string') return fallback;
  const normalized = hex.replace('#', '').trim();
  if (normalized.length !== 6) return fallback;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  if ([r, g, b].some((value) => Number.isNaN(value))) return fallback;
  return [r / 255, g / 255, b / 255];
}
