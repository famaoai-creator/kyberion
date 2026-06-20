import {
  safeReadFile,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
  pathResolver,
  resolveVars,
  withRetry,
} from '@agent/core';
import {
  generateNativeDocx,
  generateNativePdf,
  generateNativePptx,
  generateNativeXlsx,
  type PdfDesignProtocol,
} from '@agent/core/media-contracts';
import * as path from 'node:path';
import {
  buildMediaGenerationBoundary,
  normalizeInvoiceDocumentBrief,
  normalizeBriefForCategory,
  resolveMediaBriefCategory,
  type MediaBriefCategory,
  type ProtocolKind,
} from './media-document-helpers.js';

export interface MediaDocumentPipelineDeps {
  resolveNamedTheme: (rootDir: string, preferredTheme?: string) => any;
  loadDocumentCompositionCatalog: (rootDir: string) => any;
  buildPptxSlideFromPattern: (rootDir: string, data: any, idx: number, theme: any, pattern: any, activeMaster: any, canvas: any) => any;
  buildProposalNarrativeOutline: (rootDir: string, brief: any) => any;
  buildReportNarrativeOutline: (rootDir: string, brief: any, resolvePreset: any, applyTemplate: any) => any;
  buildSpreadsheetNarrativeOutline: (rootDir: string, brief: any, resolvePreset: any) => any;
  buildDiagramNarrativeOutline: (rootDir: string, brief: any, resolvePreset: any) => any;
  buildReportDocxProtocol: (rootDir: string, brief: any) => any;
  buildReportPdfProtocol: (rootDir: string, brief: any) => any;
  buildTrackerSpreadsheetProtocol: (rootDir: string, brief: any) => any;
  buildDocumentPdfProtocol: (rawBrief: any) => any;
  normalizeXlsxDesignProtocol: (protocol: any) => any;
  resolveDocumentLayoutTemplate: (rootDir: string, brief: any) => { templateId: string; template: any };
  resolveDocumentCompositionPreset: (rootDir: string, brief: any) => { profileId: string; preset: any };
  applyCompositionTemplate: (template: any, tokens: Record<string, string>, fallback?: string) => string;
  buildMediaGenerationBoundary: (outline: any) => any;
  normalizeBriefForCategory: (rootDir: string, input: any) => any;
  resolveMediaBriefCategory: (input: any) => MediaBriefCategory;
  generateDrawioDocument: (
    graph: any,
    options: { title: string; theme: any; iconMap: any; iconRoot?: string },
  ) => string;
}

