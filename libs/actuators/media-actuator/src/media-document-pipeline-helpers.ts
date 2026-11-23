import { pickStructuredSectionFields } from './media-structured-content.js';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineCatalog, nowIso } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { retry } from '@agent/core/async-utils';
import { designDefaultsFromMediaTheme } from '@agent/core/media/native-pptx-engine/design-cascade';
import {
  generateNativeDocx,
  generateNativePdf,
  generateNativePptx,
  generateNativeXlsx,
} from '@agent/shared-media/media-contracts';
import type { PdfDesignProtocol, PdfPage } from '@agent/core/contracts/pdf-protocol';
import type { PptxDesignProtocol, PptxSlide } from '@agent/core/contracts/pptx-protocol';
import type { XlsxDesignProtocol } from '@agent/core/contracts/xlsx-protocol';
import * as path from 'node:path';
import {
  buildMediaGenerationBoundary,
  normalizeInvoiceDocumentBrief,
  type MediaBriefCategory,
  type MediaDocumentCompositionCatalog,
  type MediaGenerationBoundary,
  type MediaTheme,
  type DocumentCompositionPresetResolver,
  type ProtocolKind,
} from './media-document-helpers.js';
import type {
  MediaReportDocxProtocol,
  MediaReportPdfProtocol,
} from './media-report-pipeline-helpers.js';
import type { MediaTrackerXlsxProtocol } from './media-spreadsheet-pipeline-helpers.js';
import type { MediaBrief, MediaOutline } from './media-brief-types.js';
import { assertPptxPackageWrite } from './pptx-package.js';

const DOCUMENT_LAYOUTS_PATH = pathResolver.rootResolve(
  'knowledge/public/design-patterns/media-templates/document-layouts.json'
);
const DOCUMENT_LAYOUTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/document-layouts.schema.json'
);

interface DocumentLayoutCatalog {
  documents: Record<
    string,
    {
      default_template: string;
      templates: Record<string, Record<string, unknown>>;
    }
  >;
}

interface MediaPptxLayoutFit {
  overflows?: unknown[];
  shrinkCount?: number;
}

export interface MediaPptxSlide extends PptxSlide {
  metadata?: {
    layoutFit?: MediaPptxLayoutFit;
  };
}

export interface MediaPptxLayoutSummary {
  status: 'pass' | 'shrunk' | 'overflow';
  measurementModel: 'deterministic-width-table';
  slideCount: number;
  shrinkCount: number;
  overflowCount: number;
  overflowSlides: Array<{ slideIndex: number; slideId?: string; overflows: unknown[] }>;
}

export interface MediaPptxProtocol extends PptxDesignProtocol {
  slides: MediaPptxSlide[];
  metadata: {
    composition: unknown;
    generationBoundary: unknown;
    promptGuide: unknown[];
    sourceDesign: Record<string, unknown> | null;
    designRecommendations: unknown[];
    layoutDiagnostics?: MediaPptxLayoutSummary;
  };
}

export interface MediaInvoicePdfProtocol extends Omit<PdfDesignProtocol, 'metadata'> {
  metadata: {
    title?: string;
    subject?: string;
    author?: string;
    creationDate?: string;
    composition: Record<string, unknown>;
  };
}

const documentLayoutCatalog = defineCatalog<DocumentLayoutCatalog>({
  id: 'document-layouts',
  path: DOCUMENT_LAYOUTS_PATH,
  schema: DOCUMENT_LAYOUTS_SCHEMA_PATH,
});

export interface MediaDocumentPipelineDeps {
  resolveNamedTheme: (rootDir: string, preferredTheme?: string) => MediaTheme | null;
  loadDocumentCompositionCatalog: (rootDir: string) => MediaDocumentCompositionCatalog;
  buildPptxSlideFromPattern: (
    rootDir: string,
    data: Record<string, unknown>,
    idx: number,
    theme: Record<string, unknown>,
    pattern: Record<string, unknown>,
    activeMaster: Record<string, unknown>,
    canvas: Record<string, unknown>
  ) => any;
  buildProposalNarrativeOutline: (rootDir: string, brief: MediaBrief) => any;
  buildReportNarrativeOutline: (
    rootDir: string,
    brief: MediaBrief,
    resolvePreset: DocumentCompositionPresetResolver,
    applyTemplate: (
      template: Record<string, unknown>,
      tokens: Record<string, string>,
      fallback?: string
    ) => string
  ) => any;
  buildSpreadsheetNarrativeOutline: (
    rootDir: string,
    brief: MediaBrief,
    resolvePreset: DocumentCompositionPresetResolver
  ) => any;
  buildDiagramNarrativeOutline: (
    rootDir: string,
    brief: MediaBrief,
    resolvePreset: DocumentCompositionPresetResolver
  ) => any;
  buildReportDocxProtocol: (rootDir: string, brief: MediaBrief) => MediaReportDocxProtocol;
  buildReportPdfProtocol: (rootDir: string, brief: MediaBrief) => MediaReportPdfProtocol;
  buildTrackerSpreadsheetProtocol: (rootDir: string, brief: MediaBrief) => MediaTrackerXlsxProtocol;
  buildDocumentPdfProtocol: (rawBrief: MediaBrief) => MediaInvoicePdfProtocol;
  normalizeXlsxDesignProtocol: (protocol: any) => XlsxDesignProtocol;
  resolveDocumentLayoutTemplate: (
    rootDir: string,
    brief: MediaBrief
  ) => { templateId: string; template: Record<string, unknown> };
  resolveDocumentCompositionPreset: DocumentCompositionPresetResolver;
  applyCompositionTemplate: (
    template: Record<string, unknown>,
    tokens: Record<string, string>,
    fallback?: string
  ) => string;
  buildMediaGenerationBoundary: (outline: MediaOutline) => MediaGenerationBoundary;
  normalizeBriefForCategory: (rootDir: string, input: MediaBrief) => any;
  resolveMediaBriefCategory: (input: MediaBrief) => MediaBriefCategory;
  generateDrawioDocument: (
    graph: Record<string, unknown>,
    options: { title: string; theme: Record<string, unknown>; iconMap: any; iconRoot?: string }
  ) => string;
}

