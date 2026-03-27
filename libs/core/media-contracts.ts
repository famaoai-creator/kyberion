export type { PdfDesignProtocol, PdfAesthetic, PdfLayoutElement, PdfPage } from './src/types/pdf-protocol.js';
export type {
  DocumentDesignProtocol,
  DocumentProvenance,
  TransformStep,
  DesignDelta,
  SemanticOf,
} from './src/types/document-protocol.js';
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
} from './src/types/xlsx-protocol.js';
export { distillPdfDesign } from './src/pdf-utils.js';
export { distillPptxDesign } from './src/pptx-utils.js';
export { distillXlsxDesign } from './src/xlsx-utils.js';
export { distillDocxDesign } from './src/docx-utils.js';
export { generateNativePdf } from './src/native-pdf-engine/engine.js';
export { generateNativePptx, patchPptxText } from './src/native-pptx-engine/engine.js';
export { generateNativeXlsx } from './src/native-xlsx-engine/engine.js';
export { generateNativeDocx } from './src/native-docx-engine/engine.js';
