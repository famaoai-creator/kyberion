import {
  resolveDocumentContentsLabel,
  resolveDocumentContentsSubtitle,
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
  resolveThemeColorRole as resolveThemeColorRolePolicy,
} from '@agent/core';
import {
  buildMediaGenerationBoundary,
  buildReportNarrativeOutline,
  classifyRenderSemantic,
} from './media-document-helpers.js';

export interface MediaReportPipelineDeps {
  resolveNamedTheme: (rootDir: string, preferredTheme?: string) => any;
  resolveDocumentCompositionPreset: (rootDir: string, brief: any) => { profileId: string; preset: any };
  resolveDocumentLayoutTemplate: (rootDir: string, brief: any) => { templateId: string; template: any };
  resolveSemanticComponentRule: (rootDir: string, semanticType: string | undefined, medium: string, component: string) => any;
  themeToDocxStyleHints: (theme: any, locale?: string) => { headingFont: string; bodyFont: string; accent: string };
  themeToPptxPalette: (theme: any) => any;
  normalizeFontFamily: (input: string) => string;
}

function resolveThemeColorRole(palette: any, accentHex: string, role?: string): string {
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

function hexToPdfRgb(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!hex || typeof hex !== 'string') return fallback;
  const normalized = hex.replace('#', '').trim();
  if (normalized.length !== 6) return fallback;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  if ([r, g, b].some((value) => Number.isNaN(value))) return fallback;
  return [r / 255, g / 255, b / 255];
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

export function createMediaReportPipelineHelpers(deps: MediaReportPipelineDeps) {
  function buildReportDocxProtocol(rootDir: string, brief: any): any {
    const outline = buildReportNarrativeOutline(rootDir, brief, deps.resolveDocumentCompositionPreset, (template, tokens, fallback = '') => {
      if (template === undefined || template === null) return fallback;
      return String(template)
        .replace(/\{\{([^}]+)\}\}/g, (_match, key) => String(tokens?.[String(key).trim()] || fallback || ''))
        .trim() || fallback;
    });
    const { preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
    const { template } = deps.resolveDocumentLayoutTemplate(rootDir, {
      document_type: 'report',
      layout_template_id: brief.layout_template_id,
    });
    const activeTheme = deps.resolveNamedTheme(rootDir, preset?.recommended_theme);
    const themeHints = deps.themeToDocxStyleHints(activeTheme, brief.locale);
    const palette = deps.themeToPptxPalette(activeTheme);
    const docxLayout = template?.docx || {};
    const layoutProfileTemplate = docxLayout.layout_profile || {};
    const numberingPolicyTemplate = docxLayout.numbering_policy || {};
    const headingFont = deps.normalizeFontFamily(
      brief.locale?.startsWith('ja')
        ? themeHints.headingFont || template?.fonts?.heading || 'Meiryo'
        : themeHints.headingFont || template?.fonts?.heading || 'Aptos',
    );
    const bodyFont = deps.normalizeFontFamily(
      brief.locale?.startsWith('ja')
        ? themeHints.bodyFont || template?.fonts?.body || 'Meiryo'
        : themeHints.bodyFont || template?.fonts?.body || 'Aptos',
    );
    const appendixHeadingRule = deps.resolveSemanticComponentRule(rootDir, 'appendix', 'docx', 'heading');
    const appendixBodyRule = deps.resolveSemanticComponentRule(rootDir, 'appendix', 'docx', 'body');
    const evidenceCalloutTitleRule = deps.resolveSemanticComponentRule(rootDir, 'evidence', 'docx', 'callout_title');
    const evidenceCalloutBodyRule = deps.resolveSemanticComponentRule(rootDir, 'evidence', 'docx', 'callout_body');
    const tableCaptionRule = deps.resolveSemanticComponentRule(rootDir, 'content', 'docx', 'table_caption');
    const reportSectionTitle = resolveReportSectionTitle();
    const contentsEntry = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => String(entry.section_id) === 'contents')
      : null;
    const bodyBlocks: any[] = [
      {
        type: 'paragraph',
        paragraph: {
          pPr: { pStyle: 'Heading1' },
          content: [{ type: 'run', run: { content: [{ type: 'text', text: brief.payload.title || 'Report' }] } }],
        },
      },
    ];

    if (brief.payload.summary) {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          content: [{ type: 'run', run: { content: [{ type: 'text', text: brief.payload.summary }] } }],
        },
      });
    }

    if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: { pStyle: 'Heading2' },
          content: [{ type: 'run', run: { content: [{ type: 'text', text: contentsEntry.title || resolveDocumentContentsLabel(brief.locale) }] } }],
        },
      });
      contentsEntry.body.forEach((line: string) => {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
            pPr: { numPr: { ilvl: 0, numId: 1 } },
            content: [{ type: 'run', run: { content: [{ type: 'text', text: String(line) }] } }],
          },
        });
      });
    }

    for (const section of brief.payload.sections) {
      const sectionId = String(section.heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const sectionPlan = Array.isArray(outline.toc)
        ? outline.toc.find((entry: any) => entry.section_id === sectionId)
        : null;
      const headingStyle = sectionPlan?.layout_key === 'doc-appendix' ? 'Heading3' : 'Heading2';
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: { pStyle: headingStyle },
          content: [{ type: 'run', run: { content: [{ type: 'text', text: section.heading || reportSectionTitle }] } }],
        },
      });

      if (Array.isArray(section.body)) {
        for (const paragraph of section.body) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: headingStyle === 'Heading3' ? 'AppendixBody' : 'Normal' },
              content: [{ type: 'run', run: { content: [{ type: 'text', text: String(paragraph) }] } }],
            },
          });
        }
      }

      if (Array.isArray(section.bullets)) {
        section.bullets.forEach((bullet: string) => {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { numPr: { ilvl: 0, numId: 1 } },
              content: [{ type: 'run', run: { content: [{ type: 'text', text: String(bullet) }] } }],
            },
          });
        });
      }

      if (Array.isArray(section.callouts)) {
        section.callouts.forEach((callout: any) => {
          const title = [callout.title, callout.tone ? `(${callout.tone})` : ''].filter(Boolean).join(' ');
          if (title) {
            bodyBlocks.push({
              type: 'paragraph',
              paragraph: {
                pPr: { pStyle: 'CalloutTitle' },
                content: [{
                  type: 'run',
                  run: {
                    rPr: { bold: true, color: { val: themeHints.accent || String(template?.colors?.accent || '#2563eb').replace('#', '') } },
                    content: [{ type: 'text', text: title }],
                  },
                }],
              },
            });
          }
          if (callout.body) {
            bodyBlocks.push({
              type: 'paragraph',
              paragraph: {
                pPr: { pStyle: 'CalloutBody' },
                content: [{ type: 'run', run: { content: [{ type: 'text', text: String(callout.body) }] } }],
              },
            });
          }
        });
      }

      if (Array.isArray(section.tables)) {
        section.tables.forEach((table: any) => {
          if (table.title) {
            bodyBlocks.push({
              type: 'paragraph',
              paragraph: {
                pPr: { pStyle: 'TableCaption' },
                content: [{
                  type: 'run',
                  run: {
                    rPr: { bold: true },
                    content: [{ type: 'text', text: String(table.title) }],
                  },
                }],
              },
            });
          }
          const columns = Array.isArray(table.columns) ? table.columns.map((value: any) => String(value)) : [];
          const rows = Array.isArray(table.rows) ? table.rows : [];
          if (columns.length === 0) {
            return;
          }
          const cellWidth = Math.floor(7500 / columns.length);
          bodyBlocks.push({
            type: 'table',
            table: {
              tblPr: {
                tblStyle: 'TableGrid',
                tblW: { w: 5000, type: 'pct' },
                tblBorders: {
                  top: { val: 'single', sz: 4, color: 'CBD5E1' },
                  left: { val: 'single', sz: 4, color: 'CBD5E1' },
                  bottom: { val: 'single', sz: 4, color: 'CBD5E1' },
                  right: { val: 'single', sz: 4, color: 'CBD5E1' },
                  insideH: { val: 'single', sz: 4, color: 'CBD5E1' },
                  insideV: { val: 'single', sz: 4, color: 'CBD5E1' },
                },
              },
              tblGrid: columns.map(() => cellWidth),
              rows: [
                {
                  trPr: { tblHeader: true },
                  cells: columns.map((column: string) => ({
                      tcPr: {
                        tcW: { w: cellWidth, type: 'dxa' },
                        shd: { val: 'clear', fill: palette.dk1 || String(template?.colors?.primary || '#1f2937').replace('#', '') },
                      },
                    content: [{
                      type: 'paragraph',
                      paragraph: {
                        content: [{
                          type: 'run',
                          run: {
                            rPr: { bold: true, color: { val: 'FFFFFF' } },
                            content: [{ type: 'text', text: column }],
                          },
                        }],
                      },
                    }],
                  })),
                },
                ...rows.map((row: any) => {
                  const values = Array.isArray(row)
                    ? row
                    : columns.map((column: string) => row?.[column] ?? '');
                  return {
                    cells: values.map((value: any) => ({
                      tcPr: { tcW: { w: cellWidth, type: 'dxa' } },
                      content: [{
                        type: 'paragraph',
                        paragraph: {
                          content: [{
                            type: 'run',
                            run: { content: [{ type: 'text', text: String(value ?? '') }] },
                          }],
                        },
                      }],
                    })),
                  };
                }),
              ],
            },
          });
        });
      }
    }

    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: {
        format: 'markdown',
        title: brief.payload.title || 'Report',
      body: [
          brief.payload.summary || '',
          '',
          ...(Array.isArray(brief.payload.sections)
            ? brief.payload.sections.flatMap((section: any) => [
                section.heading || reportSectionTitle,
                ...(Array.isArray(section.body) ? section.body.map((paragraph: any) => String(paragraph)) : []),
                ...(Array.isArray(section.bullets) ? section.bullets.map((bullet: string) => `- ${bullet}`) : []),
                '',
              ])
            : []),
        ].join('\n').trim(),
      },
      theme: {
        colors: {
          dk1: palette.dk1 || '111827',
          dk2: palette.dk2 || palette.dk1 || '44546A',
          lt1: palette.lt1 || 'FFFFFF',
          lt2: palette.lt2 || palette.lt1 || 'E7E6E6',
          accent1: palette.accent1 || '2563EB',
          accent2: palette.accent2 || palette.dk2 || '334155',
        },
        majorFont: headingFont,
        minorFont: bodyFont,
      },
      layoutProfile: {
        fonts: {
          bodyJa: deps.normalizeFontFamily(layoutProfileTemplate.fonts?.bodyJa || bodyFont),
          bodyEn: deps.normalizeFontFamily(layoutProfileTemplate.fonts?.bodyEn || bodyFont),
          headingJa: deps.normalizeFontFamily(layoutProfileTemplate.fonts?.headingJa || headingFont),
          headingEn: deps.normalizeFontFamily(layoutProfileTemplate.fonts?.headingEn || headingFont),
        },
        sizes: {
          body: layoutProfileTemplate.sizes?.body || 11,
          heading1: layoutProfileTemplate.sizes?.heading1 || (docxLayout.title_font_size || 32) / 2,
          heading2: layoutProfileTemplate.sizes?.heading2 || (docxLayout.section_font_size || 26) / 2,
          heading3: layoutProfileTemplate.sizes?.heading3,
          heading4: layoutProfileTemplate.sizes?.heading4,
          heading5: layoutProfileTemplate.sizes?.heading5,
          code: layoutProfileTemplate.sizes?.code,
        },
        page: {
          width: layoutProfileTemplate.page?.width || docxLayout.page?.width || 11906,
          height: layoutProfileTemplate.page?.height || docxLayout.page?.height || 16838,
          marginTop: layoutProfileTemplate.page?.marginTop || docxLayout.page?.margin_top || 1440,
          marginRight: layoutProfileTemplate.page?.marginRight || docxLayout.page?.margin_right || 1440,
          marginBottom: layoutProfileTemplate.page?.marginBottom || docxLayout.page?.margin_bottom || 1440,
          marginLeft: layoutProfileTemplate.page?.marginLeft || docxLayout.page?.margin_left || 1440,
          marginHeader: layoutProfileTemplate.page?.marginHeader || docxLayout.page?.header || 720,
          marginFooter: layoutProfileTemplate.page?.marginFooter || docxLayout.page?.footer || 720,
          marginGutter: layoutProfileTemplate.page?.marginGutter,
        },
        indent: layoutProfileTemplate.indent,
        bullet: {
          level0: layoutProfileTemplate.bullet?.level0 || '•',
          level1: layoutProfileTemplate.bullet?.level1,
          level2: layoutProfileTemplate.bullet?.level2,
        },
      },
      numberingPolicy: {
        headings: {
          enabled: numberingPolicyTemplate.headings?.enabled ?? false,
          preserveExisting: numberingPolicyTemplate.headings?.preserveExisting ?? true,
          levelFormats: numberingPolicyTemplate.headings?.levelFormats,
        },
        figures: {
          enabled: numberingPolicyTemplate.figures?.enabled ?? true,
          format: numberingPolicyTemplate.figures?.format || 'chapter',
          prefix: numberingPolicyTemplate.figures?.prefix || 'Figure',
          chapterLevel: numberingPolicyTemplate.figures?.chapterLevel || 1,
          resetOnHeadingLevel: numberingPolicyTemplate.figures?.resetOnHeadingLevel || 1,
        },
        tables: {
          enabled: numberingPolicyTemplate.tables?.enabled ?? true,
          format: numberingPolicyTemplate.tables?.format || 'chapter',
          prefix: numberingPolicyTemplate.tables?.prefix || 'Table',
          chapterLevel: numberingPolicyTemplate.tables?.chapterLevel || 1,
          resetOnHeadingLevel: numberingPolicyTemplate.tables?.resetOnHeadingLevel || 1,
        },
      },
      styles: {
        docDefaults: {
          rPrDefault: { rFonts: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, sz: 22 },
        },
        definitions: [
          { styleId: 'Normal', type: 'paragraph', name: 'Normal', isDefault: true },
          {
            styleId: 'Heading1',
            type: 'paragraph',
            name: 'Heading 1',
            pPr: { spacing: { after: docxLayout.title_spacing_after || 160 } },
            rPr: { bold: true, sz: docxLayout.title_font_size || 32 },
          },
          {
            styleId: 'Heading2',
            type: 'paragraph',
            name: 'Heading 2',
            pPr: {
              spacing: {
                before: docxLayout.section_spacing_before || 120,
                after: docxLayout.section_spacing_after || 80,
              },
            },
            rPr: { bold: true, sz: docxLayout.section_font_size || 26 },
          },
          {
            styleId: 'Heading3',
            type: 'paragraph',
            name: 'Heading 3',
            pPr: {
              spacing: {
                before: appendixHeadingRule.spacing_before || ((docxLayout.section_spacing_before || 120) - 20),
                after: appendixHeadingRule.spacing_after || docxLayout.section_spacing_after || 80,
              },
            },
            rPr: {
              bold: appendixHeadingRule.bold ?? true,
              color: { val: resolveThemeColorRole(palette, themeHints.accent, appendixHeadingRule.color_role) },
              sz: appendixHeadingRule.font_size || Math.max((docxLayout.section_font_size || 26) - 2, 20),
            },
          },
          {
            styleId: 'CalloutTitle',
            type: 'paragraph',
            name: 'Callout Title',
            pPr: {
              spacing: {
                before: evidenceCalloutTitleRule.spacing_before || 80,
                after: evidenceCalloutTitleRule.spacing_after || 40,
              },
            },
            rPr: {
              bold: evidenceCalloutTitleRule.bold ?? true,
              color: { val: resolveThemeColorRole(palette, themeHints.accent, evidenceCalloutTitleRule.color_role) },
              sz: evidenceCalloutTitleRule.font_size || Math.max((docxLayout.section_font_size || 26) - 4, 18),
            },
          },
          {
            styleId: 'CalloutBody',
            type: 'paragraph',
            name: 'Callout Body',
            pPr: {
              spacing: {
                after: evidenceCalloutBodyRule.spacing_after || 80,
              },
            },
            rPr: {
              italics: evidenceCalloutBodyRule.italics ?? true,
              color: { val: resolveThemeColorRole(palette, themeHints.accent, evidenceCalloutBodyRule.color_role) },
              sz: evidenceCalloutBodyRule.font_size || 21,
            },
          },
          {
            styleId: 'TableCaption',
            type: 'paragraph',
            name: 'Table Caption',
            pPr: {
              spacing: {
                before: tableCaptionRule.spacing_before || 60,
                after: tableCaptionRule.spacing_after || 40,
              },
            },
            rPr: {
              bold: tableCaptionRule.bold ?? true,
              color: { val: resolveThemeColorRole(palette, themeHints.accent, tableCaptionRule.color_role) },
              sz: tableCaptionRule.font_size || 20,
            },
          },
          {
            styleId: 'AppendixBody',
            type: 'paragraph',
            name: 'Appendix Body',
            pPr: {
              spacing: {
                after: appendixBodyRule.spacing_after || 60,
              },
            },
            rPr: {
              color: { val: resolveThemeColorRole(palette, themeHints.accent, appendixBodyRule.color_role) },
              sz: appendixBodyRule.font_size || 20,
            },
          },
        ],
      },
      numbering: {
        abstractNums: [{ abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'bullet', lvlText: '•', jc: 'left' }] }],
        nums: [{ numId: 1, abstractNumId: 0 }],
      },
      metadata: {
        composition: outline,
        generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
        recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
        branding: preset?.branding || {},
        sectionSemantics: Array.isArray(outline.toc)
          ? outline.toc.map((entry: any) => ({
              section_id: entry.section_id,
              layout_key: entry.layout_key,
              media_kind: entry.media_kind,
              semantic_type: entry.semantic_type || classifyRenderSemantic(entry.layout_key, entry.media_kind),
            }))
          : [],
      },
      body: bodyBlocks,
      sections: [{
        pgSz: {
          w: docxLayout.page?.width || 11906,
          h: docxLayout.page?.height || 16838,
        },
        pgMar: {
          top: docxLayout.page?.margin_top || 1440,
          right: docxLayout.page?.margin_right || 1440,
          bottom: docxLayout.page?.margin_bottom || 1440,
          left: docxLayout.page?.margin_left || 1440,
          header: docxLayout.page?.header || 720,
          footer: docxLayout.page?.footer || 720,
        },
      }],
      headersFooters: [],
      relationships: [],
    };
  }

  function buildReportPdfProtocol(rootDir: string, brief: any): any {
    const outline = buildReportNarrativeOutline(rootDir, brief, deps.resolveDocumentCompositionPreset, (template, tokens, fallback = '') => {
      if (template === undefined || template === null) return fallback;
      return String(template)
        .replace(/\{\{([^}]+)\}\}/g, (_match, key) => String(tokens?.[String(key).trim()] || fallback || ''))
        .trim() || fallback;
    });
    const { preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
    const { template, templateId } = deps.resolveDocumentLayoutTemplate(rootDir, {
      document_type: 'report',
      layout_template_id: brief.layout_template_id,
    });
    const activeTheme = deps.resolveNamedTheme(rootDir, preset?.recommended_theme);
    const pdfLayout = template?.pdf || {};
    const tableStyle = pdfLayout.table || {};
    const tableWidth = Number(tableStyle.width || 490);
    const headerFill = hexToPdfRgb(tableStyle.header_fill, hexToPdfRgb(activeTheme?.colors?.primary, [0.12, 0.16, 0.22]));
    const gridStroke = hexToPdfRgb(tableStyle.grid_stroke, [0.8, 0.84, 0.89]);
    const outerStroke = hexToPdfRgb(tableStyle.outer_stroke, [0.58, 0.64, 0.72]);
    const zebraFill = hexToPdfRgb(tableStyle.zebra_fill, [0.97, 0.98, 0.99]);
    const showZebra = tableStyle.show_zebra !== false;
    const accentFill = hexToPdfRgb(activeTheme?.colors?.accent, [0.93, 0.96, 1.0]);
    const themePrimary = String(activeTheme?.colors?.primary || template?.colors?.primary || '#1f2937');
    const themeSecondary = String(activeTheme?.colors?.secondary || template?.colors?.secondary || '#4b5563');
    const themeAccent = String(activeTheme?.colors?.accent || template?.colors?.accent || '#2563eb');
    const themeBackground = String(activeTheme?.colors?.background || '#ffffff');
    const reportSectionTitle = resolveReportSectionTitle();
    const vectors: any[] = [];
    const contentsEntry = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => String(entry.section_id) === 'contents')
      : null;
    const bodySections = (() => {
      const sections = Array.isArray(brief.payload.sections) ? brief.payload.sections : [];
      const bodySectionOrder = Array.isArray(template?.body_sections) && template.body_sections.length > 0
        ? template.body_sections.map((value: any) => String(value))
        : ['title', 'summary', 'contents', 'section', 'callout', 'bullet', 'table'];
      const collected: string[] = [];
      const pushValue = (value: unknown) => {
        if (value === undefined || value === null) return;
        const text = String(value).trim();
        if (text) collected.push(text);
      };

      for (const entry of bodySectionOrder) {
        if (entry === 'title') {
          pushValue(brief.payload.title || 'Report');
          continue;
        }
        if (entry === 'summary') {
          pushValue(brief.payload.summary || '');
          continue;
        }
        if (entry === 'contents') {
          if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
            pushValue(contentsEntry.title || resolveDocumentContentsLabel(brief.locale));
            contentsEntry.body.forEach(pushValue);
          }
          continue;
        }
        if (entry === 'section') {
          for (const section of sections) {
            pushValue(section.heading || reportSectionTitle);
            if (Array.isArray(section.body)) section.body.forEach(pushValue);
          }
          continue;
        }
        if (entry === 'callout') {
          for (const section of sections) {
            if (Array.isArray(section.callouts)) {
              for (const callout of section.callouts) {
                pushValue(callout.title ? [callout.title, callout.tone ? `(${callout.tone})` : ''].filter(Boolean).join(' ') : '');
                pushValue(callout.body || '');
              }
            }
          }
          continue;
        }
        if (entry === 'bullet') {
          for (const section of sections) {
            if (Array.isArray(section.bullets)) {
              section.bullets.forEach((item: string) => pushValue(`- ${item}`));
            }
          }
          continue;
        }
        if (entry === 'table') {
          for (const section of sections) {
            if (Array.isArray(section.tables)) {
              for (const table of section.tables) {
                pushValue(table.title || '');
                const columns = Array.isArray(table.columns) ? table.columns : [];
                const rows = Array.isArray(table.rows) ? table.rows : [];
                if (columns.length > 0) {
                  pushValue(columns.join(' | '));
                  rows.forEach((row: any) => {
                    const values = Array.isArray(row) ? row : columns.map((column: string) => row?.[column] ?? '');
                    pushValue(values.map((value: any) => String(value ?? '')).join(' | '));
                  });
                }
              }
            }
          }
        }
      }

      return collected;
    })();

    const elements: any[] = [
      {
        type: 'text',
        x: pdfLayout.title_x || pdfLayout.margin_left || 48,
        y: pdfLayout.title_y || 42,
        text: brief.payload.title || 'Report',
        fontSize: pdfLayout.title_font_size || 22,
      },
    ];

    let cursorY = (pdfLayout.title_y || 42) + 42;
    if (brief.payload.summary) {
      elements.push({
        type: 'text',
        x: pdfLayout.margin_left || 48,
        y: cursorY,
        text: brief.payload.summary,
        fontSize: pdfLayout.summary_font_size || 11,
      });
      cursorY += pdfLayout.summary_gap || 30;
    }

    if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
      elements.push({
        type: 'text',
        x: pdfLayout.margin_left || 48,
        y: cursorY,
        text: contentsEntry.title || resolveDocumentContentsLabel(brief.locale),
        fontSize: pdfLayout.section_font_size || 14,
        color: hexToPdfRgb(themePrimary, [0.12, 0.16, 0.22]),
      });
      cursorY += 22;
      for (const line of contentsEntry.body) {
        elements.push({
          type: 'text',
          x: pdfLayout.content_x || 56,
          y: cursorY,
          text: String(line),
          fontSize: pdfLayout.body_font_size || 10,
        });
        cursorY += pdfLayout.line_height || 16;
      }
      cursorY += pdfLayout.section_gap || 10;
    }

    for (const section of brief.payload.sections) {
      const sectionId = String(section.heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const sectionPlan = Array.isArray(outline.toc)
        ? outline.toc.find((entry: any) => entry.section_id === sectionId)
        : null;
      const semanticType = sectionPlan?.semantic_type || classifyRenderSemantic(sectionPlan?.layout_key, sectionPlan?.media_kind);
      const semanticTokens = deps.resolveSemanticComponentRule(rootDir, semanticType, 'pdf', 'body');
      const pdfTokens = semanticTokens.pdf || {};
      const isAppendix = semanticType === 'appendix';
      const sectionHeaderColor = pdfTokens.header_color === 'secondary'
        ? hexToPdfRgb(themeSecondary, [0.3, 0.34, 0.39])
        : pdfTokens.header_color === 'accent'
          ? hexToPdfRgb(themeAccent, [0.15, 0.39, 0.92])
          : hexToPdfRgb(themePrimary, [0.12, 0.16, 0.22]);
      const sectionBodyX = pdfTokens.body_x === 'margin' ? (pdfLayout.margin_left || 48) : (pdfLayout.content_x || 56);
      const bodyFontSize = (pdfLayout.body_font_size || 10) + Number(pdfTokens.body_font_size_delta || 0);
      const blockFill = pdfTokens.block_fill === 'primary'
        ? headerFill
        : pdfTokens.block_fill === 'accent'
          ? accentFill
          : null;
      elements.push({
        type: 'text',
        x: pdfLayout.margin_left || 48,
        y: cursorY,
        text: section.heading || reportSectionTitle,
        fontSize: isAppendix ? Math.max((pdfLayout.section_font_size || 14) - 2, 11) : (pdfLayout.section_font_size || 14),
        color: sectionHeaderColor,
      });
      cursorY += 22;
      if (blockFill) {
        const blockHeight = Math.max(
          (Array.isArray(section.body) ? section.body.length : 0) * (pdfLayout.line_height || 16) + 18,
          26,
        );
        vectors.push({
          shape: {
            kind: 'rect',
            x: (pdfLayout.margin_left || 48) - 8,
            y: cursorY - 8,
            width: 490,
            height: blockHeight,
          },
          fillColor: blockFill,
          fillOpacity: Number(pdfTokens.block_opacity || 0),
        });
      }
      if (Array.isArray(section.body)) {
        for (const paragraph of section.body) {
          elements.push({
            type: 'text',
            x: sectionBodyX,
            y: cursorY,
            text: String(paragraph),
            fontSize: bodyFontSize,
          });
          cursorY += pdfLayout.line_height || 16;
        }
      }
      if (Array.isArray(section.bullets)) {
        for (const bullet of section.bullets) {
          elements.push({
            type: 'text',
            x: pdfLayout.bullet_x || 64,
            y: cursorY,
            text: `• ${String(bullet)}`,
            fontSize: pdfLayout.body_font_size || 10,
          });
          cursorY += pdfLayout.line_height || 16;
        }
      }
      if (Array.isArray(section.callouts)) {
        for (const callout of section.callouts) {
          const title = [callout.title, callout.tone ? `(${callout.tone})` : ''].filter(Boolean).join(' ');
          const calloutBoxY = cursorY - 4;
          const calloutBoxHeight = callout.body ? (pdfLayout.line_height || 16) * 2 : (pdfLayout.line_height || 16) + 4;
          vectors.push({
            shape: {
              kind: 'rect',
              x: (pdfLayout.callout_x || 64) - 8,
              y: calloutBoxY,
              width: 470,
              height: calloutBoxHeight,
            },
            fillColor: pdfTokens.callout_fill === 'primary' ? headerFill : accentFill,
            fillOpacity: Number(pdfTokens.callout_opacity ?? 0.7),
          });
          if (title) {
            elements.push({
              type: 'text',
              x: pdfLayout.callout_x || 64,
              y: cursorY,
              text: title,
              fontSize: pdfLayout.callout_title_font_size || 11,
            });
            cursorY += pdfLayout.line_height || 16;
          }
          if (callout.body) {
            elements.push({
              type: 'text',
              x: pdfLayout.callout_x || 64,
              y: cursorY,
              text: String(callout.body),
              fontSize: pdfLayout.body_font_size || 10,
            });
            cursorY += pdfLayout.line_height || 16;
          }
          cursorY += pdfLayout.callout_gap || 18;
        }
      }
      if (Array.isArray(section.tables)) {
        for (const table of section.tables) {
          if (table.title) {
            elements.push({
              type: 'text',
              x: pdfLayout.table_x || 56,
              y: cursorY,
              text: String(table.title),
              fontSize: pdfLayout.table_title_font_size || 11,
            });
            cursorY += pdfLayout.line_height || 16;
          }
          const columns = Array.isArray(table.columns) ? table.columns.map((value: any) => String(value)) : [];
          const rows = Array.isArray(table.rows) ? table.rows : [];
          if (columns.length > 0) {
            const tableX = pdfLayout.table_x || 56;
            const columnWidth = tableWidth / columns.length;
            const tableHeaderY = cursorY - 4;
            const rowHeight = pdfLayout.line_height || 16;
            const tableHeight = rowHeight + 4 + (rows.length * rowHeight);
            vectors.push({
              shape: {
                kind: 'rect',
                x: tableX - 4,
                y: tableHeaderY,
                width: tableWidth,
                height: rowHeight + 4,
              },
              fillColor: headerFill,
              fillOpacity: 0.95,
            });
            vectors.push({
              shape: {
                kind: 'rect',
                x: tableX - 4,
                y: tableHeaderY,
                width: tableWidth,
                height: tableHeight,
              },
              strokeColor: outerStroke,
              lineWidth: 0.7,
            });
            columns.forEach((column: string, index: number) => {
              if (index > 0) {
                vectors.push({
                  shape: {
                    kind: 'line',
                    x1: tableX + columnWidth * index - 4,
                    y1: tableHeaderY,
                    x2: tableX + columnWidth * index - 4,
                    y2: tableHeaderY + tableHeight,
                  },
                  strokeColor: gridStroke,
                  lineWidth: 0.4,
                });
              }
              elements.push({
                type: 'text',
                x: tableX + (columnWidth * index) + 4,
                y: cursorY,
                text: column,
                fontSize: pdfLayout.body_font_size || 10,
              });
            });
            cursorY += rowHeight;
            rows.forEach((row: any, rowIndex: number) => {
              const values = Array.isArray(row)
                ? row
                : columns.map((column: string) => row?.[column] ?? '');
              if (showZebra && rowIndex % 2 === 1) {
                vectors.push({
                  shape: {
                    kind: 'rect',
                    x: tableX - 4,
                    y: cursorY - 4,
                    width: tableWidth,
                    height: rowHeight,
                  },
                  fillColor: zebraFill,
                  fillOpacity: 0.6,
                });
              }
              vectors.push({
                shape: {
                  kind: 'line',
                  x1: tableX - 4,
                  y1: cursorY - 2,
                  x2: tableX + tableWidth - 4,
                  y2: cursorY - 2,
                },
                strokeColor: gridStroke,
                lineWidth: 0.5,
              });
              values.forEach((value: any, index: number) => {
                elements.push({
                  type: 'text',
                  x: tableX + (columnWidth * index) + 4,
                  y: cursorY,
                  text: String(value ?? ''),
                  fontSize: pdfLayout.body_font_size || 10,
                });
              });
              cursorY += rowHeight;
            });
            cursorY += pdfLayout.table_gap || 22;
          }
        }
      }
      cursorY += pdfLayout.section_gap || 10;
    }

    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: {
        format: 'markdown',
        title: brief.payload.title || 'Report',
        body: bodySections.join('\n'),
      },
      metadata: {
        title: brief.payload.title || 'Report',
        subject: brief.document_profile || 'summary-report',
        author: 'Kyberion Media-Actuator',
        creationDate: new Date().toISOString(),
        composition: outline,
        generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
        recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
        branding: preset?.branding || {},
        sectionSemantics: Array.isArray(outline.toc)
          ? outline.toc.map((entry: any) => ({
              section_id: entry.section_id,
              layout_key: entry.layout_key,
              media_kind: entry.media_kind,
              semantic_type: entry.semantic_type || classifyRenderSemantic(entry.layout_key, entry.media_kind),
            }))
          : [],
      },
      content: {
        text: bodySections.join('\n'),
        pages: [{ pageNumber: 1, width: 595, height: 842, text: '', vectors }],
      },
      aesthetic: {
        layout: 'single-column',
        elements,
        colors: [themePrimary, themeSecondary, themeAccent],
        fonts: [brief.locale?.startsWith('ja') ? 'HeiseiKakuGo-W5' : 'Helvetica'],
        branding: {
          logoPresence: Boolean(preset?.branding?.logo_url || activeTheme?.assets?.logo_url),
          logoUrl: preset?.branding?.logo_url || activeTheme?.assets?.logo_url || null,
          brandName: preset?.branding?.brand_name || brief.payload?.client || brief.client || null,
          primaryColor: themePrimary,
          secondaryColor: themeSecondary,
          backgroundColor: themeBackground,
          tone: preset?.branding?.tone || 'professional',
        },
        templateId,
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

  return {
    buildReportDocxProtocol,
    buildReportPdfProtocol,
  };
}