export function createMediaDocumentPipelineHelpers(deps: MediaDocumentPipelineDeps) {
  function resolveDocumentCompositionPreset(rootDir: string, brief: any): { profileId: string; preset: any } {
    return deps.resolveDocumentCompositionPreset(rootDir, brief);
  }

  function buildOutlineDrivenPptxProtocol(rootDir: string, outline: any): { protocol: any; theme: any; themeName: string } {
    const theme = deps.resolveNamedTheme(rootDir, outline.recommended_theme);
    const themeColors = theme?.colors || {};
    const canvas = { w: 10, h: 5.625 };
    const contentData = outline.toc.map((entry: any) => ({
      title: entry.title,
      body: Array.isArray(entry.body) ? entry.body : [entry.objective].filter(Boolean),
      subtitle: entry.objective,
      visual: entry.visual || entry.supporting_visual,
      media_kind: entry.media_kind,
      layout_key: entry.layout_key,
      semantic_type: entry.semantic_type,
      design_system_id: outline.design_system_id,
      branding: outline.branding || {},
    }));
    if (!contentData.some((entry: any) => String(entry.id || '').toLowerCase() === 'contents')) {
      const contentsEntry = Array.isArray(outline.toc)
        ? outline.toc.find((entry: any) => String(entry.section_id || '') === 'contents')
        : null;
      if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
        const contentsSlide = {
          title: contentsEntry.title || 'Contents',
          body: contentsEntry.body,
          subtitle: contentsEntry.objective || 'Document navigation',
          visual: 'outline navigation',
          media_kind: 'contents',
          layout_key: 'doc-contents',
          semantic_type: 'summary',
          design_system_id: outline.design_system_id,
          branding: outline.branding || {},
          id: 'contents',
        };
        const insertAt = contentData.length > 0 && String(contentData[0]?.layout_key || '').includes('cover') ? 1 : 0;
        contentData.splice(insertAt, 0, contentsSlide);
      }
    }
    const protocol = {
      version: '3.0.0',
      generatedAt: new Date().toISOString(),
      metadata: {
        composition: outline,
        generationBoundary: outline.generation_boundary || deps.buildMediaGenerationBoundary(outline),
        promptGuide: outline.prompt_guide || [],
        sourceDesign: outline.source_design || null,
        designRecommendations: outline.design_recommendations || [],
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
      slides: contentData.map((data: any, idx: number) => deps.buildPptxSlideFromPattern(rootDir, data, idx, theme, { page_layouts: {} }, null, canvas)),
    };
    return { protocol, theme, themeName: outline.recommended_theme };
  }

  function buildPresentationPptxProtocol(rootDir: string, brief: any): { protocol: any; outline: any; theme: any; themeName: string } {
    const outline = deps.buildProposalNarrativeOutline(rootDir, brief);
    const compiled = buildOutlineDrivenPptxProtocol(rootDir, outline);
    return { ...compiled, outline };
  }

  function buildOutlineFromNormalizedBrief(rootDir: string, category: 'presentation' | 'document' | 'spreadsheet' | 'diagram', brief: any): any {
    const outlineBuilders: Record<MediaBriefCategory, (builderRootDir: string, builderBrief: any) => any> = {
      presentation: deps.buildProposalNarrativeOutline,
      document: (builderRootDir: string, builderBrief: any) =>
        deps.buildReportNarrativeOutline(builderRootDir, builderBrief, deps.resolveDocumentCompositionPreset, deps.applyCompositionTemplate),
      spreadsheet: (builderRootDir: string, builderBrief: any) =>
        deps.buildSpreadsheetNarrativeOutline(builderRootDir, builderBrief, deps.resolveDocumentCompositionPreset),
      diagram: (builderRootDir: string, builderBrief: any) =>
        deps.buildDiagramNarrativeOutline(builderRootDir, builderBrief, deps.resolveDocumentCompositionPreset),
    };
    return outlineBuilders[category](rootDir, brief);
  }

  function buildCompiledBriefContext(input: {
    rootDir: string;
    ctx: any;
    rawBrief: any;
    exportAs?: string;
    briefContextKey?: string;
  }): any {
    const normalizedBrief = deps.normalizeBriefForCategory(input.rootDir, input.rawBrief);
    const compiled = compileBriefToDesignProtocol(input.rootDir, normalizedBrief);
    return {
      ...input.ctx,
      active_theme: input.ctx.active_theme || deps.resolveNamedTheme(input.rootDir, compiled.themeName) || input.ctx.active_theme,
      active_theme_name: input.ctx.active_theme_name || compiled.themeName,
      [input.exportAs || compiled.exportKey]: compiled.protocol,
      ...(input.briefContextKey ? { [input.briefContextKey]: normalizedBrief } : {}),
      document_outline: compiled.outline,
    };
  }

  async function renderCompiledProtocol(compiled: {
    protocol: any;
    protocolKind: ProtocolKind;
  }, outPath: string, options?: any): Promise<void> {
    safeMkdir(path.dirname(outPath), { recursive: true });
    const renderers: Record<ProtocolKind, () => Promise<void>> = {
      pptx: async () => withRetry(async () => generateNativePptx(compiled.protocol, outPath), { maxRetries: 2 }),
      xlsx: async () => withRetry(async () => generateNativeXlsx(deps.normalizeXlsxDesignProtocol(compiled.protocol), outPath), { maxRetries: 2 }),
      docx: async () => withRetry(async () => generateNativeDocx(compiled.protocol, outPath), { maxRetries: 2 }),
      pdf: async () => withRetry(async () => generateNativePdf(compiled.protocol, outPath, options), { maxRetries: 2 }),
    };
    const renderer = renderers[compiled.protocolKind];
    if (!renderer) {
      throw new Error(`Unsupported generated protocol kind: ${compiled.protocolKind}`);
    }
    await renderer();
  }

  async function renderDiagramDocumentBrief(rootDir: string, brief: any, outPath: string, params: any, ctx: any, resolve: Function): Promise<void> {
    const iconMap = await import('./media-diagram-helpers.js').then((mod) => mod.resolveDrawioIconMap(rootDir, params, resolve));
    const loadFallbackDrawioTheme = await import('./media-diagram-helpers.js').then((mod) => mod.loadFallbackDrawioTheme);
    safeMkdir(path.dirname(outPath), { recursive: true });
    const activeTheme = ctx.active_theme || loadFallbackDrawioTheme(rootDir, brief.layout_template_id, () => ({}));
    const document = deps.generateDrawioDocument(brief.payload.graph, {
      title: brief.payload.title || brief.title || 'Diagram',
      theme: activeTheme,
      iconMap,
      iconRoot: params.icon_root ? path.resolve(rootDir, resolve(params.icon_root)) : undefined,
    });
    safeWriteFile(outPath, document);
  }

  function resolveObjectInput(ctx: any, params: any, resolve: Function, defaults: {
    paramKey?: string;
    fromKey?: string;
    opName: string;
  }): any {
    const fromKey = resolve(defaults.fromKey || 'last_json');
    const inline = defaults.paramKey ? params[defaults.paramKey] : undefined;
    const value = inline && typeof inline === 'object' ? inline : ctx[fromKey];
    if (!value || typeof value !== 'object') {
      throw new Error(`${defaults.opName} could not find context key: ${fromKey}`);
    }
    return value;
  }

  function resolveDocumentLayoutTemplate(rootDir: string, brief: any): { templateId: string; template: any } {
    const catalogPath = path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/document-layouts.json');
    if (!safeExistsSync(catalogPath)) {
      throw new Error(`Document layout catalog not found: ${catalogPath}`);
    }
    const catalog = JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string);
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

  function buildDocumentPdfProtocol(rawBrief: any): any {
    const brief = normalizeInvoiceDocumentBrief(rawBrief);
    if (brief.document_type !== 'invoice') {
      throw new Error(`Unsupported document_type for document_pdf_from_brief: ${brief.document_type}`);
    }
    if (brief.render_target && brief.render_target !== 'pdf') {
      throw new Error(`Unsupported render_target for document_pdf_from_brief: ${brief.render_target}`);
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
    ].filter(Boolean).join('\n');

    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: {
        format: 'markdown',
        title: brief.title || 'Invoice',
        body,
      },
      metadata: {
        title: brief.title || 'Invoice',
        subject: brief.document_profile || 'qualified-invoice',
        author: 'Kyberion Media-Actuator',
        creationDate: new Date().toISOString(),
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
    };
  }

  function compileBriefToDesignProtocol(rootDir: string, rawBrief: any): {
    protocol: any;
    outline: any;
    theme: any;
    themeName: string;
    protocolKind: ProtocolKind;
    exportKey: string;
  } {
    const category = deps.resolveMediaBriefCategory(rawBrief);
    const brief = deps.normalizeBriefForCategory(rootDir, rawBrief);
    const outline = buildOutlineFromNormalizedBrief(rootDir, category, brief);
    const theme = deps.resolveNamedTheme(rootDir, outline.recommended_theme);

    if (category === 'presentation') {
      const compiled = buildPresentationPptxProtocol(rootDir, brief);
      return {
        ...compiled,
        protocolKind: 'pptx',
        exportKey: 'last_pptx_design',
      };
    }

    if (category === 'document') {
      const compilers: Record<string, () => { protocol: any; protocolKind: ProtocolKind; exportKey: string }> = {
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
        throw new Error(`Unsupported document render_target: ${String(brief.render_target || 'unknown')}`);
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
        protocol: deps.normalizeXlsxDesignProtocol(brief.payload.protocol || deps.buildTrackerSpreadsheetProtocol(rootDir, brief)),
        outline,
        theme,
        themeName: outline.recommended_theme,
        protocolKind: 'xlsx',
        exportKey: 'last_xlsx_design',
      };
    }

    throw new Error(`Unsupported brief for compileBriefToDesignProtocol: ${String(rawBrief?.kind || 'unknown')}`);
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