export function assertMediaProtocolLayoutReady(
  protocol: { metadata?: MediaPptxProtocol['metadata'] },
  options: { allowLayoutOverflow?: boolean } = {}
): void {
  const diagnostics = protocol?.metadata?.layoutDiagnostics;
  if (!diagnostics || diagnostics.status !== 'overflow' || options.allowLayoutOverflow === true) {
    return;
  }
  const slides = Array.isArray(diagnostics.overflowSlides)
    ? diagnostics.overflowSlides
        .map(
          (slide: Record<string, unknown>) =>
            `slide ${slide.slideIndex}${slide.slideId ? ` (${slide.slideId})` : ''}`
        )
        .join(', ')
    : 'unknown slide';
  throw new Error(
    `[MEDIA_LAYOUT] PPTX layout overflow detected in ${slides}. ` +
      'Shorten the brief or split the content, or explicitly set allow_layout_overflow=true for review-only output.'
  );
}

export function summarizeMediaPptxLayout(protocol: {
  slides?: MediaPptxSlide[];
}): MediaPptxLayoutSummary {
  const slides = Array.isArray(protocol.slides) ? protocol.slides : [];
  const overflowSlides = slides.flatMap((slide, index) => {
    const overflows = slide.metadata?.layoutFit?.overflows;
    return Array.isArray(overflows) && overflows.length > 0
      ? [{ slideIndex: index + 1, slideId: slide.id, overflows }]
      : [];
  });
  const shrinkCount = slides.reduce(
    (sum, slide) => sum + Number(slide.metadata?.layoutFit?.shrinkCount || 0),
    0
  );
  const overflowCount = overflowSlides.reduce((sum, slide) => sum + slide.overflows.length, 0);
  return {
    status: overflowCount > 0 ? 'overflow' : shrinkCount > 0 ? 'shrunk' : 'pass',
    measurementModel: 'deterministic-width-table',
    slideCount: slides.length,
    shrinkCount,
    overflowCount,
    overflowSlides,
  };
}

