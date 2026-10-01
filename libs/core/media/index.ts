/** Domain barrel — public surface for libs/core/media */
export * from './document-contents-policy.js';
export * from './document-inference-policy.js';
export * from './document-outline-label-policy.js';
export * from './document-reader.js';
export * from './docx-utils.js';
export * from './font-stack.js';
export * from './image-description-bridge.js';
export * from './image-description-types.js';
export * from './image-dhash.js';
export * from './image-generation-bridge.js';
export * from './image-generation-policy.js';
export * from './image-generation-types.js';
export * from './image-reference-consent.js';
export * from './media-aws-icon-rules.js';
export * from './media-backend-registry.js';
export * from './media-brief-lock.js';
export {
  PdfDesignProtocol,
  PdfAesthetic,
  PdfLayoutElement,
  PdfPage,
  DocumentDesignProtocol,
  DocumentProvenance,
  TransformStep,
  DesignDelta,
  SemanticOf,
  XlsxCell,
  XlsxCellStyle,
  XlsxColor,
  XlsxConditionalFormat,
  XlsxDataValidation,
  XlsxDesignProtocol,
  XlsxDxfStyle,
  XlsxMergeCell,
  XlsxWorksheet,
  distillPdfDesign,
  selectPdfOcrImages,
  distillPptxDesign,
  distillXlsxDesign,
  generateNativePdf,
  generateNativePptx,
  patchPptxText,
  patchPptxParagraphs,
  extractPptxSlides,
  filterPptxSlides,
  ExtractedSlide,
  generateNativeXlsx,
  generateNativeDocx,
  protocolToMarkdown,
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  DOCX_IMAGE_MARKER,
} from './media-contracts.js';
export * from './media-drawio-boundary-policy.js';
export * from './media-drawio-edge-policy.js';
export * from './media-drawio-policy.js';
export * from './media-drawio-security-group-order.js';
export * from './media-drawio-sort-policy.js';
export * from './media-drawio-tier-order.js';
export * from './media-semantic-map.js';
export * from './media-signal-entry-policy.js';
export * from './media-style-policy.js';
export * from './media-theme-role-policy.js';
export * from './media-tone-style-map.js';
export * from './music-generation-bridge.js';
export * from './music-generation-policy.js';
export * from './music-generation-types.js';
export * from './music-workflow-compiler.js';
export * from './native-op-mapping.js';
export * from './native-speech-listen-bridge.js';
export * from './native-subagent-adopter.js';
export * from './native-tts.js';
// skipped './pdf-utils.js' (all exports shadowed)
export { generatePptxWithDesign } from './pptx-utils.js';
export { extractTablesFromPage } from './protocol-to-markdown.js';
export * from './xlsx-number-format.js';
// skipped './xlsx-utils.js' (all exports shadowed)
export * from './native-xlsx-engine/content-types.js';
export * from './native-xlsx-engine/drawing.js';
// skipped './native-xlsx-engine/engine.js' (all exports shadowed)
export * from './native-xlsx-engine/rels.js';
export * from './native-xlsx-engine/shared-strings.js';
export * from './native-xlsx-engine/styles.js';
export * from './native-xlsx-engine/table.js';
export * from './native-xlsx-engine/workbook.js';
export * from './native-xlsx-engine/worksheet.js';
export * from './native-pptx-engine/builders.js';
// skipped './native-pptx-engine/content-types.js' (all exports shadowed)
export * from './native-pptx-engine/design-cascade.js';
// skipped './native-pptx-engine/engine.js' (all exports shadowed)
export * from './native-pptx-engine/layout-primitives.js';
export * from './native-pptx-engine/presentation.js';
export {
  generatePresentationRels,
  generateSlideRels,
  generateLayoutRels,
  generateMasterRels,
} from './native-pptx-engine/rels.js';
export * from './native-pptx-engine/text-metrics.js';
export * from './native-pptx-engine/theme.js';
// skipped './native-pdf-engine/engine.js' (all exports shadowed)
export * from './native-pdf-engine/parser.js';
export * from './native-pdf-engine/primitives.js';
// skipped './native-docx-engine/engine.js' (all exports shadowed)
export * from './native-docx-engine/examples/roundtrip_docx.js';
