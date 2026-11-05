export type {
  PdfDesignProtocol,
  PdfAesthetic,
  PdfLayoutElement,
  PdfPage,
} from '@agent/core/contracts/pdf-protocol';
export type {
  DocumentDesignProtocol,
  DocumentProvenance,
  TransformStep,
  DesignDelta,
  SemanticOf,
} from '@agent/core/contracts/document-protocol';
export type {
  XlsxCell,
  XlsxCellStyle,
  XlsxColor,
  XlsxConditionalFormat,
  XlsxDataValidation,
  XlsxDesignProtocol,
  XlsxDxfStyle,
  XlsxMergeCell,
  XlsxWorksheet,
} from '@agent/core/contracts/xlsx-protocol';
export { distillPdfDesign, selectPdfOcrImages } from '@agent/core/media/pdf-utils';
export { distillPptxDesign } from '@agent/core/media/pptx-utils';
export { distillXlsxDesign } from '@agent/core/media/xlsx-utils';
export { distillDocxDesign } from '@agent/core/media/docx-utils';
export { generateNativePdf } from './native-pdf-engine/engine.js';
export {
  generateNativePptx,
  patchPptxText,
  patchPptxParagraphs,
  extractPptxSlides,
  filterPptxSlides,
} from '@agent/core/media/native-pptx-engine/engine';
export type { ExtractedSlide, PptxWriteOptions } from '@agent/core/media/native-pptx-engine/engine';
export { generateNativeXlsx } from './native-xlsx-engine/engine.js';
export { generateNativeDocx } from './native-docx-engine/engine.js';
export {
  protocolToMarkdown,
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  DOCX_IMAGE_MARKER,
} from '@agent/core/media/protocol-to-markdown';