export function createMediaDocumentPipelineHelpers(deps: MediaDocumentPipelineDeps) {
  function resolveDocumentCompositionPreset(
    rootDir: string,
    brief: MediaBrief
  ): ReturnType<DocumentCompositionPresetResolver> {
    return deps.resolveDocumentCompositionPreset(rootDir, brief);
  }

  function buildOutlineDrivenPptxProtocol(
    rootDir: string,
    outline: MediaOutline
  ): { protocol: MediaPptxProtocol; theme: Record<string, unknown>; themeName: string } {
    const theme = deps.resolveNamedTheme(rootDir, outline.recommended_theme as string | undefined);
    const themeColors = theme?.colors || theme?.theme?.colors || {};
    const canvas = { w: 10, h: 5.625 };
    const contentData = outline.toc.map((entry: Record<string, unknown>) => ({
      id: entry.section_id || entry.id,
      title: entry.title,
      body: Array.isArray(entry.body) ? entry.body : [entry.objective].filter(Boolean),
      subtitle: entry.objective,
      eyebrow: entry.eyebrow,
      visual: entry.visual || entry.supporting_visual,
      media_kind: entry.media_kind,
      layout_key: entry.layout_key,
      semantic_type: entry.semantic_type,
      speaker_notes: entry.speaker_notes ?? entry.notes,
      ...pickStructuredSectionFields(entry),
      composition: entry.composition,
      columns: entry.columns,
      checklist: entry.checklist,
      cta: entry.cta,
      quote: entry.quote,
      image: entry.image,
      design_system_id: outline.design_system_id,
      branding: outline.branding || {},
    }));
    if (
      !contentData.some((entry: Record<string, unknown>) =>
        ['contents'].includes(String(entry.id || entry.section_id || '').toLowerCase())
      )
    ) {
      const contentsEntry = Array.isArray(outline.toc)
        ? outline.toc.find(
            (entry: Record<string, unknown>) => String(entry.section_id || '') === 'contents'
          )
        : null;
      if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
        const contentsSlide = {
          title: contentsEntry.title || 'Contents',
          body: contentsEntry.body,
          subtitle: contentsEntry.objective || 'Document navigation',
          visual: 'outline navigation',
          media_kind: 'contents',
          layout_key: 'doc-contents',
          // An index, not a summary — see buildDocumentContentsSection.
          semantic_type: 'contents',
          design_system_id: outline.design_system_id,
          branding: outline.branding || {},
          id: 'contents',
        };
        const insertAt =
          contentData.length > 0 && String(contentData[0]?.layout_key || '').includes('cover')
            ? 1
            : 0;
        contentData.splice(insertAt, 0, contentsSlide as never);
      }
    }
    const protocol: MediaPptxProtocol = {
      version: '3.0.0',
      generatedAt: nowIso(),
      metadata: {
        composition: outline,
        generationBoundary:
          outline.generation_boundary || deps.buildMediaGenerationBoundary(outline),
        promptGuide: (outline.prompt_guide as unknown[]) || [],
        sourceDesign: (outline.source_design as Record<string, unknown> | undefined) || null,
        designRecommendations: (outline.design_recommendations as unknown[]) || [],
      },
      canvas,
      theme: {
        dk1: (themeColors.primary || '#000000').replace('#', ''),
        dk2: (themeColors.secondary || themeColors.text || '#44546A').replace('#', ''),
        lt1: (themeColors.background || '#FFFFFF').replace('#', ''),
        lt2: (themeColors.background || '#E7E6E6').replace('#', ''),
        accent1: (themeColors.accent || '#38BDF8').replace('#', ''),
        accent2: (themeColors.secondary || '#334155').replace('#', ''),
      },
      master: { elements: [] },
      // LE-01/LE-02: brief-driven protocols opt into the engine design cascade
      // with tenant/theme-derived defaults, so elements the slide builder
      // leaves unstyled get the same fills as every other render path.
      designDefaults: designDefaultsFromMediaTheme({
        colors: themeColors,
        fonts: theme?.fonts || theme?.theme?.fonts || {},
        typography: theme?.typography || theme?.theme?.typography,
      }),
      slides: contentData.map((data: Record<string, unknown>, idx: number) =>
        deps.buildPptxSlideFromPattern(
          rootDir,
          data,
          idx,
          theme,
          { page_layouts: {} },
          null,
          canvas
        )
      ),
    };
    protocol.metadata.layoutDiagnostics = summarizeMediaPptxLayout(protocol);
    return { protocol, theme, themeName: outline.recommended_theme as string };
  }

  function buildPresentationPptxProtocol(
    rootDir: string,
    brief: MediaBrief
  ): {
    protocol: MediaPptxProtocol;
    outline: MediaOutline;
    theme: Record<string, unknown>;
    themeName: string;
  } {
    const outline = deps.buildProposalNarrativeOutline(rootDir, brief);
    const compiled = buildOutlineDrivenPptxProtocol(rootDir, outline);
    return { ...compiled, outline };
  }

  function buildOutlineFromNormalizedBrief(
    rootDir: string,
    category: 'presentation' | 'document' | 'spreadsheet' | 'diagram',
    brief: MediaBrief
  ): any {
    const outlineBuilders: Record<
      MediaBriefCategory,
      (builderRootDir: string, builderBrief: any) => any
    > = {
      presentation: deps.buildProposalNarrativeOutline,
      document: (builderRootDir: string, builderBrief: any) =>
        deps.buildReportNarrativeOutline(
          builderRootDir,
          builderBrief,
          deps.resolveDocumentCompositionPreset,
          deps.applyCompositionTemplate
        ),
      spreadsheet: (builderRootDir: string, builderBrief: any) =>
        deps.buildSpreadsheetNarrativeOutline(
          builderRootDir,
          builderBrief,
          deps.resolveDocumentCompositionPreset
        ),
      diagram: (builderRootDir: string, builderBrief: any) =>
        deps.buildDiagramNarrativeOutline(
          builderRootDir,
          builderBrief,
          deps.resolveDocumentCompositionPreset
        ),
    };
    return outlineBuilders[category](rootDir, brief);
  }

  function buildCompiledBriefContext(input: {
    rootDir: string;
    ctx: any;
    rawBrief: MediaBrief;
    exportAs?: string;
    briefContextKey?: string;
  }): any {
    const normalizedBrief = deps.normalizeBriefForCategory(input.rootDir, input.rawBrief);
    const compiled = compileBriefToDesignProtocol(input.rootDir, normalizedBrief);
    return {
      ...input.ctx,
      active_theme:
        input.ctx.active_theme ||
        deps.resolveNamedTheme(input.rootDir, compiled.themeName) ||
        input.ctx.active_theme,
      active_theme_name: input.ctx.active_theme_name || compiled.themeName,
      [input.exportAs || compiled.exportKey]: compiled.protocol,
      ...(input.briefContextKey ? { [input.briefContextKey]: normalizedBrief } : {}),
      document_outline: compiled.outline,
    };
  }

  async function renderCompiledProtocol(
    compiled: {
      protocol: any;
      protocolKind: ProtocolKind;
    },
    outPath: string,
    options?: any
  ): Promise<void> {
    assertMediaProtocolLayoutReady(compiled.protocol, {
      allowLayoutOverflow: options?.allow_layout_overflow === true,
    });
    safeMkdir(path.dirname(outPath), { recursive: true });
    const renderers: Record<ProtocolKind, () => Promise<void>> = {
      pptx: async () =>
        retry(
          async () =>
            generateNativePptx(compiled.protocol, outPath, {
              // Brief renders have no source deck: any structural error blocks the write.
              beforeWrite: (buffer) =>
                void assertPptxPackageWrite(buffer, 'pptx brief render', {
                  level: options?.package_check ?? 'error',
                }),
            }),
          { maxRetries: 2 }
        ),
      xlsx: async () =>
        retry(
          async () =>
            generateNativeXlsx(deps.normalizeXlsxDesignProtocol(compiled.protocol), outPath),
          { maxRetries: 2 }
        ),
      docx: async () =>
        retry(async () => generateNativeDocx(compiled.protocol, outPath), { maxRetries: 2 }),
      pdf: async () =>
        retry(async () => generateNativePdf(compiled.protocol, outPath, options), {
          maxRetries: 2,
        }),
    };
    const renderer = renderers[compiled.protocolKind];
    if (!renderer) {
      throw new Error(`Unsupported generated protocol kind: ${compiled.protocolKind}`);
    }
    await renderer();
  }

  async function renderDiagramDocumentBrief(
    rootDir: string,
    brief: MediaBrief,
    outPath: string,
    params: any,
    ctx: any,
    resolve: Function
  ): Promise<void> {
    const iconMap = await import('./media-diagram-helpers.js').then((mod) =>
      mod.resolveDrawioIconMap(rootDir, params, resolve)
    );
    const loadFallbackDrawioTheme = await import('./media-diagram-helpers.js').then(
      (mod) => mod.loadFallbackDrawioTheme
    );
    safeMkdir(path.dirname(outPath), { recursive: true });
    const activeTheme =
      ctx.active_theme || loadFallbackDrawioTheme(rootDir, brief.layout_template_id, () => ({}));
    const document = deps.generateDrawioDocument(brief.payload?.graph as Record<string, unknown>, {
      title: String(brief.payload?.title || brief.title || 'Diagram'),
      theme: activeTheme,
      iconMap,
      iconRoot: params.icon_root
        ? assertSafeRepositoryPath(
            path.resolve(rootDir, String(resolve(params.icon_root) || '').trim()),
            { allowMissingLeaf: true }
          )
        : undefined,
    });
    safeWriteFile(outPath, document);
  }

  function resolveObjectInput(
    ctx: any,
    params: any,
    resolve: Function,
    defaults: {
      paramKey?: string;
      fromKey?: string;
      opName: string;
    }
  ): any {
    const fromKey = resolve(defaults.fromKey || 'last_json');
    const inline = defaults.paramKey ? params[defaults.paramKey] : undefined;
    const value = inline && typeof inline === 'object' ? inline : ctx[fromKey];
    if (!value || typeof value !== 'object') {
      throw new Error(`${defaults.opName} could not find context key: ${fromKey}`);
    }
    return value;
  }

  function resolveDocumentLayoutTemplate(
    rootDir: string,
    brief: MediaBrief
  ): { templateId: string; template: Record<string, unknown> } {
    const catalogPath = assertSafeRepositoryPath(
      path.resolve(
        rootDir,
        'knowledge/public/design-patterns/media-templates/document-layouts.json'
      ),
      { allowMissingLeaf: true }
    );
    let catalog: DocumentLayoutCatalog;
    try {
      catalog = documentLayoutCatalog.load();
    } catch (error) {
      if (String(error).includes('Catalog document-layouts is missing:')) {
        throw new Error(`Document layout catalog not found: ${catalogPath}`);
      }
      throw error;
    }
    const documentType = brief.document_type || 'invoice';
    const documentCatalog = catalog.documents?.[documentType];
    if (!documentCatalog) {
      throw new Error(`Document layout family not found: ${documentType}`);
    }
    const templateId = brief.layout_template_id || documentCatalog.default_template;
    const template = documentCatalog.templates?.[templateId];
    if (!template) {
      throw new Error(`Document layout template not found: ${templateId}`);
    }
    return { templateId, template };
  }

  function formatJpy(value: number): string {
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: 'JPY',
      maximumFractionDigits: 0,
    }).format(Math.round(value));
  }

  function applyRounding(value: number, mode: string): number {
    switch (mode) {
      case 'floor':
        return Math.floor(value);
      case 'ceil':
        return Math.ceil(value);
      default:
        return Math.round(value);
    }
  }

  type Rgb = [number, number, number];
  interface LayoutTextElement {
    type: 'text' | 'heading';
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontSize: number;
    color?: Rgb;
    page: number;
  }
  type LayoutVector = {
    shape:
      | { kind: 'rect'; x: number; y: number; width: number; height: number }
      | { kind: 'line'; x1: number; y1: number; x2: number; y2: number };
    fillColor?: Rgb;
    strokeColor?: Rgb;
    lineWidth?: number;
  };
  const LAYOUT_TEXT_COLOR: Rgb = [0.12, 0.12, 0.12];

  function wrapByUnits(text: string, maxUnits: number): string[] {
    if (!text) return [];
    const out: string[] = [];
    let cur = '';
    for (const ch of String(text)) {
      cur += ch;
      if ([...cur].length >= maxUnits) {
        out.push(cur);
        cur = '';
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * Apply a document-layouts template (`blocks`/`labels`/`colors`) to invoice
   * data: produces positioned text elements and vector shapes for the
   * aesthetic-elements render path. Sections whose template block or label is
   * absent are skipped; the plain `source.body` remains the text fallback.
   */
  function buildInvoiceLayoutArtifacts(args: {
    template: any;
    brief: any;
    items: any[];
    grouped: Map<number, { taxableAmount: number; taxAmount: number }>;
    subtotal: number;
    totalTax: number;
    totalAmount: number;
  }): { elements: LayoutTextElement[]; page: PdfPage } | null {
    const { template, brief, items, grouped, subtotal, totalTax, totalAmount } = args;
    const B = template?.blocks;
    if (!B || typeof B !== 'object') return null;
    const L = template.labels || {};
    const colors = template.colors || {};
    const accent = (colors.accent as Rgb) || LAYOUT_TEXT_COLOR;
    const light = (colors.light as Rgb) || ([0.96, 0.97, 0.98] as Rgb);
    const border = (colors.border as Rgb) || ([0.7, 0.75, 0.8] as Rgb);
    const left = template.page?.left ?? 48;
    const right = template.page?.right ?? (template.page?.width ?? 595) - 48;
    const pageW = template.page?.width ?? 595;
    const pageH = template.page?.height ?? 842;

    const elements: LayoutTextElement[] = [];
    const vectors: LayoutVector[] = [];
    const T = (
      x: number,
      y: number,
      text: string,
      fontSize: number,
      color: Rgb = LAYOUT_TEXT_COLOR,
      type: 'text' | 'heading' = 'text'
    ) =>
      elements.push({
        type,
        x,
        y,
        width: text.length * fontSize * 0.55,
        height: fontSize * 1.3,
        text,
        fontSize,
        color,
        page: 0,
      });

    // ── Header: title, meta, divider ──────────────────────────────
    if (L.title) T(left, 26, L.title, 22, accent, 'heading');
    const meta: Array<[string, unknown]> = [
      [L.invoice_number, brief.invoice_number],
      [L.issue_date, brief.issue_date],
      [L.due_date, brief.due_date],
      [L.subject, brief.subject],
    ];
    meta.forEach(([k, v], i) => {
      if (k && v) T(left + (right - left) * 0.58, 24 + i * 14, `${k}: ${v}`, 9);
    });
    vectors.push({
      shape: { kind: 'line', x1: left, y1: 92, x2: right, y2: 92 },
      strokeColor: accent,
      lineWidth: 1.6,
    });

    // ── Recipient / issuer boxes ──────────────────────────────────
    const box = (blk: any, label: string, name: string, lines: string[]) => {
      if (!blk || !label) return;
      T(blk.x, blk.y - 10, label, 9, accent);
      vectors.push({
        shape: { kind: 'rect', x: blk.x, y: blk.y, width: blk.width, height: blk.height },
        fillColor: light,
        strokeColor: border,
        lineWidth: 0.8,
      });
      if (name) T(blk.x + 8, blk.y + 16, name, blk.name_font_size || 11);
      let ly = blk.y + 16 + (blk.name_line_height || 15);
      let count = 0;
      for (const raw of lines) {
        if (!raw) continue;
        for (const w of wrapByUnits(raw, blk.body_max_units || 40)) {
          if (count >= (blk.body_line_limit ?? 99)) return;
          T(blk.x + 8, ly, w, blk.body_font_size || 9);
          ly += blk.body_line_height || 13;
          count++;
        }
      }
    };
    box(B.recipient, L.section_recipient, brief.recipient?.name, [
      brief.recipient?.department,
      brief.recipient?.contact ? `担当: ${brief.recipient.contact}` : '',
      brief.recipient?.address || '',
    ]);
    box(B.issuer, L.section_issuer, brief.issuer?.name, [
      brief.issuer?.registration_number ? `登録番号: ${brief.issuer.registration_number}` : '',
      brief.issuer?.postal_code ? `郵便番号: ${brief.issuer.postal_code}` : '',
      brief.issuer?.address || '',
      brief.issuer?.contact ? `担当: ${brief.issuer.contact}` : '',
      brief.issuer?.phone ? `電話: ${brief.issuer.phone}` : '',
      brief.issuer?.email ? `メール: ${brief.issuer.email}` : '',
    ]);

    // ── Amount band ───────────────────────────────────────────────
    const a = B.amount;
    if (a) {
      vectors.push({
        shape: { kind: 'rect', x: a.x, y: a.y, width: a.width, height: a.height },
        fillColor: light,
        strokeColor: accent,
        lineWidth: 1.2,
      });
      if (L.amount_due)
        T(
          a.label_x ?? a.x + 8,
          a.label_y ?? a.y + 20,
          L.amount_due,
          a.label_font_size || 12,
          accent
        );
      T(
        a.value_x ?? a.x + a.width - 140,
        a.value_y ?? a.y + 22,
        formatJpy(totalAmount),
        a.value_font_size || 18,
        LAYOUT_TEXT_COLOR,
        'heading'
      );
    }

    // ── Items table ───────────────────────────────────────────────
    const tb = B.table;
    let cursorY = a ? a.y + a.height + 24 : 320;
    if (tb) {
      const cols = [tb.description_x, tb.quantity_x, tb.unit_price_x, tb.tax_rate_x, tb.amount_x];
      const headers = [
        L.table_description,
        L.table_quantity,
        L.table_unit_price,
        L.table_tax_rate,
        L.table_amount,
      ];
      const ty = tb.top ?? cursorY;
      const rowH = tb.row_height || 22;
      vectors.push({
        shape: { kind: 'rect', x: left, y: ty, width: right - left, height: rowH },
        fillColor: accent,
      });
      headers.forEach((h, i) => {
        if (h && cols[i] != null)
          T(cols[i] + 4, ty + rowH * 0.68, h, tb.header_font_size || 10, [1, 1, 1] as Rgb);
      });
      let cy = ty + rowH;
      for (const it of items) {
        const desc = `${it.description || ''}${it.reduced_tax_rate ? ' ※' : ''}`;
        T(
          cols[0] + 4,
          cy + rowH * 0.68,
          wrapByUnits(desc, tb.description_max_units || 28)[0] || '',
          tb.body_font_size || 9
        );
        if (cols[1] != null)
          T(
            cols[1] + 4,
            cy + rowH * 0.68,
            `${it.quantity ?? ''}${it.unit || ''}`,
            tb.body_font_size || 9
          );
        if (cols[2] != null)
          T(
            cols[2] + 4,
            cy + rowH * 0.68,
            formatJpy(Number(it.unit_price_ex_tax || 0)),
            tb.body_font_size || 9
          );
        if (cols[3] != null)
          T(cols[3] + 4, cy + rowH * 0.68, `${it.tax_rate ?? ''}%`, tb.body_font_size || 9);
        if (cols[4] != null)
          T(
            cols[4] + 4,
            cy + rowH * 0.68,
            formatJpy(Number(it.quantity || 0) * Number(it.unit_price_ex_tax || 0)),
            tb.body_font_size || 9
          );
        cy += rowH;
        vectors.push({
          shape: { kind: 'line', x1: left, y1: cy, x2: right, y2: cy },
          strokeColor: border,
          lineWidth: 0.4,
        });
      }
      vectors.push({
        shape: { kind: 'rect', x: left, y: ty, width: right - left, height: cy - ty },
        strokeColor: border,
        lineWidth: 0.8,
      });
      const periods = [...new Set(items.map((i: any) => i.service_period).filter(Boolean))].join(
        '、'
      );
      if (periods) T(left + 4, cy + 14, `※ ${periods}`, 8);
      cursorY = cy + (periods ? 30 : 16);
    }

    // ── Tax summary + totals (left) / payment (right) ────────────
    const ts = B.tax_summary;
    if (ts && L.section_tax_summary) {
      T(ts.x ?? left, cursorY, L.section_tax_summary, 10, accent);
      let sy = cursorY + 16;
      for (const [rate, g] of [...grouped.entries()].sort((x, y) => x[0] - y[0])) {
        T(
          (ts.x ?? left) + 4,
          sy,
          `${rate}%対象: ${formatJpy(g.taxableAmount)} / 税額: ${formatJpy(g.taxAmount)}`,
          9
        );
        sy += 14;
      }
      T((ts.x ?? left) + 4, sy + 4, `小計(税抜): ${formatJpy(subtotal)}`, 9);
      T((ts.x ?? left) + 4, sy + 18, `消費税額計: ${formatJpy(totalTax)}`, 9);
      T(
        (ts.x ?? left) + 4,
        sy + 34,
        `${L.section_totals || '合計'}: ${formatJpy(totalAmount)}`,
        11,
        accent,
        'heading'
      );
    }

    const pay = B.payment;
    const paymentLines = brief.payment
      ? [
          brief.payment.method ? `方法: ${brief.payment.method}` : '',
          `${brief.payment.bank_name || ''} ${brief.payment.branch_name || ''}`.trim(),
          `${brief.payment.account_type || ''} ${brief.payment.account_number || ''}`.trim(),
          brief.payment.account_name ? `口座名義: ${brief.payment.account_name}` : '',
          brief.payment.transfer_fee_policy || '',
        ].filter(Boolean)
      : [];
    if (pay && L.section_payment && paymentLines.length) {
      T(pay.x ?? right - 235, cursorY, L.section_payment, 10, accent);
      paymentLines.forEach((ln, i) => T((pay.x ?? right - 235) + 4, cursorY + 16 + i * 14, ln, 9));
    }

    // ── Notes + compliance ────────────────────────────────────────
    const nb = B.notes;
    const notesArr = Array.isArray(brief.notes)
      ? brief.notes
      : brief.notes
        ? [String(brief.notes)]
        : [];
    let ny = Math.max(
      cursorY + (ts ? (ts.height ?? 82) : 60),
      cursorY + 16 + paymentLines.length * 14 + 16
    );
    if (notesArr.length && L.section_notes) {
      T(left, ny, L.section_notes, 10, accent);
      ny += 16;
      for (const n of notesArr) {
        for (const w of wrapByUnits(n, nb?.body_max_units || 48)) {
          T(left + 4, ny, w, nb?.body_font_size || 9);
          ny += nb?.body_line_height || 14;
        }
      }
      ny += 10;
    }
    const complianceLabel = L.section_compliance || L.invoice_requirements;
    if (complianceLabel) {
      T(left, ny, complianceLabel, 10, accent);
      ny += 16;
      const complianceText =
        '発行者の氏名及び登録番号、取引年月日、取引内容、税率ごとの対価の額、税率、消費税額、書類の交付を受ける事業者の氏名。';
      for (const w of wrapByUnits(complianceText, nb?.body_max_units || 48)) {
        T(left + 4, ny, w, nb?.body_font_size || 9);
        ny += nb?.body_line_height || 14;
      }
    }

    const page: PdfPage = {
      pageNumber: 1,
      width: pageW,
      height: pageH,
      text: '',
      elements: elements.map((el) => ({
        type: el.type,
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        text: el.text,
        fontSize: el.fontSize,
        page: el.page,
        ...(el.color ? { color: el.color as [number, number, number] } : {}),
      })),
      vectors: vectors.map((v) => ({
        shape: v.shape,
        fillColor: v.fillColor,
        strokeColor: v.strokeColor,
        lineWidth: v.lineWidth,
      })),
    };
    return { elements, page };
  }

  function buildDocumentPdfProtocol(rawBrief: MediaBrief): MediaInvoicePdfProtocol {
    const brief = normalizeInvoiceDocumentBrief(rawBrief);
    if (brief.document_type !== 'invoice') {
      throw new Error(
        `Unsupported document_type for document_pdf_from_brief: ${brief.document_type}`
      );
    }
    if (brief.render_target && brief.render_target !== 'pdf') {
      throw new Error(
        `Unsupported render_target for document_pdf_from_brief: ${brief.render_target}`
      );
    }
    if (brief.document_profile !== 'qualified-invoice') {
      throw new Error(`Unsupported invoice document_profile: ${brief.document_profile}`);
    }

    const { template, templateId } = resolveDocumentLayoutTemplate(pathResolver.rootDir(), brief);
    const items = Array.isArray(brief.items) ? brief.items : [];
    if (items.length === 0) {
      throw new Error('document_pdf_from_brief requires at least one invoice item.');
    }

    const grouped = new Map<number, { taxableAmount: number; taxAmount: number }>();
    const roundingMode = typeof brief.tax_rounding === 'string' ? brief.tax_rounding : 'round';
    let subtotal = 0;

    const itemLines = items.map((item: any, index: number) => {
      const quantity = Number(item.quantity || 0);
      const unitPrice = Number(item.unit_price_ex_tax || 0);
      const rate = Number(item.tax_rate || 0);
      const lineSubtotal = quantity * unitPrice;
      subtotal += lineSubtotal;

      const current = grouped.get(rate) || { taxableAmount: 0, taxAmount: 0 };
      current.taxableAmount += lineSubtotal;
      grouped.set(rate, current);

      const annotations = [
        item.unit ? `${quantity}${item.unit}` : `${quantity}`,
        `単価 ${formatJpy(unitPrice)}`,
        `税率 ${rate}%`,
        item.reduced_tax_rate ? '※軽減税率対象' : '',
        item.service_period ? `対象期間: ${item.service_period}` : '',
        item.transaction_note || '',
      ].filter(Boolean);

      return `${index + 1}. ${item.description}\n   ${annotations.join(' / ')}\n   金額(税抜): ${formatJpy(lineSubtotal)}`;
    });

    let totalTax = 0;
    const taxSummaryLines = Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([rate, summary]) => {
        summary.taxAmount = applyRounding(summary.taxableAmount * (rate / 100), roundingMode);
        totalTax += summary.taxAmount;
        return `- ${rate}%対象: ${formatJpy(summary.taxableAmount)} / 税額: ${formatJpy(summary.taxAmount)}`;
      });

    const totalAmount = subtotal + totalTax;
    const issuerLines = [
      brief.issuer?.name,
      brief.issuer?.registration_number ? `登録番号: ${brief.issuer.registration_number}` : '',
      brief.issuer?.postal_code ? `郵便番号: ${brief.issuer.postal_code}` : '',
      brief.issuer?.address || '',
      brief.issuer?.contact ? `担当: ${brief.issuer.contact}` : '',
      brief.issuer?.phone ? `電話: ${brief.issuer.phone}` : '',
      // i18n-exempt: qualified-invoice (適格請求書) is a Japan-specific document format with fixed Japanese field labels
      brief.issuer?.email ? `メール: ${brief.issuer.email}` : '',
    ].filter(Boolean);

    const recipientLines = [
      brief.recipient?.name,
      brief.recipient?.department ? brief.recipient.department : '',
      brief.recipient?.contact ? `担当: ${brief.recipient.contact}` : '',
      brief.recipient?.address || '',
    ].filter(Boolean);

    const body = [
      `請求書`,
      `対象: ${brief.issue_date || ''}`,
      `発行日: ${brief.issue_date || ''}`,
      '',
      '発行者:',
      ...issuerLines,
      '',
      '宛先:',
      ...recipientLines,
      '',
      '明細:',
      ...itemLines,
      '',
      '税率別集計:',
      ...taxSummaryLines,
      '',
      `小計(税抜): ${formatJpy(subtotal)}`,
      `消費税額計: ${formatJpy(totalTax)}`,
      `合計請求額: ${formatJpy(totalAmount)}`,
    ]
      .filter(Boolean)
      .join('\n');

    const layoutArtifacts = buildInvoiceLayoutArtifacts({
      template,
      brief,
      items,
      grouped,
      subtotal,
      totalTax,
      totalAmount,
    });

    return {
      version: '1.0.0',
      generatedAt: nowIso(),
      source: {
        format: 'markdown',
        title: brief.title || 'Invoice',
        body,
      },
      metadata: {
        title: brief.title || 'Invoice',
        subject: brief.document_profile || 'qualified-invoice',
        author: 'Kyberion Media-Actuator',
        creationDate: nowIso(),
        composition: {
          kind: 'document-outline-adf',
          document_profile: brief.document_profile,
          document_type: brief.document_type,
          recommended_layout_template_id: templateId,
          recommended_theme: template?.recommended_theme || 'kyberion-standard',
          generation_boundary: buildMediaGenerationBoundary({
            document_profile: brief.document_profile,
            design_system_id: template?.design_system_id || '',
          }),
        },
      },
      renderOptions: {
        compress: true,
        unicode: true,
        xmpMetadata: true,
        tagged: false,
        linearize: false,
        objectStreams: false,
      },
      ...(layoutArtifacts
        ? {
            content: { text: body, pages: [layoutArtifacts.page] },
            aesthetic: { elements: layoutArtifacts.elements },
          }
        : {}),
    };
  }

  function compileBriefToDesignProtocol(
    rootDir: string,
    rawBrief: MediaBrief
  ): {
    protocol: any;
    outline: MediaOutline;
    theme: Record<string, unknown>;
    themeName: string;
    protocolKind: ProtocolKind;
    exportKey: string;
  } {
    const category = deps.resolveMediaBriefCategory(rawBrief);
    const brief = deps.normalizeBriefForCategory(rootDir, rawBrief);
    const outline = buildOutlineFromNormalizedBrief(rootDir, category, brief);
    const theme = deps.resolveNamedTheme(rootDir, outline.recommended_theme as string | undefined);

    if (category === 'presentation') {
      const compiled = buildPresentationPptxProtocol(rootDir, brief);
      return {
        ...compiled,
        protocolKind: 'pptx',
        exportKey: 'last_pptx_design',
      };
    }

    if (category === 'document') {
      const compilers: Record<
        string,
        () => { protocol: any; protocolKind: ProtocolKind; exportKey: string }
      > = {
        pptx: () => ({
          protocol: buildOutlineDrivenPptxProtocol(rootDir, outline).protocol,
          protocolKind: 'pptx',
          exportKey: 'last_pptx_design',
        }),
        docx: () => ({
          protocol: deps.buildReportDocxProtocol(rootDir, brief),
          protocolKind: 'docx',
          exportKey: 'last_docx_design',
        }),
        pdf: () => ({
          protocol: deps.buildReportPdfProtocol(rootDir, brief),
          protocolKind: 'pdf',
          exportKey: 'last_pdf_design',
        }),
      };
      const compile = compilers[String(brief.render_target || '').trim()];
      if (!compile) {
        throw new Error(
          `Unsupported document render_target: ${String(brief.render_target || 'unknown')}`
        );
      }
      return {
        ...compile(),
        outline,
        theme,
        themeName: outline.recommended_theme,
      };
    }

    if (category === 'spreadsheet') {
      return {
        protocol: deps.normalizeXlsxDesignProtocol(
          brief.payload.protocol || deps.buildTrackerSpreadsheetProtocol(rootDir, brief)
        ),
        outline,
        theme,
        themeName: outline.recommended_theme,
        protocolKind: 'xlsx',
        exportKey: 'last_xlsx_design',
      };
    }

    throw new Error(
      `Unsupported brief for compileBriefToDesignProtocol: ${String(rawBrief?.kind || 'unknown')}`
    );
  }

  return {
    resolveDocumentCompositionPreset,
    buildOutlineDrivenPptxProtocol,
    buildPresentationPptxProtocol,
    buildOutlineFromNormalizedBrief,
    buildCompiledBriefContext,
    renderCompiledProtocol,
    renderDiagramDocumentBrief,
    resolveObjectInput,
    resolveDocumentLayoutTemplate,
    buildDocumentPdfProtocol,
    compileBriefToDesignProtocol,
  };
}
