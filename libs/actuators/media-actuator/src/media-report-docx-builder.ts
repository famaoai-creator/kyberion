import { resolveEastAsianFontFamily } from '@agent/core/design-fonts';
import { resolveDocumentContentsLabel } from '@agent/core/document-contents-policy';
import { resolveReportSectionTitle } from '@agent/core/document-outline-label-policy';
import { nowIso } from '@agent/core/foundation';
import { normalizeStructuredSection } from './media-structured-content.js';
import {
  buildMediaGenerationBoundary,
  buildReportNarrativeOutline,
  classifyRenderSemantic,
} from './media-document-helpers.js';
import {
  resolveThemeColorRole,
  type MediaReportDocxProtocol,
  type MediaReportPipelineDeps,
} from './media-report-shared.js';
import { appendStructuredDocxBlocks } from './media-structured-docx.js';

/** Builds the DOCX design protocol for a summary-report brief. */
export function buildReportDocxProtocol(
  deps: MediaReportPipelineDeps,
  rootDir: string,
  brief: any
): MediaReportDocxProtocol {
  const outline = buildReportNarrativeOutline(
    rootDir,
    brief,
    deps.resolveDocumentCompositionPreset,
    (template, tokens, fallback = '') => {
      if (template === undefined || template === null) return fallback;
      return (
        String(template)
          .replace(/\{\{([^}]+)\}\}/g, (_match, key) =>
            String(tokens?.[String(key).trim()] || fallback || '')
          )
          .trim() || fallback
      );
    }
  );
  const { preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
  const { template } = deps.resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'report',
    layout_template_id: brief.layout_template_id,
  });
  const activeTheme = deps.resolveNamedTheme(rootDir, preset?.recommended_theme);
  const themeHints = deps.themeToDocxStyleHints(activeTheme, brief.locale);
  const palette = deps.themeToPptxPalette(activeTheme);
  const isJa = Boolean(brief.locale?.startsWith('ja'));
  const themeColorMap = ((activeTheme as any)?.colors ??
    (activeTheme as any)?.theme?.colors ??
    {}) as Record<string, unknown>;
  const themeColor = (key: string, fallback: string) =>
    String(themeColorMap[key] || fallback).replace('#', '');
  const accentHex = themeColor('accent', themeHints.accent || '#2563EB');
  const borderHex = themeColor('border', '#D8D8DB');
  const surfaceHex = themeColor('surface', '#F1F1F4');
  const mutedHex = themeColor('muted_text', '#4D4D4D');
  const textHex = themeColor('text', '#1A1A1A');
  const primaryHex = themeColor('primary', accentHex);
  // Design tokens: the same spacing/typography tables the slide layout
  // system reads, projected onto DOCX units — spacing is inches → twips
  // (1in = 1440twip), typography is points → half-points.
  const themeSpacing = ((activeTheme as any)?.spacing ??
    (activeTheme as any)?.theme?.spacing ??
    {}) as Record<string, unknown>;
  const themeTypography = ((activeTheme as any)?.typography ??
    (activeTheme as any)?.theme?.typography ??
    {}) as Record<string, unknown>;
  const spTw = (key: string, fallbackInches: number) =>
    Math.round(Number(themeSpacing[key] ?? fallbackInches) * 1440);
  const halfPt = (key: string, fallbackPt: number) =>
    Math.round(Number(themeTypography[key] ?? fallbackPt) * 2);
  const imageRels: Array<{ id: string; type: string; target: string }> = [];
  let imageSeq = 0;
  const docxLayout = template?.docx || {};
  const layoutProfileTemplate = docxLayout.layout_profile || {};
  const numberingPolicyTemplate = docxLayout.numbering_policy || {};
  const headingFont = deps.normalizeFontFamily(
    brief.locale?.startsWith('ja')
      ? resolveEastAsianFontFamily(themeHints.headingFont || template?.fonts?.heading)
      : themeHints.headingFont || template?.fonts?.heading || 'Aptos'
  );
  const bodyFont = deps.normalizeFontFamily(
    brief.locale?.startsWith('ja')
      ? resolveEastAsianFontFamily(themeHints.bodyFont || template?.fonts?.body)
      : themeHints.bodyFont || template?.fonts?.body || 'Aptos'
  );
  const appendixHeadingRule = deps.resolveSemanticComponentRule(
    rootDir,
    'appendix',
    'docx',
    'heading'
  );
  const appendixBodyRule = deps.resolveSemanticComponentRule(rootDir, 'appendix', 'docx', 'body');
  const evidenceCalloutTitleRule = deps.resolveSemanticComponentRule(
    rootDir,
    'evidence',
    'docx',
    'callout_title'
  );
  const evidenceCalloutBodyRule = deps.resolveSemanticComponentRule(
    rootDir,
    'evidence',
    'docx',
    'callout_body'
  );
  const tableCaptionRule = deps.resolveSemanticComponentRule(
    rootDir,
    'content',
    'docx',
    'table_caption'
  );
  const reportSectionTitle = resolveReportSectionTitle();
  const contentsEntry = Array.isArray(outline.toc)
    ? outline.toc.find((entry: any) => String(entry.section_id) === 'contents')
    : null;
  const titleText = brief.title || brief.payload?.title || 'Report';
  const eyebrowText = String(brief.document_profile || 'summary-report')
    .replace(/-/g, ' ')
    .toUpperCase();
  const bodyBlocks: any[] = [
    {
      type: 'paragraph',
      paragraph: {
        pPr: { spacing: { after: spTw('xxs', 0.04) } },
        content: [
          {
            type: 'run',
            run: {
              rPr: {
                bold: true,
                sz: halfPt('caption', 9),
                color: { val: accentHex },
              },
              content: [{ type: 'text', text: eyebrowText }],
            },
          },
        ],
      },
    },
    {
      type: 'paragraph',
      paragraph: {
        pPr: {
          pStyle: 'Heading1',
          keepNext: true,
          pBdr: { bottom: { val: 'single', sz: 18, space: 6, color: accentHex } },
        },
        content: [
          {
            type: 'run',
            run: { content: [{ type: 'text', text: titleText }] },
          },
        ],
      },
    },
  ];

  const docDate = brief.date || brief.payload?.date;
  if (docDate) {
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: { jc: 'right', spacing: { after: spTw('xs', 0.083) } },
        content: [
          {
            type: 'run',
            run: {
              rPr: { sz: 20, color: { val: mutedHex } },
              content: [{ type: 'text', text: String(docDate) }],
            },
          },
        ],
      },
    });
  }

  const leadText = brief.summary || brief.payload?.summary;
  if (leadText) {
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: { spacing: { before: spTw('xs', 0.083), after: spTw('lg', 0.17) } },
        content: [
          {
            type: 'run',
            run: {
              rPr: { sz: 24, color: { val: mutedHex } },
              content: [{ type: 'text', text: String(leadText) }],
            },
          },
        ],
      },
    });
  }

  if (contentsEntry) {
    const tocEntries = Array.isArray(outline.toc)
      ? outline.toc.filter(
          (entry: any) =>
            !['title', 'summary', 'contents', 'cover'].includes(
              String(entry?.section_id || '').toLowerCase()
            )
        )
      : [];
    const tocSource =
      tocEntries.length > 0
        ? tocEntries.map((entry: any) => String(entry?.title || '').trim())
        : (Array.isArray(brief.payload.sections) ? brief.payload.sections : []).map(
            (section: any) => String(section?.heading || '').trim()
          );
    const tocItems = tocSource.filter(Boolean);
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: { pStyle: 'Heading2', keepNext: true },
        content: [
          {
            type: 'run',
            run: {
              content: [
                {
                  type: 'text',
                  text: contentsEntry.title || resolveDocumentContentsLabel(brief.locale),
                },
              ],
            },
          },
        ],
      },
    });
    tocItems.forEach((item: string, index: number) => {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: { spacing: { after: spTw('xxs', 0.042) }, ind: { left: spTw('lg', 0.17) } },
          content: [
            {
              type: 'run',
              run: { content: [{ type: 'text', text: `${index + 1}. ${item}` }] },
            },
          ],
        },
      });
    });
  }

  for (const section of brief.payload.sections) {
    const sm = normalizeStructuredSection(section);
    const sectionId = String(section.heading || 'section')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const sectionPlan = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === sectionId)
      : null;
    const headingStyle = sectionPlan?.layout_key === 'doc-appendix' ? 'Heading3' : 'Heading2';
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: {
          pStyle: headingStyle,
          // Explicit chapter break — the deck's `divider` becomes a
          // page-break-before on the section heading.
          pageBreakBefore: sm.divider ? true : undefined,
        },
        content: [
          {
            type: 'run',
            run: { content: [{ type: 'text', text: section.heading || reportSectionTitle }] },
          },
        ],
      },
    });

    if (Array.isArray(section.body)) {
      for (const paragraph of section.body) {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
            pPr: { pStyle: headingStyle === 'Heading3' ? 'AppendixBody' : 'Normal' },
            content: [
              { type: 'run', run: { content: [{ type: 'text', text: String(paragraph) }] } },
            ],
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
        const title = String(callout.title || '').trim();
        const toneColor =
          callout.tone === 'success'
            ? themeColor('success', '259D63')
            : callout.tone === 'warning'
              ? themeColor('warning', 'B78F00')
              : callout.tone === 'danger' || callout.tone === 'error'
                ? themeColor('danger', 'EC0000')
                : accentHex;
        if (title) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: 'CalloutTitle' },
              content: [
                {
                  type: 'run',
                  run: {
                    rPr: {
                      bold: true,
                      color: { val: toneColor },
                    },
                    content: [{ type: 'text', text: title }],
                  },
                },
              ],
            },
          });
        }
        if (callout.body) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: 'CalloutBody' },
              content: [
                { type: 'run', run: { content: [{ type: 'text', text: String(callout.body) }] } },
              ],
            },
          });
        }
      });
    }

    const sectionTables = [...sm.tables, ...(sm.table ? [sm.table] : [])];
    if (sectionTables.length > 0) {
      sectionTables.forEach((table: any) => {
        if (table.title) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: 'TableCaption' },
              content: [
                {
                  type: 'run',
                  run: {
                    rPr: { bold: true },
                    content: [{ type: 'text', text: String(table.title) }],
                  },
                },
              ],
            },
          });
        }
        const columns = Array.isArray(table.columns)
          ? table.columns.map((value: any) => String(value))
          : [];
        const rows = Array.isArray(table.rows) ? table.rows : [];
        // rows[][]-only tables (no header) share the slide path's shape —
        // column count comes from the widest row.
        const columnCount =
          columns.length > 0
            ? columns.length
            : Math.max(0, ...rows.map((r: any) => (Array.isArray(r) ? r.length : 1)));
        if (columnCount === 0) {
          return;
        }
        // colWidths (inches, slide-brief shape) → dxa cell widths; equal
        // split otherwise.
        const totalTableTw = 7500;
        const colWidthsTw: number[] =
          Array.isArray(table.colWidths) && table.colWidths.length >= columnCount
            ? table.colWidths.map((w: any) =>
                Math.max(
                  300,
                  Math.round(Number(w) * 1440) || Math.floor(totalTableTw / columnCount)
                )
              )
            : Array.from({ length: columnCount }, () => Math.floor(totalTableTw / columnCount));
        bodyBlocks.push({
          type: 'table',
          table: {
            tblPr: {
              tblStyle: 'TableGrid',
              tblW: { w: 5000, type: 'pct' },
              tblBorders: {
                top: { val: 'single', sz: 4, color: borderHex },
                left: { val: 'single', sz: 4, color: borderHex },
                bottom: { val: 'single', sz: 4, color: borderHex },
                right: { val: 'single', sz: 4, color: borderHex },
                insideH: { val: 'single', sz: 4, color: borderHex },
                insideV: { val: 'single', sz: 4, color: borderHex },
              },
              tblCellMar: {
                top: spTw('xxs', 0.06),
                left: spTw('xs', 0.08),
                bottom: spTw('xxs', 0.06),
                right: spTw('xs', 0.08),
              },
            },
            tblGrid: colWidthsTw,
            rows: [
              ...(columns.length > 0
                ? [
                    {
                      trPr: { tblHeader: true },
                      cells: columns.map((column: string, columnIndex: number) => ({
                        tcPr: {
                          tcW: { w: colWidthsTw[columnIndex] || colWidthsTw[0], type: 'dxa' },
                          shd: {
                            val: 'clear',
                            fill: primaryHex,
                          },
                        },
                        content: [
                          {
                            type: 'paragraph',
                            paragraph: {
                              content: [
                                {
                                  type: 'run',
                                  run: {
                                    rPr: { bold: true, color: { val: 'FFFFFF' } },
                                    content: [{ type: 'text', text: column }],
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      })),
                    },
                  ]
                : []),
              ...rows.map((row: any) => {
                const values = Array.isArray(row)
                  ? row
                  : columns.map((column: string) => row?.[column] ?? '');
                return {
                  trPr: { cantSplit: true },
                  cells: values.map((value: any, valueIndex: number) => ({
                    tcPr: {
                      tcW: { w: colWidthsTw[valueIndex] || colWidthsTw[0], type: 'dxa' },
                    },
                    content: [
                      {
                        type: 'paragraph',
                        paragraph: {
                          content: [
                            {
                              type: 'run',
                              run: { content: [{ type: 'text', text: String(value ?? '') }] },
                            },
                          ],
                        },
                      },
                    ],
                  })),
                };
              }),
            ],
          },
        });
      });
    }

    const structuredCtx = {
      bodyBlocks,
      imageRels,
      rootDir,
      spTw,
      halfPt,
      accentHex,
      primaryHex,
      surfaceHex,
      borderHex,
      mutedHex,
      textHex,
      imageSeq,
    };
    appendStructuredDocxBlocks(sm, structuredCtx);
    imageSeq = structuredCtx.imageSeq;
  }

  return {
    version: '1.0.0',
    generatedAt: nowIso(),
    source: {
      format: 'markdown',
      title: brief.title || brief.payload?.title || 'Report',
      body: [
        brief.payload.summary || '',
        '',
        ...(Array.isArray(brief.payload.sections)
          ? brief.payload.sections.flatMap((section: any) => [
              section.heading || reportSectionTitle,
              ...(Array.isArray(section.body)
                ? section.body.map((paragraph: any) => String(paragraph))
                : []),
              ...(Array.isArray(section.bullets)
                ? section.bullets.map((bullet: string) => `- ${bullet}`)
                : []),
              '',
            ])
          : []),
      ]
        .join('\n')
        .trim(),
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
        marginRight:
          layoutProfileTemplate.page?.marginRight || docxLayout.page?.margin_right || 1440,
        marginBottom:
          layoutProfileTemplate.page?.marginBottom || docxLayout.page?.margin_bottom || 1440,
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
        {
          styleId: 'Normal',
          type: 'paragraph',
          name: 'Normal',
          isDefault: true,
          pPr: {
            jc: isJa ? 'both' : undefined,
            spacing: { after: spTw('xs', 0.083), line: 360, lineRule: 'auto' },
          },
          rPr: { color: { val: textHex } },
        },
        {
          styleId: 'Heading1',
          type: 'paragraph',
          name: 'Heading 1',
          pPr: { spacing: { after: docxLayout.title_spacing_after || 240 } },
          rPr: { bold: true, sz: docxLayout.title_font_size || 44, color: { val: textHex } },
        },
        {
          styleId: 'Heading2',
          type: 'paragraph',
          name: 'Heading 2',
          pPr: {
            keepNext: true,
            spacing: {
              before: docxLayout.section_spacing_before || 240,
              after: docxLayout.section_spacing_after || 80,
            },
            ind: { left: spTw('sm', 0.12) },
            pBdr: {
              left: { val: 'single', sz: 24, space: 6, color: accentHex },
              bottom: { val: 'single', sz: 6, space: 4, color: borderHex },
            },
          },
          rPr: {
            bold: true,
            sz: docxLayout.section_font_size || 32,
            color: { val: textHex },
          },
        },
        {
          styleId: 'Heading3',
          type: 'paragraph',
          name: 'Heading 3',
          pPr: {
            spacing: {
              before:
                appendixHeadingRule.spacing_before ||
                (docxLayout.section_spacing_before || 120) - 20,
              after: appendixHeadingRule.spacing_after || docxLayout.section_spacing_after || 80,
            },
          },
          rPr: {
            bold: appendixHeadingRule.bold ?? true,
            color: {
              val: resolveThemeColorRole(
                palette,
                themeHints.accent,
                appendixHeadingRule.color_role
              ),
            },
            sz:
              appendixHeadingRule.font_size ||
              Math.max((docxLayout.section_font_size || 26) - 2, 20),
          },
        },
        {
          styleId: 'CalloutTitle',
          type: 'paragraph',
          name: 'Callout Title',
          pPr: {
            keepNext: true,
            keepLines: true,
            spacing: {
              before: evidenceCalloutTitleRule.spacing_before || spTw('md', 0.11),
              after: 0,
            },
            ind: { left: spTw('sm', 0.11), right: spTw('sm', 0.11) },
            shd: { val: 'clear', fill: surfaceHex },
            pBdr: {
              top: { val: 'single', sz: 4, space: 6, color: borderHex },
              left: { val: 'single', sz: 24, space: 8, color: accentHex },
              right: { val: 'single', sz: 4, space: 6, color: borderHex },
            },
          },
          rPr: {
            bold: evidenceCalloutTitleRule.bold ?? true,
            color: {
              val: resolveThemeColorRole(
                palette,
                themeHints.accent,
                evidenceCalloutTitleRule.color_role
              ),
            },
            sz:
              evidenceCalloutTitleRule.font_size ||
              Math.max((docxLayout.section_font_size || 32) - 6, 20),
          },
        },
        {
          styleId: 'CalloutBody',
          type: 'paragraph',
          name: 'Callout Body',
          pPr: {
            keepLines: true,
            spacing: {
              after: evidenceCalloutBodyRule.spacing_after || spTw('md', 0.11),
            },
            ind: { left: spTw('sm', 0.11), right: spTw('sm', 0.11) },
            shd: { val: 'clear', fill: surfaceHex },
            pBdr: {
              bottom: { val: 'single', sz: 4, space: 6, color: borderHex },
              left: { val: 'single', sz: 24, space: 8, color: accentHex },
              right: { val: 'single', sz: 4, space: 6, color: borderHex },
            },
          },
          rPr: {
            italic: evidenceCalloutBodyRule.italics ?? false,
            color: { val: mutedHex },
            sz: evidenceCalloutBodyRule.font_size || halfPt('body', 10.5),
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
            color: {
              val: resolveThemeColorRole(palette, themeHints.accent, tableCaptionRule.color_role),
            },
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
            color: {
              val: resolveThemeColorRole(palette, themeHints.accent, appendixBodyRule.color_role),
            },
            sz: appendixBodyRule.font_size || 20,
          },
        },
      ],
    },
    numbering: {
      abstractNums: [
        { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'bullet', lvlText: '•', jc: 'left' }] },
      ],
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
            semantic_type:
              entry.semantic_type || classifyRenderSemantic(entry.layout_key, entry.media_kind),
          }))
        : [],
    },
    body: bodyBlocks,
    sections: [
      {
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
        footerRefs: [{ type: 'default', rId: 'rIdFooterPage' }],
      },
    ],
    headersFooters: [
      {
        type: 'footer',
        rId: 'rIdFooterPage',
        headerType: 'default',
        content: [
          {
            type: 'paragraph',
            paragraph: {
              pPr: { jc: 'center' },
              content: [
                {
                  type: 'run',
                  run: {
                    rPr: { sz: 18, color: { val: mutedHex } },
                    content: [
                      { type: 'fieldChar', fldCharType: 'begin' },
                      { type: 'instrText', text: ' PAGE ' },
                      { type: 'fieldChar', fldCharType: 'end' },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    relationships: [{ id: 'rIdFooterPage', type: 'footer', target: 'footer1.xml' }, ...imageRels],
  };
}
