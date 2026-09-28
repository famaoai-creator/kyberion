export type {
  PdfDesignProtocol,
  PdfAesthetic,
  PdfLayoutElement,
  PdfPage,
} from '../contracts/pdf-protocol.js';
export type {
  DocumentDesignProtocol,
  DocumentProvenance,
  TransformStep,
  DesignDelta,
  SemanticOf,
} from '../contracts/document-protocol.js';
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
} from '../contracts/xlsx-protocol.js';
export { distillPdfDesign, selectPdfOcrImages } from './pdf-utils.js';
export { distillPptxDesign } from './pptx-utils.js';
export { distillXlsxDesign } from './xlsx-utils.js';
export { distillDocxDesign } from './docx-utils.js';
export { generateNativePdf } from './native-pdf-engine/engine.js';
export {
  generateNativePptx,
  patchPptxText,
  patchPptxParagraphs,
  extractPptxSlides,
  filterPptxSlides,
} from './native-pptx-engine/engine.js';
export type { ExtractedSlide } from './native-pptx-engine/engine.js';
export { generateNativeXlsx } from './native-xlsx-engine/engine.js';
export { generateNativeDocx } from './native-docx-engine/engine.js';
export {
  protocolToMarkdown,
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  DOCX_IMAGE_MARKER,
} from './protocol-to-markdown.js';
